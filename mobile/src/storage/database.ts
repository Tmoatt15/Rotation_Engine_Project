import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

const DATABASE_NAME = 'rotation-engine.db';
const CURRENT_SCHEMA_VERSION = 1;

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

async function migrate(database: SQLiteDatabase): Promise<void> {
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = versionRow?.user_version ?? 0;
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database version ${version} is newer than this app supports.`);
  }
  if (version < 1) {
    await database.execAsync(schema);
    await database.execAsync('PRAGMA user_version = 1');
  }
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