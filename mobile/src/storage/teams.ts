import type { SQLiteDatabase } from 'expo-sqlite';

import type { SeasonRosterPlayer, SeasonSettings, Team } from '@/engine/models';

type TeamRow = {
  id: string;
  name: string;
  active: number;
  created_at: string;
  updated_at: string;
};

type PlayerRow = {
  id: string;
  team_id: string;
  name: string;
  number: number | null;
  group_name: SeasonRosterPlayer['group'];
  general_positions_json: string;
  primary_positions_json: string;
  backup_positions_json: string;
  excluded_positions_json: string;
  keeper_eligible: number;
};

type SettingsRow = { settings_json: string };

export interface CreateTeamInput {
  id?: string;
  name: string;
  players?: SeasonRosterPlayer[];
  season_settings?: SeasonSettings;
}

function now(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToRosterPlayer(row: PlayerRow): SeasonRosterPlayer {
  const cleanPositions = (positions: string[]): string[] => positions.filter((position) => position.toUpperCase() !== 'GK');
  const generalPositions = cleanPositions(parseJson(row.general_positions_json, []));
  const primaryPositions = cleanPositions(parseJson(row.primary_positions_json, []));
  const backupPositions = cleanPositions(parseJson(row.backup_positions_json, []));
  return {
    name: row.name,
    ...(row.number === null ? {} : { number: row.number }),
    keeper_eligible: row.keeper_eligible === 1,
    group: row.group_name,
    general_positions: generalPositions,
    primary_positions: primaryPositions,
    backup_positions: backupPositions,
    excluded_positions: parseJson(row.excluded_positions_json, []),
  };
}

async function rosterForTeam(database: SQLiteDatabase, teamId: string): Promise<SeasonRosterPlayer[]> {
  const rows = await database.getAllAsync<PlayerRow>(
    `SELECT players.name, season_roster.number, season_roster.group_name,
      season_roster.general_positions_json, season_roster.primary_positions_json,
      season_roster.backup_positions_json, season_roster.excluded_positions_json,
      season_roster.keeper_eligible
     FROM players
     INNER JOIN season_roster ON season_roster.player_id = players.id
     WHERE players.team_id = ? ORDER BY players.name COLLATE NOCASE`,
    teamId,
  );
  return rows.map(rowToRosterPlayer);
}

async function settingsForTeam(database: SQLiteDatabase, teamId: string): Promise<SeasonSettings | undefined> {
  const row = await database.getFirstAsync<SettingsRow>(
    'SELECT settings_json FROM season_settings WHERE team_id = ?',
    teamId,
  );
  return row ? parseJson<SeasonSettings | undefined>(row.settings_json, undefined) : undefined;
}

async function teamFromRow(database: SQLiteDatabase, row: TeamRow): Promise<Team> {
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    players: (await rosterForTeam(database, row.id)).map((player) => player.name),
    season_roster: await rosterForTeam(database, row.id),
    season_settings: await settingsForTeam(database, row.id),
  };
}

export async function listTeams(database: SQLiteDatabase): Promise<Team[]> {
  const rows = await database.getAllAsync<TeamRow>('SELECT * FROM teams ORDER BY name COLLATE NOCASE');
  return Promise.all(rows.map((row) => teamFromRow(database, row)));
}

export async function getTeam(database: SQLiteDatabase, teamId: string): Promise<Team | null> {
  const row = await database.getFirstAsync<TeamRow>('SELECT * FROM teams WHERE id = ?', teamId);
  return row ? teamFromRow(database, row) : null;
}

export async function getActiveTeam(database: SQLiteDatabase): Promise<Team | null> {
  const row = await database.getFirstAsync<TeamRow>('SELECT * FROM teams WHERE active = 1 LIMIT 1');
  return row ? teamFromRow(database, row) : null;
}

export async function createTeam(database: SQLiteDatabase, input: CreateTeamInput): Promise<Team> {
  const name = input.name.trim();
  if (!name) throw new Error('Team name is required.');
  const teamId = input.id ?? createId('team');
  const timestamp = now();
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'INSERT INTO teams (id, name, active, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
      teamId, name, timestamp, timestamp,
    );
    await replaceRoster(database, teamId, input.players ?? []);
    if (input.season_settings) await saveSeasonSettings(database, teamId, input.season_settings);
  });
  const team = await getTeam(database, teamId);
  if (!team) throw new Error('Team was not created.');
  return team;
}

export async function renameTeam(database: SQLiteDatabase, teamId: string, name: string): Promise<Team> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Team name is required.');
  await database.runAsync('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?', trimmedName, now(), teamId);
  const team = await getTeam(database, teamId);
  if (!team) throw new Error('Team was not found.');
  return team;
}

export async function setActiveTeam(database: SQLiteDatabase, teamId: string): Promise<void> {
  const team = await database.getFirstAsync<{ id: string }>('SELECT id FROM teams WHERE id = ?', teamId);
  if (!team) throw new Error('Team was not found.');
  await database.withTransactionAsync(async () => {
    await database.runAsync('UPDATE teams SET active = 0, updated_at = ?', now());
    await database.runAsync('UPDATE teams SET active = 1, updated_at = ? WHERE id = ?', now(), teamId);
  });
}

export async function deleteTeam(database: SQLiteDatabase, teamId: string): Promise<void> {
  await database.runAsync('DELETE FROM teams WHERE id = ?', teamId);
}

export async function replaceRoster(
  database: SQLiteDatabase,
  teamId: string,
  players: SeasonRosterPlayer[],
): Promise<void> {
  await database.runAsync('DELETE FROM players WHERE team_id = ?', teamId);
  for (const [index, player] of players.entries()) {
    const playerId = `${teamId}-player-${index + 1}`;
    const cleanPositions = (positions: string[] | undefined): string[] => (positions ?? []).filter((position) => position.toUpperCase() !== 'GK');
    const generalPositions = cleanPositions(player.general_positions);
    const primaryPositions = cleanPositions(player.primary_positions);
    const backupPositions = cleanPositions(player.backup_positions);
    const keeperEligible = player.keeper_eligible === true
      || (player.general_positions ?? []).some((position) => position.toUpperCase() === 'GK')
      || (player.primary_positions ?? []).some((position) => position.toUpperCase() === 'GK')
      || (player.backup_positions ?? []).some((position) => position.toUpperCase() === 'GK');
    await database.runAsync(
      'INSERT INTO players (id, team_id, name) VALUES (?, ?, ?)',
      playerId, teamId, player.name.trim(),
    );
    await database.runAsync(
      `INSERT INTO season_roster
        (player_id, number, keeper_eligible, group_name, general_positions_json, primary_positions_json,
         backup_positions_json, excluded_positions_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      playerId,
      player.number ?? null,
      keeperEligible ? 1 : 0,
      player.group,
      JSON.stringify(generalPositions),
      JSON.stringify(primaryPositions),
      JSON.stringify(backupPositions),
      JSON.stringify(player.excluded_positions ?? []),
    );
  }
  await database.runAsync('UPDATE teams SET updated_at = ? WHERE id = ?', now(), teamId);
}

export async function saveSeasonSettings(
  database: SQLiteDatabase,
  teamId: string,
  settings: SeasonSettings,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO season_settings (team_id, settings_json) VALUES (?, ?)
     ON CONFLICT(team_id) DO UPDATE SET settings_json = excluded.settings_json`,
    teamId,
    JSON.stringify(settings),
  );
  await database.runAsync('UPDATE teams SET updated_at = ? WHERE id = ?', now(), teamId);
}