export type RedesignGroup = 'core' | 'rotational' | 'developing';
export type RedesignFormat = '4v4' | '7v7' | '9v9' | '11v11';
export type RedesignZone = 'CM' | 'CB' | 'ST' | 'WIDE';
export type RedesignPosition = string;

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
  surplusAssignments: Array<{ group: RedesignGroup; player: string; amount: number }>;
  unfillableWithinMax: number;
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
}
