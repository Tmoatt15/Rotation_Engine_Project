import type { DemandModel, NormalizedGame, QuotaAssignment, PlayerQuota } from './model';
import { runStages3And4 } from './stage4';
import type { FrozenBlock, PlacementBlock } from './stage3';
import type { PolishedPlacement } from './stage4';

export interface LateArrivalReplanInput {
  game: NormalizedGame;
  demand: DemandModel;
  quotas: QuotaAssignment;
  frozen: FrozenBlock[];
  arrivalTarget?: number;
}

export interface DonorReduction {
  player: string;
  amount: number;
  before: number;
  after: number;
}

export interface LateArrivalFailure {
  kind: 'donor-below-minimum' | 'unfillable-within-maxes' | 'position-uncovered' | 'late-arrival-exhausted';
  arrival?: string;
  player?: string;
  before?: number;
  after?: number;
  errors: string[];
}

export interface LateArrivalReplanSuccess {
  kind: 'success';
  placement: PolishedPlacement;
  quotas: QuotaAssignment;
  donorReductions: DonorReduction[];
  keeperFlexed: boolean;
}

export type LateArrivalReplanResult = LateArrivalReplanSuccess | { kind: 'failure'; failure: LateArrivalFailure; quotas: QuotaAssignment };

function cloneQuota(quota: PlayerQuota): PlayerQuota {
  return { ...quota, pinnedBlocks: [...quota.pinnedBlocks], history: { ...quota.history } };
}

function cloneQuotas(quotas: QuotaAssignment): QuotaAssignment {
  return {
    ...quotas,
    quotas: quotas.quotas.map(cloneQuota),
    audit: {
      ...quotas.audit,
      relaxedGroups: quotas.audit.relaxedGroups.map((entry) => ({ ...entry })),
      surplusAssignments: quotas.audit.surplusAssignments.map((entry) => ({ ...entry })),
    },
  };
}

function remainingAfterFrozen(quota: PlayerQuota, frozen: FrozenBlock[]): number {
  return Math.max(0, quota.remainingMin - frozen.filter((block) => [...block.assignments.values()].includes(quota.player)).length);
}

export function redistributeDonors(
  quotas: QuotaAssignment,
  frozen: FrozenBlock[],
  required: number,
): { reductions: DonorReduction[]; failure?: LateArrivalFailure } {
  if (required <= 0) return { reductions: [] };
  const candidates = quotas.quotas
    .map((quota) => ({
      quota,
      remainingMin: remainingAfterFrozen(quota, frozen),
      headroom: Math.max(0, quota.remainingMax - quota.remainingMin),
    }))
    .filter(({ remainingMin }) => remainingMin > 0)
    .sort((left, right) => right.headroom - left.headroom || left.quota.player.localeCompare(right.quota.player));
  const reductions: DonorReduction[] = [];
  let left = required;
  for (const candidate of candidates) {
    if (!left) break;
    const amount = Math.min(left, candidate.headroom);
    if (!amount) continue;
    const before = candidate.quota.totalMax;
    candidate.quota.totalMax -= amount;
    candidate.quota.remainingMax = Math.max(candidate.quota.remainingMin, candidate.quota.remainingMax - amount);
    reductions.push({ player: candidate.quota.player, amount, before, after: candidate.quota.totalMax });
    left -= amount;
  }
  if (left) {
    const donor = candidates.find((candidate) => candidate.remainingMin > 0);
    return {
      reductions,
      failure: {
        kind: 'donor-below-minimum',
        player: donor?.quota.player,
        before: donor?.quota.totalMin,
        after: donor ? donor.quota.totalMin : undefined,
        errors: ['The arrival target would require a player to play below their minimum.'],
      },
    };
  }
  return { reductions };
}

function keeperFlex(quotas: QuotaAssignment): QuotaAssignment {
  const result = cloneQuotas(quotas);
  for (const quota of result.quotas) {
    if (quota.keeperBlocks > 0 && quota.keeperBlocks < quota.totalMax && quota.fieldMax > quota.fieldMin) {
      quota.fieldMin = Math.max(1, quota.fieldMin - 1);
      quota.fieldMax = Math.min(4, quota.fieldMax + 1);
      quota.totalMax += 1;
      quota.remainingMax += 1;
    }
  }
  return result;
}

