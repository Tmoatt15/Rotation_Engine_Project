import * as FileSystem from 'expo-file-system/legacy';

export type ScheduleBlock = { positions: Record<string, string>; bench: string[]; GK: string; [key: string]: unknown };
export type PositionRow = { label: string; positions: string[] };
export type AvailabilityHistory = {
  player: string;
  replacement: string;
  blockIndex: number;
  position: string;
  endBlockIndex?: number;
};
export type PlayerGameReport = {
  player: string;
  blocksPlayed: number;
  minutesPlayed: number;
  positions: Record<string, number>;
  unavailableBlocks: number;
};
export type AfterGameReport = {
  team_id?: string;
  team_name?: string;
  game_number: number;
  created_at: string;
  total_blocks: number;
  block_lengths_minutes?: number[];
  players: PlayerGameReport[];
};
export type LiveSchedule = {
  team_id?: string;
  team_name?: string;
  game_number: number;
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
  blocks: ScheduleBlock[];
};

export function buildAfterGameReport(
  schedule: LiveSchedule,
  blocks: ScheduleBlock[],
  availabilityHistory: AvailabilityHistory[],
): AfterGameReport {
  const players = new Map<string, PlayerGameReport>();
  blocks.forEach((block, blockIndex) => {
    const configuredLength = schedule.block_lengths_minutes?.[blockIndex];
    const startTimes = schedule.block_start_minutes;
    const derivedLength = startTimes && startTimes[blockIndex + 1] !== undefined
      ? startTimes[blockIndex + 1] - (startTimes[blockIndex] ?? 0)
      : undefined;
    const blockLength = configuredLength ?? derivedLength ?? 0;
    const fieldAssignments = Object.entries({ GK: block.GK, ...block.positions });
    const fieldPlayers = new Set(fieldAssignments.map(([, player]) => player));
    fieldPlayers.forEach((player) => {
      const entry = players.get(player) ?? { player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, unavailableBlocks: 0 };
      entry.blocksPlayed += 1;
      entry.minutesPlayed += blockLength;
      players.set(player, entry);
    });
    fieldAssignments.forEach(([position, player]) => {
      const entry = players.get(player) ?? { player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, unavailableBlocks: 0 };
      entry.positions[position] = (entry.positions[position] ?? 0) + 1;
      players.set(player, entry);
    });
    block.bench.forEach((player) => {
      if (!players.has(player)) players.set(player, { player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, unavailableBlocks: 0 });
    });
  });
  availabilityHistory.forEach((record) => {
    const entry = players.get(record.player) ?? { player: record.player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, unavailableBlocks: 0 };
    const endBlock = record.endBlockIndex ?? blocks.length;
    entry.unavailableBlocks += Math.max(0, endBlock - record.blockIndex);
    players.set(record.player, entry);
  });
  return {
    team_id: schedule.team_id,
    team_name: schedule.team_name,
    game_number: schedule.game_number,
    created_at: new Date().toISOString(),
    total_blocks: blocks.length,
    block_lengths_minutes: schedule.block_lengths_minutes,
    players: [...players.values()].sort((first, second) => first.player.localeCompare(second.player)),
  };
}

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
