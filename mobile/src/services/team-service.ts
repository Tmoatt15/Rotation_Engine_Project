import { GAME_FORMATS, FORMATIONS_BY_FORMAT } from '@/engine/season';
import type { SeasonRosterPlayer, SeasonSettings, Team } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { createTeam, deleteTeam, getTeam, listTeams, renameTeam, replaceRoster, saveSeasonSettings, setActiveTeam } from '@/storage/teams';

export type TeamPayload = { teams: Team[] };
export type RosterPayload = { players: SeasonRosterPlayer[] };
export type ActiveTeam = { id: string; name: string };
const teamChangeListeners = new Set<() => void>();

export function subscribeToTeamChanges(listener: () => void): () => void {
  teamChangeListeners.add(listener);
  return () => teamChangeListeners.delete(listener);
}

export function notifyTeamChanged(): void {
  teamChangeListeners.forEach((listener) => listener());
}

const DEFAULT_SETTINGS: SeasonSettings = {
  game_length_minutes: 50,
  game_format: '11v11',
  total_blocks: 10,
  block_length_minutes: 5,
  formation: '4-4-2',
  total_games: 1,
  substitution_alert: 'flash_and_vibrate',
  substitution_warning_seconds: 30,
};

export async function getActiveTeam(): Promise<ActiveTeam> {
  const team = (await listTeams(await getDatabase())).find((item) => item.active);
  if (!team?.id) throw new Error('Select an active team first.');
  return { id: team.id, name: team.name };
}

export async function getActiveTeamId(): Promise<string> {
  return (await getActiveTeam()).id;
}

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

export async function createLocalTeam(name: string, players: string[], seasonSettings: Partial<SeasonSettings> = {}): Promise<Team> {
  const roster = players.map((player) => ({ name: player, group: 'rotational' as const, general_positions: ['ANY'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] }));
  const gameFormat = seasonSettings.game_format ?? DEFAULT_SETTINGS.game_format;
  return createTeam(await getDatabase(), {
    name,
    players: roster,
    season_settings: {
      ...DEFAULT_SETTINGS,
      ...seasonSettings,
      game_format: gameFormat,
      players_on_field: GAME_FORMATS[gameFormat].players_on_field,
      has_goalkeeper: GAME_FORMATS[gameFormat].has_goalkeeper,
    },
  });
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
  const roster = players.map((player) => existing.find((item) => item.name === player) ?? ({ name: player, group: 'rotational', general_positions: ['ANY'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] } as SeasonRosterPlayer));
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