function placementFailure(placement: PolishedPlacement): LateArrivalFailure {
  const text = placement.audit.errors.join(' ');
  return {
    kind: text.toLowerCase().includes('position') ? 'position-uncovered' : 'unfillable-within-maxes',
    errors: placement.audit.errors,
  };
}

export function replanLateArrival(input: LateArrivalReplanInput): LateArrivalReplanResult {
  const quotas = cloneQuotas(input.quotas);
  const arrival = input.game.lateArrival;
  if (!arrival) throw new Error('Late-arrival replan requires a late-arrival player.');
  const arrivalQuota = quotas.quotas.find((quota) => quota.player === arrival.player);
  if (!arrivalQuota) throw new Error(`Late-arrival player ${arrival.player} has no quota.`);
  const target = input.arrivalTarget ?? arrival.targetBlocks ?? arrivalQuota.totalMin;
  const targetDelta = target - arrivalQuota.totalMin;
  arrivalQuota.totalMin = target;
  arrivalQuota.totalMax = target;
  arrivalQuota.remainingMin = Math.max(0, target - input.frozen.filter((block) => [...block.assignments.values()].includes(arrival.player)).length);
  arrivalQuota.remainingMax = arrivalQuota.remainingMin;

  const required = Math.max(0, targetDelta);
  const donorResult = redistributeDonors(quotas, input.frozen, required);
  if (donorResult.failure) return { kind: 'failure', failure: donorResult.failure, quotas };

  let placement = runStages3And4(input.game, input.demand, quotas, input.frozen);
  let keeperFlexed = false;
  if (!placement.complete) {
    const flexed = keeperFlex(quotas);
    const retry = runStages3And4(input.game, input.demand, flexed, input.frozen);
    if (retry.complete) {
      placement = retry;
      keeperFlexed = true;
    }
  }
  if (!placement.complete) {
    return { kind: 'failure', failure: { ...placementFailure(placement), kind: 'late-arrival-exhausted', arrival: arrival.player }, quotas };
  }
  return { kind: 'success', placement, quotas, donorReductions: donorResult.reductions, keeperFlexed };
}

export interface TacticalSubstitution {
  block: number;
  outgoing: string;
  incoming: string;
  slot?: string;
}

export interface TacticalSubstitutionResult {
  placement: PolishedPlacement;
  actualTotals: Map<string, number>;
  changedBlocks: number[];
}

export function applyTacticalSubstitution(placement: PolishedPlacement, substitution: TacticalSubstitution): TacticalSubstitutionResult {
  const blocks = placement.blocks.map((block) => ({ ...block, assignments: new Map(block.assignments) }));
  const target = blocks.find((block) => block.block === substitution.block);
  if (!target) throw new Error(`Cannot substitute in missing block ${substitution.block}.`);
  const slot = substitution.slot ?? [...target.assignments].find(([, player]) => player === substitution.outgoing)?.[0];
  if (!slot || target.assignments.get(slot) !== substitution.outgoing) throw new Error(`Cannot substitute ${substitution.outgoing} in block ${substitution.block}.`);
  target.assignments.set(slot, substitution.incoming);
  const actualTotals = new Map<string, number>();
  for (const block of blocks) for (const player of block.assignments.values()) actualTotals.set(player, (actualTotals.get(player) ?? 0) + 1);
  return { placement: { ...placement, blocks }, actualTotals, changedBlocks: [substitution.block] };
}

export function hasFiveConsecutiveBlocks(blocks: PlacementBlock[], player: string, halfLength: number): boolean {
  for (let start = 0; start <= halfLength - 5; start += 1) {
    if (blocks.slice(start, start + 5).every((block) => [...block.assignments.values()].includes(player))) return true;
    if (blocks.slice(halfLength + start, halfLength + start + 5).every((block) => [...block.assignments.values()].includes(player))) return true;
  }
  return false;
}
