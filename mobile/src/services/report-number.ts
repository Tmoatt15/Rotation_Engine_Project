export function nextGameNumber(reports: Array<Pick<{ game_number: number }, 'game_number'>>): number {
  return Math.max(0, ...reports.map((report) => report.game_number)) + 1;
}
