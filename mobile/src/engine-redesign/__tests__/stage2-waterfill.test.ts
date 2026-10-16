import { describe, expect, it } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame } from '..';
import type { FieldGroup, RedesignGameInput, RedesignPlayerInput } from '../model';

const chelseaRoster: RedesignPlayerInput[] = [
  { name: 'Avery', group: 'rotational', general_positions: ['M'], primary_positions: ['M'], keeper: true, keeper_eligible: true },
  { name: 'Brooklyn', group: 'core', general_positions: ['M'], primary_positions: ['CM'], backup_positions: ['D'], keeper_eligible: true },
  { name: 'Dolce', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] },
  { name: 'Emma', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'] },
  { name: 'Kelsey', group: 'core', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['D'] },
  { name: 'Maddie', group: 'core', general_positions: ['F'], primary_positions: ['RF'], keeper: true, keeper_eligible: true },
  { name: 'Madelyn', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'], backup_positions: ['F'] },
  { name: 'Meg', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M'] },
  { name: 'Natalie', group: 'rotational', general_positions: ['D'], primary_positions: ['LB'] },
  { name: 'Rachel', group: 'rotational', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
  { name: 'Reese', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
  { name: 'Selma', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] },
  { name: 'Sophia', group: 'core', general_positions: ['D'], primary_positions: ['CB'] },
];

function quotasFor(totalBlocks: number, seasonRotation = {}) {
  const game = normalizeGame({
    format: '9v9',
    formation: '3-3-2',
    totalBlocks,
    firstHalfKeeper: 'Maddie',
    secondHalfKeeper: 'Avery',
    seasonRotation,
  }, chelseaRoster);
  const demand = buildDemandModel(game);
  return { game, demand, quotas: assignQuotas(game, demand) };
}

function groupCounts(
  quotas: ReturnType<typeof assignQuotas>,
  roster: RedesignPlayerInput[],
): Map<string, Record<FieldGroup, number>> {
  const primaryGroup = new Map(roster.map((player) => [
    player.name,
    player.general_positions?.[0] as FieldGroup,
  ]));
  return new Map(quotas.quotas.map((quota) => {
    const counts: Record<FieldGroup, number> = {
      D: quota.groupTargets?.D ?? 0,
      M: quota.groupTargets?.M ?? 0,
      F: quota.groupTargets?.F ?? 0,
    };
    const pinnedGroup = primaryGroup.get(quota.player);
    if (pinnedGroup) counts[pinnedGroup] += quota.pinnedBlocks.length;
    return [quota.player, counts];
  }));
}

describe('Stage 2 per-group water-fill', () => {
  it.each([
    [8, {
      F: { Kelsey: 4, Emma: 5, Rachel: 4, Maddie: 3 },
      M: { Avery: 2, Brooklyn: 6, Madelyn: 5, Reese: 5, Selma: 5, Rachel: 1 },
      D: { Sophia: 6, Kelsey: 2 },
    }],
    [10, {
      F: { Kelsey: 5, Emma: 6, Rachel: 5, Maddie: 4 },
      M: { Avery: 4, Brooklyn: 7, Madelyn: 6, Reese: 6, Selma: 6, Rachel: 1 },
      D: { Sophia: 8, Dolce: 7, Meg: 7, Natalie: 6, Kelsey: 2 },
    }],
    [12, {
      F: { Kelsey: 6, Emma: 7, Rachel: 6, Maddie: 5 },
      M: { Avery: 5, Brooklyn: 9, Rachel: 1 },
      D: { Sophia: 10, Kelsey: 2 },
    }],
  ])('matches Chelsea water-fill targets for %i blocks', (totalBlocks, expected) => {
    const { demand, quotas } = quotasFor(totalBlocks);
    const counts = groupCounts(quotas, chelseaRoster);
    expect(quotas.audit.errors).toEqual([]);
    for (const group of ['D', 'M', 'F'] as const) {
      const groupSum = [...counts.values()].reduce((sum, playerCounts) => sum + playerCounts[group], 0);
      expect(groupSum).toBe(demand.fieldSlots.filter((slot) => slot.group === group).length * totalBlocks);
      for (const [name, count] of Object.entries(expected[group] ?? {})) {
        expect(counts.get(name)?.[group]).toBe(count);
      }
    }
    if (totalBlocks === 8) {
      const defenderRotations = ['Dolce', 'Meg', 'Natalie'].map((name) => counts.get(name)!.D).sort();
      expect(defenderRotations).toEqual([5, 5, 6]);
    }
    if (totalBlocks === 12) {
      const midfieldRotations = ['Madelyn', 'Reese', 'Selma'].map((name) => counts.get(name)!.M).sort();
      const defenderRotations = ['Dolce', 'Meg', 'Natalie'].map((name) => counts.get(name)!.D).sort();
      expect(midfieldRotations).toEqual([7, 7, 7]);
      expect(counts.get('Sophia')!.D).toBe(10);
      expect(defenderRotations).toEqual([8, 8, 8]);
      expect([...counts.values()].reduce((sum, playerCounts) => sum + playerCounts.D, 0)).toBe(36);
      for (const quota of quotas.quotas.filter((entry) => entry.player !== 'Avery' && entry.player !== 'Maddie')) {
        const totalFieldBlocks = Object.values(counts.get(quota.player)!).reduce((sum, value) => sum + value, 0);
        const max = Math.round(totalBlocks * (quota.group === 'core' ? 0.8 : quota.group === 'rotational' ? 0.7 : 0.6));
        expect(totalFieldBlocks).toBeLessThanOrEqual(max);
      }
    }
  });

  it('uses half-up rounding for tier floors and band maxima', () => {
    const roster = [
      { name: 'Core', group: 'core', general_positions: ['M'] },
      { name: 'Rotational', group: 'rotational', general_positions: ['M'] },
      { name: 'Developing', group: 'developing', general_positions: ['M'] },
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    ] satisfies RedesignPlayerInput[];
    const game: RedesignGameInput = {
      format: '11v11', formation: '4-3-3', totalBlocks: 12,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    };
    const normalized = normalizeGame(game, roster);
    const quotas = assignQuotas(normalized, buildDemandModel(normalized));
    const core = quotas.quotas.find((quota) => quota.player === 'Core')!;
    expect(core.groupTargets).toBeDefined();
    expect(core.fieldMin + core.pinnedBlocks.length).toBe(8);
    expect(quotas.quotas.find((quota) => quota.player === 'Rotational')?.fieldMin).toBe(7);
    expect(quotas.quotas.find((quota) => quota.player === 'Developing')?.fieldMin).toBe(6);
  });

  it('rotates a same-tier shed to a different player on the next game', () => {
    const first = quotasFor(8);
    const rotationKey = 'D:rotational' as const;
    const lastGained = first.quotas.rotationState?.[rotationKey]?.lastGained;
    expect(lastGained).toBeDefined();

    const next = quotasFor(8, { [rotationKey]: { lastGained } });
    expect(next.quotas.rotationState?.[rotationKey]?.lastGained).not.toBe(lastGained);
  });

  it('retains rotation tiebreaks when quotas are recalculated for a late arrival', () => {
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Maddie',
      secondHalfKeeper: 'Avery',
      lateArrival: { player: 'Emma', arrivalBlock: 7, targetBlocks: 2 },
      seasonRotation: { 'D:rotational': { lastGained: 'Dolce' } },
    }, chelseaRoster);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.rotationState?.['D:rotational']?.lastGained).not.toBe('Dolce');
  });

  it('reports a named underfilled group when no backup can cover it', () => {
    const game = normalizeGame({
      format: '4v4', formation: '1-2-1', totalBlocks: 6,
      firstHalfKeeper: null, secondHalfKeeper: null,
    }, [
      { name: 'Forward', group: 'core', general_positions: ['F'] },
      { name: 'Defender', group: 'core', general_positions: ['D'] },
    ]);
    const quotas = assignQuotas(game, buildDemandModel(game));
    expect(quotas.audit.errors?.some((error) => error.includes('Midfield group (M) is short'))).toBe(true);
  });

  it('does not overfill a six-block group or exceed any field-player band maximum', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        name: `Core D${index + 1}`, group: 'core' as const, general_positions: ['D'],
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core M${index + 1}`, group: 'core' as const, general_positions: ['M'],
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        name: `Core F${index + 1}`, group: 'core' as const, general_positions: ['F'],
      })),
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    ];
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 6,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    }, roster);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const counts = groupCounts(quotas, roster);
    const defenseTotal = [...counts.values()].reduce((sum, playerCounts) => sum + playerCounts.D, 0);

    expect(defenseTotal).toBeLessThanOrEqual(18);
    for (const quota of quotas.quotas) {
      const total = Object.values(counts.get(quota.player)!).reduce((sum, count) => sum + count, 0);
      expect(total).toBeLessThanOrEqual(Math.round(6 * (quota.group === 'core' ? 0.8 : quota.group === 'rotational' ? 0.7 : 0.6)));
    }
  });

  it('never reduces an abundance-hit core player below pinned endpoint blocks', () => {
    const roster: RedesignPlayerInput[] = Array.from({ length: 8 }, (_, index) => ({
      name: `Pinned D${index + 1}`, group: 'core', general_positions: ['D'],
    }));
    roster.push(
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    );
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 6,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    }, roster);
    const quotas = assignQuotas(game, buildDemandModel(game));
    const counts = groupCounts(quotas, roster);
    const abundanceHits = quotas.audit.relaxedPlayers ?? [];

    expect(abundanceHits.length).toBeGreaterThan(0);
    for (const hit of abundanceHits) {
      const quota = quotas.quotas.find((entry) => entry.player === hit.player)!;
      expect(quota.totalMin).toBeGreaterThanOrEqual(quota.pinnedBlocks.length);
    }

    for (const quota of quotas.quotas) {
      expect(Object.values(counts.get(quota.player)!).reduce((sum, value) => sum + value, 0))
        .toBeGreaterThanOrEqual(quota.pinnedBlocks.length);
    }
    for (const group of ['D', 'M', 'F'] as const) {
      expect([...counts.values()].reduce((sum, playerCounts) => sum + playerCounts[group], 0))
        .toBeLessThanOrEqual(game.totalBlocks * game.formation.split('-').map(Number)[['D', 'M', 'F'].indexOf(group)]);
    }
  });

  it('collapses multiple abundance hits into one before/after entry per player', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        name: `Core D${index + 1}`, group: 'core' as const, general_positions: ['D'],
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `Core M${index + 1}`, group: 'core' as const, general_positions: ['M'],
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core F${index + 1}`, group: 'core' as const, general_positions: ['F'],
      })),
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    ];
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 6,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    }, roster);
    const quotas = assignQuotas(game, buildDemandModel(game));
    const hits = quotas.audit.relaxedPlayers ?? [];

    expect(quotas.audit.errors).toEqual([]);
    expect(new Set(hits.map((hit) => hit.player)).size).toBe(hits.length);
    expect(hits.find((hit) => hit.player === 'Core D1')).toEqual({
      player: 'Core D1', group: 'core', before: 4, after: 2,
    });
  });

  it('reports unresolved overfull groups when only keepers or pinned allocations remain', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        name: `Core D${index + 1}`, group: 'core' as const, general_positions: ['D'],
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `Core M${index + 1}`, group: 'core' as const, general_positions: ['M'],
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core F${index + 1}`, group: 'core' as const, general_positions: ['F'],
      })),
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    ];
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 6,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    }, roster);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.audit.errors).toContain(
      'D group is over by 2 block(s); no non-keeper allocation remains above its endpoint pins to shed.',
    );
  });

  it('keeps selected keepers in their primary group instead of flexing them', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core M${index + 1}`, group: 'core' as const, general_positions: ['M'],
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        name: `Rot M${index + 1}`, group: 'rotational' as const, general_positions: ['M'],
      })),
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], backup_positions: ['D'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], backup_positions: ['D'], keeper: true, keeper_eligible: true },
      { name: 'Defender', group: 'core', general_positions: ['D'] },
      { name: 'Forward', group: 'core', general_positions: ['F'] },
    ];
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 6,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    }, roster);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.quotas.find((quota) => quota.player === 'Keeper A')?.groupTargets?.D).toBe(0);
    expect(quotas.quotas.find((quota) => quota.player === 'Keeper B')?.groupTargets?.D).toBe(0);
  });
});
