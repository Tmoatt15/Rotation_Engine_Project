import { createPlayer } from './engine/rotation';
import { calculateQuotaFeasibility, positionCapacityWarnings } from './engine/quotas';
import { parseFormation } from './engine/timeline';
import type { SeasonRosterPlayer, SeasonSettings } from './engine/models';

export const PLAYING_TIME_NOTICE = 'Playing-time notice: With the current position and group assignments, some players may not reach their normal playing-time target.';
export const POSITION_COVERAGE_NOTICE = 'Position coverage notice: The current position assignments may not provide enough coverage for every position during the game.';

export type PlayingTimeNoticeResult = {
  playingTimeNotice: boolean;
  positionCoverageNotice: boolean;
};

function formationCounts(formation: string): Record<'D' | 'M' | 'F', number> {
  const parsed = parseFormation(formation);
  return { D: parsed.D, M: parsed.M, F: parsed.F };
}

export function calculatePlayingTimeNotices(
  settings: Pick<SeasonSettings, 'formation' | 'total_blocks' | 'has_goalkeeper' | 'game_format'>,
  roster: SeasonRosterPlayer[],
): PlayingTimeNoticeResult {
  const players = roster.map((player) => createPlayer(player));
  const quotaFeasibility = calculateQuotaFeasibility(formationCounts(settings.formation), players, settings.total_blocks);
  const fieldPositionWarnings = positionCapacityWarnings(settings.formation, players);
  const goalkeeperCoverageShortage = Boolean(settings.has_goalkeeper) && !players.some((player) => player.available && player.primary_positions.includes('GK'));

  return {
    playingTimeNotice: !quotaFeasibility.minimumsFeasible,
    positionCoverageNotice: fieldPositionWarnings.length > 0 || goalkeeperCoverageShortage,
  };
}