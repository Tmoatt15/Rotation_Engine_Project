import { FORMATIONS_BY_FORMAT } from '@/engine/season';
import type { SeasonRosterPlayer, SeasonSettings, Team } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { createTeam, deleteTeam, getTeam, listTeams, renameTeam, replaceRoster, saveSeasonSettings, setActiveTeam } from '@/storage/teams';

export type TeamPayload = { teams: Team[] };
export type RosterPayload = { players: SeasonRosterPlayer[] };

const DEFAULT_SETTINGS: SeasonSettings = {
  game_length_minutes: 70,
  game_format: '11v11',
  total_blocks: 10,
  block_length_minutes: 7,
  formation: '4-4-2',
  total_games: 1,
  substitution_alert: 'flash_and_vibrate',
  substitution_warning_seconds: 30,
};

export async function getTeams(): Promise<TeamPayload> {
  return { teams: await listTeams(await getDatabase()) };
}

export async function getLocalTeam(teamId: string): Promise<Team> {
  const team = await getTeam(await getDatabase(), teamId);
  if (!team) throw new Error('Team was not found.');
  return team;
}

export async function getRoster(teamId: string): Promise<RosterPayload> {
  const team = await getTeam(await getDatabase(), teamId);
  if (!team) throw new Error('Team was not found.');
  return { players: team.season_roster ?? [] };
}

export async function getSeasonSettings(teamId: string): Promise<SeasonSettings & { formation_options: Record<string, string[]> }> {
  const team = await getTeam(await getDatabase(), teamId);
  if (!team) throw new Error('Team was not found.');
  const settings = team.season_settings ?? DEFAULT_SETTINGS;
  return { ...settings, formation_options: FORMATIONS_BY_FORMAT };
}

export async function createLocalTeam(name: string, players: string[]): Promise<Team> {
  const roster = players.map((player) => ({ name: player, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['M'], backup_positions: [], excluded_positions: [] }));
  return createTeam(await getDatabase(), { name, players: roster, season_settings: DEFAULT_SETTINGS });
}

export async function activateTeam(teamId: string): Promise<Team> {
  const database = await getDatabase();
  await setActiveTeam(database, teamId);
  const team = await getTeam(database, teamId);
  if (!team) throw new Error('Team was not found.');
  return team;
}

export async function updateTeam(teamId: string, name: string, players: string[]): Promise<Team> {
  const database = await getDatabase();
  const team = await getTeam(database, teamId);
  if (!team) throw new Error('Team was not found.');
  await renameTeam(database, teamId, name);
  const existing = team.season_roster ?? [];
  const roster = players.map((player) => existing.find((item) => item.name === player) ?? ({ name: player, group: 'rotational', general_positions: ['M'], primary_positions: ['M'], backup_positions: [], excluded_positions: [] } as SeasonRosterPlayer));
  await replaceRoster(database, teamId, roster);
  return (await getTeam(database, teamId)) as Team;
}

export async function updateRoster(teamId: string, players: SeasonRosterPlayer[]): Promise<RosterPayload> {
  const database = await getDatabase();
  await replaceRoster(database, teamId, players);
  return getRoster(teamId);
}

export async function updateSeasonSettings(teamId: string, settings: SeasonSettings): Promise<SeasonSettings & { formation_options: Record<string, string[]> }> {
  await saveSeasonSettings(await getDatabase(), teamId, settings);
  return getSeasonSettings(teamId);
}

export async function removeTeam(teamId: string): Promise<TeamPayload> {
  const database = await getDatabase();
  await deleteTeam(database, teamId);
  return getTeams();
}