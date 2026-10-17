import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { migrateExactPositions, migrateGeneralPositions } from './position-migration';

const DATABASE_NAME = 'rotation-engine.db';
export const CURRENT_SCHEMA_VERSION = 5;

let databasePromise: Promise<SQLiteDatabase> | null = null;

const schema = `
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(team_id, name)
  );

  CREATE TABLE IF NOT EXISTS season_roster (
    player_id TEXT PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    group_name TEXT NOT NULL,
    general_positions_json TEXT NOT NULL,
    primary_positions_json TEXT NOT NULL,
    backup_positions_json TEXT NOT NULL,
    excluded_positions_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS season_settings (
    team_id TEXT PRIMARY KEY NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    game_number INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    schedule_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS game_reports (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT,
    game_number INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    report_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);
  CREATE INDEX IF NOT EXISTS idx_saved_schedules_team_id ON saved_schedules(team_id);
  CREATE INDEX IF NOT EXISTS idx_game_reports_team_id ON game_reports(team_id);
`;

type Migration = {
  version: number;
  apply: (database: SQLiteDatabase) => Promise<void>;
};

const migrations: Migration[] = [
  {
    version: 1,
    apply: async (database) => {
      await database.execAsync(schema);
    },
  },
  {
    version: 2,
    apply: async (database) => {
      await database.execAsync('ALTER TABLE season_roster ADD COLUMN number INTEGER');
    },
  },
  {
    version: 3,
    apply: async (database) => {
      await database.execAsync('ALTER TABLE season_roster ADD COLUMN keeper_eligible INTEGER NOT NULL DEFAULT 0');
      await database.execAsync(`UPDATE season_roster
        SET keeper_eligible = 1
        WHERE general_positions_json LIKE '%"GK"%'
           OR primary_positions_json LIKE '%"GK"%'
           OR backup_positions_json LIKE '%"GK"%'`);
    },
  },
  {
    version: 4,
    apply: async (database) => {
      await database.execAsync(`CREATE TABLE waterfill_rotation_history (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        game_number INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (team_id, game_number)
      )`);
    },
  },
  {
    version: 5,
    apply: async (database) => {
      const rows = await database.getAllAsync<{
        player_id: string;
        general_positions_json: string;
        primary_positions_json: string;
        backup_positions_json: string;
        excluded_positions_json: string;
      }>(`SELECT player_id, general_positions_json, primary_positions_json,
        backup_positions_json, excluded_positions_json FROM season_roster`);
      const parsePositions = (value: string, playerId: string, field: string): string[] => {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || !parsed.every((position): position is string => typeof position === 'string')) {
          throw new Error(`Invalid ${field} for roster player ${playerId}.`);
        }
        return parsed;
      };
      for (const row of rows) {
        const generalPositions = migrateGeneralPositions(parsePositions(row.general_positions_json, row.player_id, 'general positions'));
        const primaryPositions = migrateExactPositions(parsePositions(row.primary_positions_json, row.player_id, 'primary positions'));
        const backupPositions = migrateExactPositions(parsePositions(row.backup_positions_json, row.player_id, 'backup positions'));
        const excludedPositions = migrateExactPositions(parsePositions(row.excluded_positions_json, row.player_id, 'excluded positions'));
        if (JSON.stringify(generalPositions) === row.general_positions_json
          && JSON.stringify(primaryPositions) === row.primary_positions_json
          && JSON.stringify(backupPositions) === row.backup_positions_json
          && JSON.stringify(excludedPositions) === row.excluded_positions_json) continue;
        await database.runAsync(
          `UPDATE season_roster
           SET general_positions_json = ?, primary_positions_json = ?, backup_positions_json = ?, excluded_positions_json = ?
           WHERE player_id = ?`,
          JSON.stringify(generalPositions),
          JSON.stringify(primaryPositions),
          JSON.stringify(backupPositions),
          JSON.stringify(excludedPositions),
          row.player_id,
        );
      }
    },
  },
];

async function migrate(database: SQLiteDatabase): Promise<void> {
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database version ${currentVersion} is newer than this app supports.`);
  }

  for (const migration of migrations.filter(({ version }) => version > currentVersion)) {
    await database.withTransactionAsync(async () => {
      await migration.apply(database);
      await database.execAsync(`PRAGMA user_version = ${migration.version}`);
    });
  }
}

export async function initializeDatabase(): Promise<SQLiteDatabase> {
  return getDatabase();
}

export async function getDatabase(): Promise<SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = openDatabaseAsync(DATABASE_NAME).then(async (database) => {
      await database.execAsync('PRAGMA foreign_keys = ON');
      await migrate(database);
      return database;
    });
  }
  return databasePromise;
}

export async function closeDatabase(): Promise<void> {
  const database = await databasePromise;
  databasePromise = null;
  await database?.closeAsync();
}