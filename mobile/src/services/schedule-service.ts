import { formationSlots, parseFormation } from '@/engine/timeline';
import { createPlayer, generateSchedule, regenerateSchedule } from '@/engine/rotation';
import { blockStartMinutes, SeasonSetup } from '@/engine/season';
import type { AfterGameReport, LateArrivalApprovalRequest, LiveSchedule, SavedSchedule, SeasonRosterPlayer } from '@/engine/models';
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
  const blockStarts = blockStartMinutes(blockLengths);
  const structuralErrors = summarizeStructuralErrors(input.gameNumber, result.errors.filter((error) => !error.includes('exceeds') && !error.includes('under target') && !error.includes('under minimum')));
  return { team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null, available_player_names: input.availablePlayerNames, core_player_names: roster.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group)).map((player) => player.name), block_start_minutes: blockStarts, block_lengths_minutes: blockLengths, substitution_alert: setup.substitution_alert, substitution_warning_seconds: setup.substitution_warning_seconds, position_rows: positionRows(setup.formation), blocks: result.timeline, warnings: result.warnings, errors: result.errors, structural_errors: structuralErrors, movement_metrics: result.movement_metrics, review_status: result.errors.length ? 'generated_with_errors' : 'generated' };
}

export async function regenerateLateArrivalSchedule(input: { teamId: string; gameNumber: number; previousSchedule: LiveSchedule; availablePlayerNames: string[]; playerName: string; startBlock: number; targetBlocks: number; minimumBlocks: number; maximumBlocks: number; firstHalfGk?: string | null; secondHalfGk?: string | null; continueBelowMinimum?: boolean; approval?: LateArrivalApprovalRequest; approvedPlayerName?: string }): Promise<LiveSchedule & { warnings: string[]; errors: string[]; available_player_names: string[]; needs_minimum_warning?: boolean; minimum_warning?: string }> {
  const settings = await getSeasonSettings(input.teamId);
  const team = await getLocalTeam(input.teamId);
  const allPlayers = (await getRoster(input.teamId)).players.map(rosterInput);
  const setup = new SeasonSetup({ ...settings, block_length_minutes: undefined });
  const history = seasonHistory(await getSavedReports(input.teamId), input.gameNumber);
  const players = allPlayers.map(createPlayer);
  players.forEach((player) => { player.available = input.availablePlayerNames.includes(player.name); });
  if (input.approvedPlayerName) console.info('[schedule-service] approved-player request', { approvedPlayerName: input.approvedPlayerName, playerName: input.playerName, startBlock: input.startBlock, approvalScope: input.approval?.scope });
  const result = regenerateSchedule({ game_format: setup.game_format, has_goalkeeper: setup.has_goalkeeper, total_blocks: setup.total_blocks, formation: setup.formation, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null, season_total_games: setup.total_games, season_game_number: input.gameNumber, season_seed: 2026, season_player_blocks: history.playerBlocks, season_position_starts: history.positionStarts, season_goalkeeper_starts: history.goalkeeperStarts, allow_emergency_assignments: true, late_arrival_approval: input.approval }, players, input.previousSchedule.blocks, [{ player: input.playerName, action: 'available', block: input.startBlock - 1, target_blocks: input.targetBlocks, minimum_blocks: input.minimumBlocks, maximum_blocks: input.maximumBlocks }], input.availablePlayerNames, true, input.approvedPlayerName);
  const goalkeeperErrors = result.errors.filter((error) => error.toLowerCase().includes('goalkeeper'));
  if (goalkeeperErrors.length) throw new Error(goalkeeperErrors.join(' '));
  const blockLengths = setup.block_lengths_minutes;
  const blockStarts = blockStartMinutes(blockLengths);
  const structuralErrors = summarizeStructuralErrors(input.gameNumber, result.errors.filter((error) => !error.includes('exceeds') && !error.includes('under target') && !error.includes('under minimum')));
  const minimumErrors = result.errors.filter((error) => error.toLowerCase().includes('under minimum'));
  if (result.needs_coach_approval && !input.continueBelowMinimum) {
    const donor = minimumErrors[0]?.replace(/^.*?under minimum:?\s*/i, '') ?? 'a player';
    return {
      team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, available_player_names: result.available_player_names ?? input.availablePlayerNames,
      first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null, position_rows: positionRows(setup.formation),
      block_start_minutes: blockStarts, block_lengths_minutes: blockLengths, substitution_alert: setup.substitution_alert,
      substitution_warning_seconds: setup.substitution_warning_seconds, blocks: result.timeline, warnings: result.warnings, errors: result.errors,
      structural_errors: structuralErrors, movement_metrics: result.movement_metrics, needs_minimum_warning: true,
      minimum_warning: `Adding ${input.playerName} would require taking a block from ${donor}.`,
      review_status: 'generated_with_errors',
    };
  }
  assertCompleteSchedule(input.continueBelowMinimum ? result.errors.filter((error) => !error.toLowerCase().includes('under minimum')) : result.errors);
  return { team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, available_player_names: result.available_player_names ?? input.availablePlayerNames, core_player_names: allPlayers.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group)).map((player) => player.name), block_start_minutes: blockStarts, block_lengths_minutes: blockLengths, substitution_alert: setup.substitution_alert, substitution_warning_seconds: setup.substitution_warning_seconds, position_rows: positionRows(setup.formation), blocks: result.timeline, warnings: result.warnings, errors: result.errors, structural_errors: structuralErrors, movement_metrics: result.movement_metrics, review_status: result.errors.length ? 'generated_with_errors' : 'generated' };
}

export async function saveLocalSchedule(name: string, schedule: LiveSchedule): Promise<SavedSchedule> { return saveSchedule(await getDatabase(), schedule.team_id ?? await getActiveTeamId(), name, schedule); }
export async function getSavedSchedules(teamId: string): Promise<SavedSchedule[]> { return listSchedules(await getDatabase(), teamId); }
export async function renameSavedSchedule(id: string, name: string): Promise<void> { return renameSchedule(await getDatabase(), id, name); }
export async function deleteSavedSchedule(id: string): Promise<void> { return deleteSchedule(await getDatabase(), id); }