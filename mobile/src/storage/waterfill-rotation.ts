import type { SQLiteDatabase } from 'expo-sqlite';

import type { WaterfillRotationState } from '@/engine-redesign/model';

type RotationRow = { state_json: string };

export async function getWaterfillRotationState(
  database: SQLiteDatabase,
  teamId: string,
  beforeGameNumber: number,
): Promise<WaterfillRotationState> {
  const row = await database.getFirstAsync<RotationRow>(
    `SELECT state_json FROM waterfill_rotation_history
     WHERE team_id = ? AND game_number < ?
     ORDER BY game_number DESC LIMIT 1`,
    teamId,
    beforeGameNumber,
  );
  if (!row) return {};
  try {
    return JSON.parse(row.state_json) as WaterfillRotationState;
  } catch (error) {
    throw new Error(`Could not read water-fill rotation state for team ${teamId}.`, { cause: error });
  }
}

export async function saveWaterfillRotationState(
  database: SQLiteDatabase,
  teamId: string,
  gameNumber: number,
  state: WaterfillRotationState,
): Promise<void> {
  await database.runAsync(
    `INSERT INTO waterfill_rotation_history (team_id, game_number, state_json)
     VALUES (?, ?, ?)
     ON CONFLICT(team_id, game_number) DO UPDATE SET state_json = excluded.state_json`,
    teamId,
    gameNumber,
    JSON.stringify(state),
  );
}
