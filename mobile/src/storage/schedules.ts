import type { SQLiteDatabase } from 'expo-sqlite';

import type { LiveSchedule, SavedSchedule } from '@/engine/models';

type ScheduleRow = {
  id: string;
  team_id: string;
  name: string;
  game_number: number;
  created_at: string;
  schedule_json: string;
};

function parseSchedule(row: ScheduleRow): SavedSchedule {
  return {
    id: row.id,
    name: row.name,
    game_number: row.game_number,
    created_at: row.created_at,
    schedule: JSON.parse(row.schedule_json) as LiveSchedule,
  };
}

export async function listSchedules(database: SQLiteDatabase, teamId: string): Promise<SavedSchedule[]> {
  const rows = await database.getAllAsync<ScheduleRow>(
    'SELECT * FROM saved_schedules WHERE team_id = ? ORDER BY created_at DESC',
    teamId,
  );
  return rows.map(parseSchedule);
}

export async function saveSchedule(
  database: SQLiteDatabase,
  teamId: string,
  name: string,
  schedule: LiveSchedule,
): Promise<SavedSchedule> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Schedule name is required.');
  const id = `schedule-${Date.now()}`;
  const createdAt = new Date().toISOString();
  await database.runAsync(
    `INSERT INTO saved_schedules
      (id, team_id, name, game_number, created_at, schedule_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, teamId, trimmedName, schedule.game_number ?? 1, createdAt, JSON.stringify(schedule),
  );
  const saved = await database.getFirstAsync<ScheduleRow>('SELECT * FROM saved_schedules WHERE id = ?', id);
  if (!saved) throw new Error('Schedule was not saved.');
  return parseSchedule(saved);
}

export async function renameSchedule(database: SQLiteDatabase, scheduleId: string, name: string): Promise<void> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Schedule name is required.');
  await database.runAsync('UPDATE saved_schedules SET name = ? WHERE id = ?', trimmedName, scheduleId);
}

export async function deleteSchedule(database: SQLiteDatabase, scheduleId: string): Promise<void> {
  await database.runAsync('DELETE FROM saved_schedules WHERE id = ?', scheduleId);
}