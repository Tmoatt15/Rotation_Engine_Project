import { formationSlots, parseFormation } from '@/engine/timeline';
import { generateSchedule } from '@/engine/rotation';
import { createPlayer } from '@/engine/rotation';
import { SeasonSetup } from '@/engine/season';
import type { AfterGameReport, LiveSchedule, SavedSchedule, SeasonRosterPlayer } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { deleteSchedule, listSchedules, renameSchedule, saveSchedule } from '@/storage/schedules';
import { getSavedReports } from '@/services/report-service';
import { getActiveTeamId } from '@/services/team-service';
import { getLocalTeam, getRoster, getSeasonSettings } from './team-service';
import { summarizeStructuralErrors } from './structural-diagnostics';
import { assertCompleteSchedule } from './schedule-validation';

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

function seasonHistory(reports: AfterGameReport[], gameNumber: number): { playerBlocks: Record<string, number>; positionStarts: Record<string, Record<string, number>>; goalkeeperStarts: Record<string, number> } {
  const playerBlocks: Record<string, number> = {};
  const positionStarts: Record<string, Record<string, number>> = {};
  const goalkeeperStarts: Record<string, number> = {};
  reports.filter((report) => report.game_number < gameNumber).forEach((report) => {
    report.players.forEach((player) => {
      playerBlocks[player.player] = (playerBlocks[player.player] ?? 0) + player.blocksPlayed;
    });
    Object.entries(report.starting_positions ?? {}).forEach(([position, player]) => {
      positionStarts[player] = { ...(positionStarts[player] ?? {}), [position]: (positionStarts[player]?.[position] ?? 0) + 1 };
      if (position === 'GK') goalkeeperStarts[player] = (goalkeeperStarts[player] ?? 0) + 1;
    });
  });
  return { playerBlocks, positionStarts, goalkeeperStarts };
}

export async function generateLocalSchedule(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null; disableMaximumLimits?: boolean }): Promise<LiveSchedule & { warnings: string[]; errors: string[]; available_player_names: string[] }> {
  const settings = await getSeasonSettings(input.teamId);
  const team = await getLocalTeam(input.teamId);
  const roster = (await getRoster(input.teamId)).players.map(rosterInput).filter((player) => input.availablePlayerNames.includes(player.name));
  const setup = new SeasonSetup({ ...settings, block_length_minutes: undefined });
  const history = seasonHistory(await getSavedReports(input.teamId), input.gameNumber);
  const result = generateSchedule({ game_format: setup.game_format, has_goalkeeper: setup.has_goalkeeper, total_blocks: setup.total_blocks, formation: setup.formation, first_half_gk: input.firstHalfGk, second_half_gk: input.secondHalfGk, season_total_games: setup.total_games, season_game_number: input.gameNumber, season_seed: 2026, season_player_blocks: history.playerBlocks, season_position_starts: history.positionStarts, season_goalkeeper_starts: history.goalkeeperStarts, allow_emergency_assignments: true, disable_maximum_limits: input.disableMaximumLimits ?? false }, roster.map(createPlayer));
  const goalkeeperErrors = result.errors.filter((error) => error.toLowerCase().includes('goalkeeper'));
  if (goalkeeperErrors.length) throw new Error(goalkeeperErrors.join(' '));
  assertCompleteSchedule(result.errors);
  const blockLengths = setup.block_lengths_minutes;
  const blockStarts = blockLengths.reduce<number[]>((starts, length) => [...starts, (starts[starts.length - 1] ?? 0) + (starts.length ? length : 0)], []);
  const structuralErrors = summarizeStructuralErrors(input.gameNumber, result.errors.filter((error) => !error.includes('exceeds') && !error.includes('under target') && !error.includes('under minimum')));
  return { team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, available_player_names: input.availablePlayerNames, core_player_names: roster.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group)).map((player) => player.name), block_start_minutes: blockStarts, block_lengths_minutes: blockLengths, substitution_alert: setup.substitution_alert, substitution_warning_seconds: setup.substitution_warning_seconds, position_rows: positionRows(setup.formation), blocks: result.timeline, warnings: result.warnings, errors: result.errors, structural_errors: structuralErrors, movement_metrics: result.movement_metrics, review_status: result.errors.length ? 'generated_with_errors' : 'generated' };
}

export async function saveLocalSchedule(name: string, schedule: LiveSchedule): Promise<SavedSchedule> { return saveSchedule(await getDatabase(), schedule.team_id ?? await getActiveTeamId(), name, schedule); }
export async function getSavedSchedules(teamId: string): Promise<SavedSchedule[]> { return listSchedules(await getDatabase(), teamId); }
export async function renameSavedSchedule(id: string, name: string): Promise<void> { return renameSchedule(await getDatabase(), id, name); }
export async function deleteSavedSchedule(id: string): Promise<void> { return deleteSchedule(await getDatabase(), id); }