import { formationSlots, parseFormation } from '@/engine/timeline';
import { generateSchedule } from '@/engine/rotation';
import { createPlayer } from '@/engine/rotation';
import { SeasonSetup } from '@/engine/season';
import type { LiveSchedule, SavedSchedule, SeasonRosterPlayer } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { deleteSchedule, listSchedules, renameSchedule, saveSchedule } from '@/storage/schedules';
import { getActiveTeamId } from '@/team-api';
import { getLocalTeam, getRoster, getSeasonSettings } from './team-service';

function positionRows(formation: string) {
  const slots = formationSlots(parseFormation(formation));
  return [
    { label: 'FORWARDS', positions: slots.F },
    { label: 'MIDFIELDERS', positions: slots.M },
    { label: 'DEFENDERS', positions: slots.D },
    { label: 'GOALKEEPER', positions: ['GK'] },
  ].filter((row) => row.positions.length);
}

function rosterInput(player: SeasonRosterPlayer): SeasonRosterPlayer {
  return { ...player, general_positions: player.general_positions ?? [], primary_positions: player.primary_positions ?? [], backup_positions: player.backup_positions ?? [], excluded_positions: player.excluded_positions ?? [] };
}

export async function generateLocalSchedule(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null }): Promise<LiveSchedule & { warnings: string[]; errors: string[]; available_player_names: string[] }> {
  const settings = await getSeasonSettings(input.teamId);
  const team = await getLocalTeam(input.teamId);
  const roster = (await getRoster(input.teamId)).players.map(rosterInput).filter((player) => input.availablePlayerNames.includes(player.name));
  const setup = new SeasonSetup({ ...settings, block_length_minutes: undefined });
  const result = generateSchedule({ total_blocks: setup.total_blocks, formation: setup.formation, first_half_gk: input.firstHalfGk, second_half_gk: input.secondHalfGk, season_total_games: setup.total_games, season_game_number: input.gameNumber, season_seed: 2026, allow_emergency_positions: false }, roster.map(createPlayer));
  const blockLengths = setup.block_lengths_minutes;
  const blockStarts = blockLengths.reduce<number[]>((starts, length) => [...starts, (starts[starts.length - 1] ?? 0) + (starts.length ? length : 0)], []);
  return { team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, available_player_names: input.availablePlayerNames, block_start_minutes: blockStarts, block_lengths_minutes: blockLengths, substitution_alert: setup.substitution_alert, substitution_warning_seconds: setup.substitution_warning_seconds, position_rows: positionRows(setup.formation), blocks: result.timeline, warnings: result.warnings, errors: result.errors };
}

export async function saveLocalSchedule(name: string, schedule: LiveSchedule): Promise<SavedSchedule> { return saveSchedule(await getDatabase(), schedule.team_id ?? await getActiveTeamId(), name, schedule); }
export async function getSavedSchedules(teamId: string): Promise<SavedSchedule[]> { return listSchedules(await getDatabase(), teamId); }
export async function renameSavedSchedule(id: string, name: string): Promise<void> { return renameSchedule(await getDatabase(), id, name); }
export async function deleteSavedSchedule(id: string): Promise<void> { return deleteSchedule(await getDatabase(), id); }