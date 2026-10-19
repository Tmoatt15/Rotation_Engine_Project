export type RedesignGroup = 'core' | 'rotational' | 'developing';
export type FieldGroup = 'D' | 'M' | 'F';
export type RedesignFormat = '4v4' | '7v7' | '9v9' | '11v11';
export type RedesignZone = 'CM' | 'CB' | 'ST' | 'WIDE';
export type RedesignPosition = string;

export interface WaterfillRotationEntry {
  lastShed?: string;
  lastGained?: string;
}

export type WaterfillRotationState = Partial<Record<`${FieldGroup}:${RedesignGroup}`, WaterfillRotationEntry>>;

export interface RedesignPlayerInput {
  name: string;
  group: string;
  general_positions?: string[];
  general_position?: string;
  primary_positions?: string[];
  primary_position?: string;
  backup_positions?: string[];
  excluded_positions?: string[];
  forbidden_positions?: string[];
  keeper?: boolean;
  keeper_eligible?: boolean;
  rest_preset?: 'A' | 'B' | 'none';
  available?: boolean;
  historicalFieldBlocks?: number;
  historicalGkBlocks?: number;
  historicalStarts?: number;
}

export interface NormalizedPlayer {
  name: string;
  group: RedesignGroup;
  generalPositions: string[];
  primaryPositions: string[];
  backupPositions: string[];
  excludedPositions: string[];
  available: boolean;
  keeper: boolean;
  keeperEligible: boolean;
  emergencyKeeper: boolean;
  restPreset: 'A' | 'B' | 'none';
  history: {
    historicalFieldBlocks: number;
    historicalGkBlocks: number;
    historicalStarts: number;
  };
}

export interface LineupPin {
  block: number;
  slot: string;
  player: string;
}

export interface LateArrivalInput {
  player: string;
  arrivalBlock: number;
  targetBlocks?: number;
}

export interface RedesignGameInput {
  format: RedesignFormat;
  formation: string;
  totalBlocks: number;
  blockMinutes?: number | number[];
  availablePlayerNames?: string[];
  firstHalfKeeper?: string | null;
  secondHalfKeeper?: string | null;
  emergencyKeepers?: string[];
  pins?: LineupPin[];
  lateArrival?: LateArrivalInput;
  seasonHistory?: Record<string, NormalizedPlayer['history']>;
  seasonRotation?: WaterfillRotationState;
  disableMaximumLimits?: boolean;
}

export interface NormalizedGame {
  format: RedesignFormat;
  formation: string;
  totalBlocks: number;
  blockMinutes?: number | number[];
  players: NormalizedPlayer[];
  firstHalfKeeper: string | null;
  secondHalfKeeper: string | null;
  pins: LineupPin[];
  lateArrival: LateArrivalInput | null;
  seasonRotation?: WaterfillRotationState;
  disableMaximumLimits: boolean;
}

export interface DemandSlot {
  slot: string;
  group: 'D' | 'M' | 'F';
  zone: RedesignZone;
}

export interface DemandModel {
  fieldSlots: DemandSlot[];
  goalkeeperRequired: boolean;
  goalkeeperBlocks: [number, number];
  slotsPerBlock: number;
}

export interface QuotaAudit {
  relaxedGroups: Array<{ group: RedesignGroup; amount: number }>;
  relaxedPlayers?: Array<{ player: string; group: RedesignGroup; before: number; after: number; belowHardFloor: boolean }>;
  surplusAssignments: Array<{ group: RedesignGroup; player: string; amount: number }>;
  unfillableWithinMax: number;
  maximumCapacityShortfall?: number;
  relaxedMaximums?: { player: string; group: RedesignGroup; before: number; after: number }[];
  underfill: Array<{ group: FieldGroup; blocks: number; slotNames: string[] }>;
  overage: Array<{ group: FieldGroup; blocks: number }>;
  rosterTooLarge?: { maxPlayers: number };
  errors?: string[];
  warnings?: string[];
}

export interface PlayerQuota {
  player: string;
  group: RedesignGroup;
  totalMin: number;
  totalMax: number;
  pinnedBlocks: number[];
  remainingMin: number;
  remainingMax: number;
  fieldMin: number;
  fieldMax: number;
  fieldTarget: number;
  groupTargets?: Partial<Record<FieldGroup, number>>;
  gkMin: number;
  gkMax: number;
  keeperBlocks: number;
  history: NormalizedPlayer['history'];
}

export interface QuotaAssignment {
  quotas: PlayerQuota[];
  audit: QuotaAudit;
  fieldSlots: number;
  goalkeeperSlots: number;
  rotationState?: WaterfillRotationState;
}
