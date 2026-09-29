import type { AfterGameReport } from '@/engine/models';
import { summarizeStructuralErrors } from './structural-diagnostics';

export const SEASON_FAIRNESS_THRESHOLDS = {
  minimumAppearancesForZeroStart: 2,
  maximumSameRoleStartGap: 2,
} as const;

export type SeasonFairnessPlayer = {
  player: string;
  minutes: number;
  attendanceAdjustedMinutes: number;
  starts: number;
  attendanceAdjustedStarts: number;
  positionStarts: Record<string, number>;
  positionBlocks: Record<string, number>;
  appearances: number;
  flags: string[];
};

export type SeasonFairnessReport = {
  thresholds: typeof SEASON_FAIRNESS_THRESHOLDS;
  players: SeasonFairnessPlayer[];
  zeroStartPlayers: string[];
  sameRoleDisparities: { position: string; highPlayer: string; lowPlayer: string; gap: number }[];
  first_endpoint_misses: { game: number; player: string }[];
  last_endpoint_misses: { game: number; player: string }[];
  structuralErrors: { game: number; errors: string[] }[];
  accepted: boolean;
};

export function aggregateSeasonFairness(reports: AfterGameReport[]): SeasonFairnessReport {
  const attendanceValues = reports.map((report) => report.attendance).filter((attendance): attendance is number => typeof attendance === 'number' && attendance > 0);
  const referenceAttendance = Math.max(...attendanceValues, 1);
  const players = new Map<string, SeasonFairnessPlayer>();
  const structuralErrors: { game: number; errors: string[] }[] = [];
  const first_endpoint_misses: { game: number; player: string }[] = [];
  const last_endpoint_misses: { game: number; player: string }[] = [];

  reports.forEach((report) => {
    const attendance = report.attendance ?? referenceAttendance;
    const attendanceFactor = attendance / referenceAttendance;
    const starters = new Set(Object.values(report.starting_positions ?? {}));
    const firstEndpointPlayers = new Set(Object.values(report.starting_positions ?? {}));
    const lastEndpointPlayers = new Set(Object.values(report.ending_positions ?? {}));
    report.core_player_names?.forEach((player) => {
      if (!firstEndpointPlayers.has(player)) first_endpoint_misses.push({ game: report.game_number, player });
      if (!lastEndpointPlayers.has(player)) last_endpoint_misses.push({ game: report.game_number, player });
    });
    if (report.structural_errors?.length) structuralErrors.push({ game: report.game_number, errors: summarizeStructuralErrors(report.game_number, report.structural_errors) });
    report.players.forEach((player) => {
      const current = players.get(player.player) ?? { player: player.player, minutes: 0, attendanceAdjustedMinutes: 0, starts: 0, attendanceAdjustedStarts: 0, positionStarts: {}, positionBlocks: {}, appearances: 0, flags: [] };
      current.minutes += player.minutesPlayed;
      current.attendanceAdjustedMinutes += player.minutesPlayed * attendanceFactor;
      current.starts += starters.has(player.player) ? 1 : 0;
      current.attendanceAdjustedStarts += starters.has(player.player) ? attendanceFactor : 0;
      current.appearances += player.blocksPlayed > 0 ? 1 : 0;
      Object.entries(report.starting_positions ?? {}).forEach(([position, name]) => {
        if (name === player.player) current.positionStarts[position] = (current.positionStarts[position] ?? 0) + 1;
      });
      Object.entries(player.positions).forEach(([position, count]) => { current.positionBlocks[position] = (current.positionBlocks[position] ?? 0) + count; });
      players.set(player.player, current);
    });
  });

  const zeroStartPlayers = [...players.values()]
    .filter((player) => player.appearances >= SEASON_FAIRNESS_THRESHOLDS.minimumAppearancesForZeroStart && player.starts === 0)
    .map((player) => player.player);
  const sameRoleDisparities: SeasonFairnessReport['sameRoleDisparities'] = [];
  const positions = new Set([...players.values()].flatMap((player) => Object.keys(player.positionStarts)));
  for (const position of positions) {
    const eligiblePlayers = [...players.values()].filter((player) => player.appearances > 0 && ((player.positionStarts[position] ?? 0) > 0 || (player.positionBlocks[position] ?? 0) > 0));
    if (eligiblePlayers.length < 2) continue;
    const high = [...eligiblePlayers].sort((left, right) => (right.positionStarts[position] ?? 0) - (left.positionStarts[position] ?? 0) || left.player.localeCompare(right.player))[0];
    const low = [...eligiblePlayers].sort((left, right) => (left.positionStarts[position] ?? 0) - (right.positionStarts[position] ?? 0) || left.player.localeCompare(right.player))[0];
    const gap = (high.positionStarts[position] ?? 0) - (low.positionStarts[position] ?? 0);
    if (gap > SEASON_FAIRNESS_THRESHOLDS.maximumSameRoleStartGap) sameRoleDisparities.push({ position, highPlayer: high.player, lowPlayer: low.player, gap });
  }

  const zeroStartSet = new Set(zeroStartPlayers);
  const disparitySet = new Set(sameRoleDisparities.flatMap(({ highPlayer, lowPlayer }) => [highPlayer, lowPlayer]));
  const playerResults = [...players.values()].map((player) => ({
    ...player,
    flags: [
      ...(zeroStartSet.has(player.player) ? ['zero starts'] : []),
      ...(disparitySet.has(player.player) ? ['same-role start disparity'] : []),
    ],
  })).sort((left, right) => left.player.localeCompare(right.player));
  return { thresholds: SEASON_FAIRNESS_THRESHOLDS, players: playerResults, zeroStartPlayers, sameRoleDisparities, first_endpoint_misses, last_endpoint_misses, structuralErrors, accepted: zeroStartPlayers.length === 0 && sameRoleDisparities.length === 0 && first_endpoint_misses.length === 0 && last_endpoint_misses.length === 0 && structuralErrors.length === 0 };
}
