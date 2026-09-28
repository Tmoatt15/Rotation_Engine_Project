export type ScheduleBlock = { positions: Record<string, string>; bench: string[]; GK: string; [key: string]: unknown };
export type AvailabilityHistory = {
  player: string;
  replacement: string;
  blockIndex: number;
  position: string;
  endBlockIndex?: number;
};
export type LivePositionOverride = {
  blockIndex: number;
  player: string;
  fromPosition: string;
  toPosition: string;
  scope: 'current_block' | 'rest_of_game';
  reason: 'coach_swap';
  legalBefore: boolean;
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
  attendance?: number;
  block_lengths_minutes?: number[];
  structural_errors?: string[];
  core_player_names?: string[];
  starting_positions?: Record<string, string>;
  ending_positions?: Record<string, string>;
  position_overrides?: LivePositionOverride[];
  position_override_warnings?: string[];
  players: PlayerGameReport[];
};

type ReportSchedule = Pick<AfterGameReport, 'team_id' | 'team_name' | 'game_number' | 'block_lengths_minutes'> & {
  block_start_minutes?: number[];
  available_player_names?: string[];
  core_player_names?: string[];
  structural_errors?: string[];
};

const INVALID_ASSIGNMENTS = new Set(['UNASSIGNED', 'NO GK AVAILABLE']);

export function canonicalFieldAssignments(block: ScheduleBlock): Array<[string, string]> {
  const positions = { ...block.positions };
  if (block.GK && positions.GK !== block.GK) positions.GK = block.GK;
  return Object.entries(positions).filter(([, player]) => !INVALID_ASSIGNMENTS.has(player));
}

export function buildAfterGameReport(
  schedule: ReportSchedule,
  blocks: ScheduleBlock[],
  availabilityHistory: AvailabilityHistory[],
  positionOverrides: LivePositionOverride[] = [],
): AfterGameReport {
  const players = new Map<string, PlayerGameReport>();
  blocks.forEach((block, blockIndex) => {
    const configuredLength = schedule.block_lengths_minutes?.[blockIndex];
    const startTimes = schedule.block_start_minutes;
    const derivedLength = startTimes && startTimes[blockIndex + 1] !== undefined
      ? startTimes[blockIndex + 1] - (startTimes[blockIndex] ?? 0)
      : undefined;
    const blockLength = configuredLength ?? derivedLength ?? 0;
    const fieldAssignments = canonicalFieldAssignments(block);
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
      if (!INVALID_ASSIGNMENTS.has(player) && !players.has(player)) players.set(player, { player, blocksPlayed: 0, minutesPlayed: 0, positions: {}, unavailableBlocks: 0 });
    });
  });
  availabilityHistory.forEach((record) => {
    if (INVALID_ASSIGNMENTS.has(record.player)) return;
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
    attendance: schedule.available_player_names?.length,
    block_lengths_minutes: schedule.block_lengths_minutes,
    structural_errors: schedule.structural_errors ?? [],
    core_player_names: schedule.core_player_names,
    starting_positions: Object.fromEntries(canonicalFieldAssignments(blocks[0] ?? { positions: {}, bench: [], GK: '' })),
    ending_positions: Object.fromEntries(canonicalFieldAssignments(blocks[blocks.length - 1] ?? { positions: {}, bench: [], GK: '' })),
    position_overrides: positionOverrides,
    position_override_warnings: positionOverrides.filter((override) => !override.legalBefore).map((override) => `Manual position override: ${override.player} moved from ${override.fromPosition} to ${override.toPosition} in Block ${override.blockIndex + 1}.`),
    players: [...players.values()].sort((first, second) => first.player.localeCompare(second.player)),
  };
}
