import type { SQLiteDatabase } from 'expo-sqlite';

import type { AfterGameReport } from '@/engine/models';

type ReportRow = {
  id: string;
  team_id: string;
  name: string | null;
  game_number: number;
  created_at: string;
  report_json: string;
};

function parseReport(row: ReportRow): AfterGameReport {
  const report = JSON.parse(row.report_json) as AfterGameReport;
  return { ...report, id: row.id, name: row.name ?? undefined, team_id: row.team_id, game_number: row.game_number, created_at: row.created_at };
}

export async function listReports(database: SQLiteDatabase, teamId: string): Promise<AfterGameReport[]> {
  const rows = await database.getAllAsync<ReportRow>(
    'SELECT * FROM game_reports WHERE team_id = ? ORDER BY created_at DESC',
    teamId,
  );
  return rows.map(parseReport);
}

export async function saveReport(
  database: SQLiteDatabase,
  teamId: string,
  report: AfterGameReport,
): Promise<AfterGameReport> {
  const id = `report-${Date.now()}`;
  const createdAt = report.created_at || new Date().toISOString();
  const stored = { ...report, id, team_id: teamId, created_at: createdAt };
  await database.runAsync(
    `INSERT INTO game_reports
      (id, team_id, name, game_number, created_at, report_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, teamId, report.name ?? null, report.game_number ?? 1, createdAt, JSON.stringify(stored),
  );
  return stored;
}

export async function renameReport(database: SQLiteDatabase, reportId: string, name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Report name is required.');
  await database.runAsync('UPDATE game_reports SET name = ? WHERE id = ?', trimmedName, reportId);
}

export async function deleteReport(database: SQLiteDatabase, reportId: string): Promise<void> {
  await database.runAsync('DELETE FROM game_reports WHERE id = ?', reportId);
}