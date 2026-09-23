export type PositionGroup = 'GK' | 'D' | 'M' | 'F';
export type PlayerGroup =
  | 'core'
  | 'core_a'
  | 'core_b'
  | 'developing'
  | 'developmental'
  | 'rotational'
  | 'rotational_gk';
export type GameFormat = '4v4' | '5v5' | '7v7' | '9v9' | '11v11';
export type PositionCode = string;
export type Formation = string;
export type SubstitutionAlert = 'none' | 'flash' | 'vibrate' | 'flash_and_vibrate';
export type BlocksByHalf = [number, number];

export type PositionUsage = Record<PositionGroup, number>;

export interface PlayerInput {
  name: string;
  group: PlayerGroup;
  primary_position?: PositionCode;
  forbidden_positions?: PositionCode[];
  backup_positions?: PositionCode[];
  general_position?: PositionCode;
  general_positions?: PositionCode[];
  primary_positions?: PositionCode[];
  excluded_positions?: PositionCode[];
}

export interface Player extends PlayerInput {
  group: PlayerGroup;
  core_tier: 'A' | 'B' | null;
  general_positions: PositionCode[];
  primary_positions: PositionCode[];
  backup_positions: PositionCode[];
  excluded_positions: PositionCode[];
  general_position: PositionCode;
  primary_position: PositionCode;
  forbidden_positions: PositionCode[];
  positional_group: PositionCode | null;
  available: boolean;
  target_blocks: number;
  minimum_blocks: number;
  maximum_blocks: number;
  hard_minimum_blocks: number;
  hard_maximum_blocks: number;
  max_blocks_per_half: number;
  gk_field_minimum_blocks: number;
  gk_field_maximum_blocks: number;
  blocks_by_half: BlocksByHalf;
  block_count: number;
  bench_count: number;
  position_usage: PositionUsage;
  gk_blocks: number;
  field_blocks: number;
  max_gk_blocks: number;
  gk_field_targets_by_half: BlocksByHalf;
  last_two: Array<PositionGroup | 'BENCH' | null>;
}

export interface SeasonSettings {
  game_length_minutes: number;
  game_format: GameFormat;
  total_blocks: number;
  block_length_minutes: number;
  formation: Formation;
  total_games: number;
  substitution_alert: SubstitutionAlert;
  substitution_warning_seconds: 15 | 30 | 60;
  base_block_seconds?: number;
  block_seconds?: number[];
  players_on_field?: number;
  has_goalkeeper?: boolean;
}

export interface SeasonRosterPlayer extends PlayerInput {
  name: string;
  group: PlayerGroup;
  general_positions: PositionCode[];
  primary_positions: PositionCode[];
  backup_positions: PositionCode[];
  excluded_positions: PositionCode[];
}

export interface AvailabilityChange {
  player: string;
  action: 'available' | 'unavailable';
  block: number;
}

export interface ReplacementCredit {
  player: string;
  block: number;
  position: PositionCode;
  replacement?: string;
}

export interface ScheduleBlock {
  GK: string;
  D: string[];
  M: string[];
  F: string[];
  bench: string[];
  positions: Record<PositionCode, string>;
  [key: string]: unknown;
}

export interface GameInput {
  total_blocks: number;
  formation: Formation;
  gk_assignment?: string | null;
  first_half_gk?: string | null;
  second_half_gk?: string | null;
  season_total_games?: number;
  season_game_number?: number;
  season_seed?: number;
  allow_emergency_positions?: boolean;
  season_player_blocks?: Record<string, number>;
  season_position_starts?: Record<string, Record<string, number>>;
}

export interface Game extends Required<
  Pick<
    GameInput,
    | 'total_blocks'
    | 'formation'
    | 'season_total_games'
    | 'season_game_number'
    | 'season_seed'
    | 'allow_emergency_positions'
  >
> {
  gk_assignment: string | null;
  first_half_gk: string | null;
  second_half_gk: string | null;
  core_high_names: string[] | null;
  replacement_credits: ReplacementCredit[];
  replacement_bonuses: Record<string, number>;
  availability_changes: AvailabilityChange[];
  quota_exempt_players: Set<string>;
  timeline: ScheduleBlock[];
  season_player_blocks?: Record<string, number>;
  season_position_starts?: Record<string, Record<string, number>>;
}

export interface GoalkeeperSummary {
  gk: number;
  field: number;
  bench: number;
}

export interface RotationMetadata {
  formation?: Formation;
  total_blocks?: number;
  [key: string]: unknown;
}

export interface MovementHalfMetrics {
  turnovers: number;
  exact_slot_switches: number;
  group_switches: number;
}

export interface MovementMetrics {
  turnovers: number;
  exact_slot_switches: number;
  group_switches: number;
  primary_assignments: number;
  backup_assignments: number;
  emergency_assignments: number;
  by_half: [MovementHalfMetrics, MovementHalfMetrics];
}

export interface RotationResult {
  timeline: ScheduleBlock[];
  block_counts: Record<string, number>;
  gk_summary: Record<string, GoalkeeperSummary>;
  position_summary: Record<string, Partial<PositionUsage>>;
  warnings: string[];
  errors: string[];
  metadata: RotationMetadata;
  movement_metrics?: MovementMetrics;
  starting_position_counts?: Record<string, Record<string, number>>;
}

export interface PositionRow {
  label: string;
  positions: PositionCode[];
}

export interface PlayerGameReport {
  player: string;
  blocksPlayed: number;
  minutesPlayed: number;
  positions: Record<PositionCode, number>;
  unavailableBlocks: number;
}

export interface AfterGameReport {
  id?: string;
  name?: string;
  team_id?: string;
  team_name?: string;
  game_number: number;
  created_at: string;
  total_blocks: number;
  block_lengths_minutes?: number[];
  players: PlayerGameReport[];
}

export interface SavedSchedule {
  id: string;
  name: string;
  game_number: number;
  created_at?: string;
  schedule: LiveSchedule;
}

export interface LiveSchedule {
  team_id?: string;
  team_name?: string;
  game_number: number;
  block_start_minutes?: number[];
  block_lengths_minutes?: number[];
  substitution_alert?: SubstitutionAlert;
  substitution_warning_seconds?: number;
  position_rows?: PositionRow[];
  live_availability?: AvailabilityRecord[];
  completed_blocks?: number[];
  live_returned_players?: Array<{ player: string; blockIndex: number }>;
  live_availability_history?: AvailabilityHistory[];
  movement_metrics?: MovementMetrics;
  review_status?: 'generated' | 'manually_edited';
  blocks: ScheduleBlock[];
}

export interface AvailabilityRecord {
  player: string;
  replacement: string;
  blockIndex: number;
  position: PositionCode;
}

export interface AvailabilityHistory extends AvailabilityRecord {
  endBlockIndex?: number;
}

export interface PlayerTotal {
  player: string;
  blocksPlayed: number;
  minutesPlayed: number;
  positions: Record<PositionCode, number>;
  games: number;
}

export interface Team {
  id: string;
  name: string;
  players: string[];
  active?: boolean;
  season_roster?: SeasonRosterPlayer[];
  season_settings?: SeasonSettings;
  saved_schedules?: SavedSchedule[];
  game_reports?: AfterGameReport[];
}