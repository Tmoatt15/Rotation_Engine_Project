import type { DemandModel, NormalizedGame, QuotaAssignment, PlayerQuota } from './model';
import { runStages3And4 } from './stage4';
import type { FrozenBlock, PlacementBlock } from './stage3';
import type { PolishedPlacement } from './stage4';
import { missingHalfParticipation } from './half-participation';
export { missingHalfParticipation } from './half-participation';

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
  kind: 'donor-below-minimum' | 'unfillable-within-maxes' | 'position-uncovered' | 'late-arrival-exhausted' | 'never-five-violation';
  arrival?: string;
  player?: string;
  before?: number;
  after?: number;
  position?: string;
  candidates?: string[];
  recommended?: string;
  half?: 'first' | 'second';
  placement?: PolishedPlacement;
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
      ...(quotas.audit.warnings ? { warnings: [...quotas.audit.warnings] } : {}),
    },
  };
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
      remainingMin: Math.max(0, quota.remainingMin - frozen.filter((block) => [...block.assignments.values()].includes(quota.player)).length),
      remainingMax: Math.max(0, quota.remainingMax - frozen.filter((block) => [...block.assignments.values()].includes(quota.player)).length),
    }))
    .map((candidate) => ({ ...candidate, headroom: Math.max(0, candidate.remainingMax - candidate.remainingMin) }))
    .filter(({ headroom }) => headroom > 0)
    .sort((left, right) => right.headroom - left.headroom || left.quota.player.localeCompare(right.quota.player));
  const reductions: DonorReduction[] = [];
  let left = required;
  while (left && candidates.some((candidate) => candidate.headroom > 0)) {
    for (const candidate of candidates) {
      if (!left || candidate.headroom <= 0) break;
      const before = candidate.quota.totalMax;
      candidate.quota.totalMax -= 1;
      candidate.quota.remainingMax = Math.max(candidate.quota.remainingMin, candidate.quota.remainingMax - 1);
      candidate.headroom -= 1;
      const existing = reductions.find((reduction) => reduction.player === candidate.quota.player);
      if (existing) {
        existing.amount += 1;
        existing.after = candidate.quota.totalMax;
      } else {
        reductions.push({ player: candidate.quota.player, amount: 1, before, after: candidate.quota.totalMax });
      }
      left -= 1;
    }
  }
  if (left) {
    const donor = candidates[0];
    return {
      reductions,
      failure: {
        kind: 'donor-below-minimum',
        player: donor?.quota.player,
        before: donor?.quota.totalMin,
        after: donor ? donor.quota.totalMin - 1 : undefined,
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
      quota.totalMax = quota.fieldMax + quota.keeperBlocks + quota.pinnedBlocks.length;
      quota.remainingMax = Math.max(0, quota.totalMax - quota.pinnedBlocks.length);
    }
  }
  return result;
}

function placementFailure(placement: PolishedPlacement, game: NormalizedGame, quotas: QuotaAssignment): LateArrivalFailure {
  const text = placement.audit.errors.join(' ');
  const candidates = game.players
    .filter((player) => player.available && !player.keeper)
    .sort((left, right) => {
      const leftQuota = quotas.quotas.find((quota) => quota.player === left.name);
      const rightQuota = quotas.quotas.find((quota) => quota.player === right.name);
      const leftHeadroom = leftQuota ? leftQuota.remainingMax - leftQuota.remainingMin : 0;
      const rightHeadroom = rightQuota ? rightQuota.remainingMax - rightQuota.remainingMin : 0;
      return rightHeadroom - leftHeadroom || left.name.localeCompare(right.name);
    })
    .map((player) => player.name);
  return {
    kind: text.toLowerCase().includes('position') ? 'position-uncovered' : 'unfillable-within-maxes',
    position: text.match(/\b(D|M|F|GK)\b/)?.[1],
    candidates,
    recommended: candidates[0],
    errors: placement.audit.errors,
  };
}

export function replanLateArrival(input: LateArrivalReplanInput): LateArrivalReplanResult {
  const quotas = cloneQuotas(input.quotas);
  const arrival = input.game.lateArrival;
  if (!arrival) throw new Error('Late-arrival replan requires a late-arrival player.');
  const arrivalQuota = quotas.quotas.find((quota) => quota.player === arrival.player);
  if (!arrivalQuota) throw new Error(`Late-arrival player ${arrival.player} has no quota.`);
  const target = arrivalQuota.totalMin;
  const targetDelta = 0;
  arrivalQuota.totalMin = target;
  arrivalQuota.totalMax = target;
  arrivalQuota.remainingMin = Math.max(0, target - input.frozen.filter((block) => [...block.assignments.values()].includes(arrival.player)).length);
  arrivalQuota.remainingMax = arrivalQuota.remainingMin;

  const futureSlots = input.demand.slotsPerBlock * (input.game.totalBlocks - input.frozen.length);
  const remainingMinimum = quotas.quotas.reduce((sum, quota) => sum + Math.max(0, quota.remainingMin - input.frozen.filter((block) => [...block.assignments.values()].includes(quota.player)).length), 0);
  const required = Math.max(0, targetDelta, remainingMinimum - futureSlots);
  const donorResult = redistributeDonors(quotas, input.frozen, required);
  if (donorResult.failure) return { kind: 'failure', failure: { ...donorResult.failure, arrival: arrival.player }, quotas };

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
    const failure = { ...placementFailure(placement, input.game, quotas), kind: 'late-arrival-exhausted' as const, arrival: arrival.player };
    const halfLength = input.game.totalBlocks / 2;
    if (failure.candidates?.some((player) => hasFiveConsecutiveBlocks(placement.blocks, player, halfLength))) {
      failure.errors = [...failure.errors, 'A player would be scheduled for five consecutive blocks without approval.'];
    }
    return { kind: 'failure', failure, quotas };
  }
  if (wholeHalfPlayer(placement.blocks, input.game.players.map((player) => player.name), input.game.totalBlocks)) {
    const retryDeadline = Date.now() + 500;
    const retry = runStages3And4(input.game, input.demand, quotas, input.frozen, retryDeadline);
    if (retry.complete && !wholeHalfPlayer(retry.blocks, input.game.players.map((player) => player.name), input.game.totalBlocks)) {
      placement = retry;
    }
  }
  const halfParticipationFailure = missingHalfParticipation(placement.blocks, input.game.players, input.game.totalBlocks, input.game.firstHalfKeeper, input.game.secondHalfKeeper, arrival);
  if (halfParticipationFailure) {
    return {
      kind: 'failure',
      failure: {
        kind: 'late-arrival-exhausted',
        player: halfParticipationFailure,
        placement,
        arrival: arrival.player,
        errors: [`${halfParticipationFailure} must play at least one block in each eligible half. Add an eligible player or adjust the roster before regenerating.`],
      },
      quotas,
    };
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

function wholeHalfPlayer(blocks: PlacementBlock[], players: string[], totalBlocks: number): string | undefined {
  const halfLength = totalBlocks / 2;
  return players.find((player) =>
    blocks.slice(0, halfLength).every((block) => [...block.assignments.values()].includes(player))
    || blocks.slice(halfLength).every((block) => [...block.assignments.values()].includes(player)));
}
