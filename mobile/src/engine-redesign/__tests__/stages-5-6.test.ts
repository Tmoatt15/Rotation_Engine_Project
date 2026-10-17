import { describe, expect, it } from 'vitest';
import { offerForFailure, offerForRelaxedMinimums, findTargetedRelaxation } from '../stage6';
import { applyTacticalSubstitution, hasFiveConsecutiveBlocks, redistributeDonors } from '../stage5';
import type { PlacementBlock } from '../stage3';
import type { PolishedPlacement } from '../stage4';
import type { QuotaAssignment } from '../model';

function placement(blocks: PlacementBlock[]): PolishedPlacement {
  return {
    blocks,
    complete: true,
    audit: { restPins: [], softRestFallback: false, outOfPositionBlocks: {}, errors: [] },
    metrics: { maxCoreBenches: 0, maxBoundaryTurnovers: 0, restWindowViolations: 0 },
  };
}

function quotas(): QuotaAssignment {
  return {
    fieldSlots: 4,
    goalkeeperSlots: 0,
    audit: { relaxedGroups: [], surplusAssignments: [], unfillableWithinMax: 0, underfill: [], overage: [] },
    quotas: [
      { player: 'A', group: 'core', totalMin: 2, totalMax: 4, pinnedBlocks: [], remainingMin: 2, remainingMax: 4, fieldMin: 2, fieldMax: 4, fieldTarget: 3, gkMin: 0, gkMax: 0, keeperBlocks: 0, history: { historicalFieldBlocks: 0, historicalGkBlocks: 0, historicalStarts: 0 } },
      { player: 'B', group: 'rotational', totalMin: 2, totalMax: 3, pinnedBlocks: [], remainingMin: 2, remainingMax: 3, fieldMin: 2, fieldMax: 3, fieldTarget: 2, gkMin: 0, gkMax: 0, keeperBlocks: 0, history: { historicalFieldBlocks: 0, historicalGkBlocks: 0, historicalStarts: 0 } },
      { player: 'C', group: 'rotational', totalMin: 2, totalMax: 5, pinnedBlocks: [], remainingMin: 2, remainingMax: 5, fieldMin: 2, fieldMax: 5, fieldTarget: 3, gkMin: 0, gkMax: 0, keeperBlocks: 0, history: { historicalFieldBlocks: 0, historicalGkBlocks: 0, historicalStarts: 0 } },
    ],
  };
}

describe('redesign stages 5-6', () => {
  it('offers relaxed minimum consent with only players below their hard floor', () => {
    const assignment = quotas();
    assignment.audit.relaxedPlayers = [
      { player: 'A', group: 'core', before: 4, after: 3, belowHardFloor: true },
      { player: 'B', group: 'rotational', before: 5, after: 4, belowHardFloor: false },
    ];

    const offer = offerForRelaxedMinimums(assignment);

    expect(offer.kind).toBe('relaxed-minimums');
    expect(offer.message).toContain('A (4→3 blocks)');
    expect(offer.message).not.toContain('B');
    expect(offer.buttons).toEqual([
      { label: 'Generate', action: 'allow-relaxed' },
      { label: 'Cancel', action: 'cancel' },
    ]);
  });

  it('redistributes whole donor blocks by headroom without changing the frozen prefix', () => {
    const result = redistributeDonors(quotas(), [], 2);
    expect(result.reductions).toEqual([
      { player: 'C', amount: 1, before: 5, after: 4 },
      { player: 'A', amount: 1, before: 4, after: 3 },
    ]);
    expect(result.failure).toBeUndefined();
  });

  it('keeps a donor who already met minimum eligible after the frozen prefix', () => {
    const result = redistributeDonors(quotas(), [
      { block: 1, assignments: new Map([['M1', 'B']]) },
      { block: 2, assignments: new Map([['M1', 'B']]) },
    ], 1);
    expect(result.reductions[0].player).toBe('C');
  });

  it('applies a tactical substitution only to the current block and records actual totals', () => {
    const result = applyTacticalSubstitution(placement([
      { block: 1, assignments: new Map([['M1', 'A']]) },
      { block: 2, assignments: new Map([['M1', 'A']]) },
    ]), { block: 1, outgoing: 'A', incoming: 'B' });
    expect([...result.placement.blocks[0].assignments.values()]).toEqual(['B']);
    expect([...result.placement.blocks[1].assignments.values()]).toEqual(['A']);
    expect(result.actualTotals).toEqual(new Map([['B', 1], ['A', 1]]));
  });

  it('detects five consecutive blocks within either half', () => {
    const blocks = Array.from({ length: 10 }, (_, index) => ({ block: index + 1, assignments: new Map([['M1', index < 5 ? 'A' : 'B']]) }));
    expect(hasFiveConsecutiveBlocks(blocks, 'A', 5)).toBe(true);
    expect(hasFiveConsecutiveBlocks(blocks, 'B', 5)).toBe(true);
  });

  it('finds a minimal two-player targeted relaxation before broad limit-off', () => {
    const result = findTargetedRelaxation(quotas(), (candidate) => candidate.quotas.some((quota) => quota.player === 'A' && quota.totalMax > 4)
      && candidate.quotas.some((quota) => quota.player === 'B' && quota.totalMax > 3));
    expect(result?.entries).toHaveLength(2);
    expect(result?.offer.kind).toBe('targeted-relaxation');
    expect(result?.offer.buttons.map((button) => button.label)).toEqual(['Cancel', 'Allow']);
  });

  it('searches trios when no one-player or pair exception is sufficient', () => {
    const result = findTargetedRelaxation(quotas(), (candidate) => candidate.quotas.some((quota) => quota.player === 'A' && quota.totalMax > 4)
      && candidate.quotas.some((quota) => quota.player === 'B' && quota.totalMax > 3)
      && candidate.quotas.some((quota) => quota.player === 'C' && quota.totalMax > 5));
    expect(result?.entries).toHaveLength(3);
  });

  it('uses plain coach language for the below-minimum offer', () => {
    const offer = offerForFailure({ kind: 'donor-below-minimum', arrival: 'Arrival', player: 'A', before: 4, after: 3, errors: [] });
    expect(offer.message).toBe('Adding Arrival would drop A below minimum (4→3 blocks).');
    expect(offer.buttons.map((button) => button.action)).toEqual(['cancel', 'continue']);
  });

  it('includes position and candidate details in capacity and half offers', () => {
    const capacity = offerForFailure({
      kind: 'position-uncovered',
      position: 'defense',
      candidates: ['A', 'B'],
      errors: [],
    });
    expect(capacity.message).toContain('defense: A, B');
    const half = offerForFailure({
      kind: 'late-arrival-exhausted',
      recommended: 'A',
      candidates: ['A', 'B'],
      errors: [],
    });
    expect(half.context).toEqual(expect.objectContaining({ recommended: 'A', candidates: ['A', 'B'] }));
  });

  it('offers explicit approval for a five-block run and carries the valid placement', () => {
    const validPlacement = placement([{ block: 1, assignments: new Map([['M1', 'A']]) }]);
    const offer = offerForFailure({
      kind: 'never-five-violation',
      player: 'A',
      half: 'first',
      placement: validPlacement,
      errors: [],
    });
    expect(offer.kind).toBe('never-five-violation');
    expect(offer.message).toBe('A would play 5 blocks in a row in the first half. Is that OK?');
    expect(offer.buttons.map((button) => button.label)).toEqual(['Cancel', 'Allow']);
    expect(offer.context.placement).toBe(validPlacement);
  });
});
