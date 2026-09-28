import * as FileSystem from 'expo-file-system/legacy';
export { buildAfterGameReport, canonicalFieldAssignments } from './report-utils';
export type { AfterGameReport, AvailabilityHistory, LivePositionOverride, PlayerGameReport, ScheduleBlock } from './report-utils';
import type { AfterGameReport, AvailabilityHistory, LivePositionOverride, ScheduleBlock } from './report-utils';

export type PositionRow = { label: string; positions: string[] };
export type LiveSchedule = {
  team_id?: string;
  team_name?: string;
  game_number: number;
  available_player_names?: string[];
  block_start_minutes?: number[];
  block_lengths_minutes?: number[];
  substitution_alert?: 'none' | 'flash' | 'vibrate' | 'flash_and_vibrate';
  substitution_warning_seconds?: number;
  position_rows?: PositionRow[];
  live_availability?: Array<{
    player: string;
    replacement: string;
    blockIndex: number;
    position: string;
  }>;
  completed_blocks?: number[];
  live_returned_players?: Array<{ player: string; blockIndex: number }>;
  live_availability_history?: AvailabilityHistory[];
  live_position_overrides?: LivePositionOverride[];
  errors?: string[];
  structural_errors?: string[];
  blocks: ScheduleBlock[];
};

const ACCEPTED_SCHEDULE_FILE = `${FileSystem.documentDirectory}accepted-schedule.json`;
let acceptedSchedule: LiveSchedule | null = null;

export async function setAcceptedSchedule(schedule: LiveSchedule): Promise<void> {
  acceptedSchedule = schedule;
  try {
    await FileSystem.writeAsStringAsync(ACCEPTED_SCHEDULE_FILE, JSON.stringify(schedule));
  } catch {
    // Keep the in-memory schedule usable if local storage is unavailable.
  }
}

export async function getAcceptedSchedule(): Promise<LiveSchedule | null> {
  if (acceptedSchedule) return acceptedSchedule;
  try {
    const storedSchedule = await FileSystem.readAsStringAsync(ACCEPTED_SCHEDULE_FILE);
    acceptedSchedule = JSON.parse(storedSchedule) as LiveSchedule;
    return acceptedSchedule;
  } catch {
    return null;
  }
}

export async function clearAcceptedSchedule(): Promise<void> {
  acceptedSchedule = null;
  try {
    await FileSystem.deleteAsync(ACCEPTED_SCHEDULE_FILE, { idempotent: true });
  } catch {
    // The schedule is cleared in memory even if the file cannot be removed.
  }
}
