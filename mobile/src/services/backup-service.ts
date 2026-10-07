import type { SeasonRosterPlayer, SeasonSettings, Team } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { createTeam, listTeams, setActiveTeam } from '@/storage/teams';

const BACKUP_VERSION = 1;

export type RotationBackup = {
  format: 'rotation-engine-backup';
  version: number;
  exported_at: string;
  active_team_name: string | null;
  teams: {
    name: string;
    season_roster: SeasonRosterPlayer[];
    season_settings?: SeasonSettings;
  }[];
};

export async function createBackup(): Promise<RotationBackup> {
  const teams = await listTeams(await getDatabase());
  const activeTeam = teams.find((team) => team.active);
  return {
    format: 'rotation-engine-backup',
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    active_team_name: activeTeam?.name ?? null,
    teams: teams.map((team) => ({
      name: team.name,
      season_roster: team.season_roster ?? [],
      season_settings: team.season_settings,
    })),
  };
}

export function serializeBackup(backup: RotationBackup): string {
  return JSON.stringify(backup, null, 2);
}

function parseBackup(value: string): RotationBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The backup text is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('The backup must be a JSON object.');
  const candidate = parsed as Partial<RotationBackup>;
  if (candidate.format !== 'rotation-engine-backup' || candidate.version !== BACKUP_VERSION || !Array.isArray(candidate.teams)) {
    throw new Error('This is not a compatible Rotation Engine backup.');
  }
  if (candidate.teams.some((team) => !team || typeof team.name !== 'string' || !Array.isArray(team.season_roster))) {
    throw new Error('The backup contains an invalid team or roster.');
  }
  return candidate as RotationBackup;
}

export async function restoreBackup(value: string): Promise<number> {
  const backup = parseBackup(value);
  const database = await getDatabase();
  const restoredTeams: Team[] = [];
  for (const team of backup.teams) {
    restoredTeams.push(await createTeam(database, {
      name: team.name.trim(),
      players: team.season_roster,
      season_settings: team.season_settings,
    }));
  }
  const activeTeam = restoredTeams.find((team) => team.name === backup.active_team_name) ?? restoredTeams[0];
  if (activeTeam) await setActiveTeam(database, activeTeam.id);
  return restoredTeams.length;
}
