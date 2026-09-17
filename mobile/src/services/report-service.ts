import type { AfterGameReport, PlayerTotal } from '@/engine/models';
import { getDatabase } from '@/storage/database';
import { deleteReport, listReports, renameReport, saveReport } from '@/storage/reports';

export async function saveLocalReport(teamId: string, report: AfterGameReport): Promise<AfterGameReport> { return saveReport(await getDatabase(), teamId, report); }
export async function getSavedReports(teamId: string): Promise<AfterGameReport[]> { return listReports(await getDatabase(), teamId); }
export async function renameSavedReport(id: string, name: string): Promise<void> { return renameReport(await getDatabase(), id, name); }
export async function deleteSavedReport(id: string): Promise<void> { return deleteReport(await getDatabase(), id); }

export async function getSeasonTotals(teamId: string): Promise<PlayerTotal[]> {
  const reports = await getSavedReports(teamId);
  const totals = new Map<string, PlayerTotal>();
  reports.forEach((report) => report.players.forEach((player) => {
    const total = totals.get(player.player) ?? { player: player.player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, games: 0 };
    total.blocksPlayed += player.blocksPlayed;
    total.minutesPlayed += player.minutesPlayed;
    total.games += 1;
    Object.entries(player.positions).forEach(([position, count]) => { total.positions[position] = (total.positions[position] ?? 0) + count; });
    totals.set(player.player, total);
  }));
  return [...totals.values()].sort((left, right) => left.player.localeCompare(right.player));
}