import type { AfterGameReport, PlayerTotal } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { deleteReport, listReports, renameReport, saveReport } from '@/storage/reports';

export async function saveLocalReport(teamId: string, report: AfterGameReport): Promise<AfterGameReport> { return saveReport(await getDatabase(), teamId, report); }
export async function getSavedReports(teamId: string): Promise<AfterGameReport[]> { return listReports(await getDatabase(), teamId); }
export async function renameSavedReport(id: string, name: string): Promise<void> { return renameReport(await getDatabase(), id, name); }
export async function deleteSavedReport(id: string): Promise<void> { return deleteReport(await getDatabase(), id); }

export function aggregateSeasonTotals(reports: AfterGameReport[]): PlayerTotal[] {
  const totals = new Map<string, PlayerTotal>();
  reports.forEach((report) => report.players.forEach((player) => {
    const blockLengths = report.block_lengths_minutes ?? [];
    const uniformBlockLength = blockLengths.length > 0 && new Set(blockLengths).size === 1
      ? blockLengths[0]
      : undefined;
    const minutesPlayed = typeof player.minutesPlayed === 'number' && player.minutesPlayed !== 0
      ? player.minutesPlayed
      : player.blocksPlayed > 0 && uniformBlockLength !== undefined
        ? player.blocksPlayed * uniformBlockLength
        : 0;
    const total = totals.get(player.player) ?? { player: player.player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, games: 0 };
    total.blocksPlayed += player.blocksPlayed;
    total.minutesPlayed += minutesPlayed;
    total.games += player.blocksPlayed ? 1 : 0;
    Object.entries(player.positions).forEach(([position, count]) => { total.positions[position] = (total.positions[position] ?? 0) + count; });
    totals.set(player.player, total);
  }));
  return [...totals.values()].sort((left, right) => left.player.localeCompare(right.player));
}

export async function getSeasonTotals(teamId: string): Promise<PlayerTotal[]> {
  return aggregateSeasonTotals(await getSavedReports(teamId));
}