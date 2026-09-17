import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

const DATABASE_NAME = 'rotation-engine.db';
export const CURRENT_SCHEMA_VERSION = 1;

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