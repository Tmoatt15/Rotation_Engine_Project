import { describe, expect, it } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '..';
import type { FieldGroup, RedesignGameInput, RedesignPlayerInput } from '../model';
import { orderRerouteMovers } from '../stage2';

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
  it.each([6, 8, 10, 12])('preserves Chelsea group capacity and floors for %i blocks', (totalBlocks) => {
    const { demand, quotas } = quotasFor(totalBlocks);
    const counts = groupCounts(quotas, chelseaRoster);
    expect(quotas.audit.errors).toEqual([]);
    for (const group of ['D', 'M', 'F'] as const) {
      const groupSum = [...counts.values()].reduce((sum, playerCounts) => sum + playerCounts[group], 0);
      expect(groupSum).toBe(demand.fieldSlots.filter((slot) => slot.group === group).length * totalBlocks);
    }
    for (const quota of quotas.quotas) {
      const totalFieldBlocks = Object.values(counts.get(quota.player)!).reduce((sum, value) => sum + value, 0);
      if (quota.keeperBlocks > 0) {
        expect(totalFieldBlocks).toBeLessThanOrEqual(totalBlocks / 2 - 1);
      } else {
        expect(totalFieldBlocks).toBeGreaterThanOrEqual(Math.ceil(totalBlocks * 0.4));
      }
      const maximum = Math.round(totalBlocks * (quota.group === 'core' ? 0.8 : quota.group === 'rotational' ? 0.7 : 0.6));
      if (quota.keeperBlocks === 0) expect(totalFieldBlocks).toBeLessThanOrEqual(maximum);
    }
    if (totalBlocks === 8) {
      expect(quotas.quotas.find((quota) => quota.player === 'Avery')?.fieldTarget).toBe(3);
    }
  });

  it('uses the 40% floor and 30% keeper floor', () => {
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
    expect(core.fieldMin + core.pinnedBlocks.length).toBe(5);
    expect(quotas.quotas.find((quota) => quota.player === 'Rotational')?.fieldMin).toBe(5);
    expect(quotas.quotas.find((quota) => quota.player === 'Developing')?.fieldMin).toBe(5);
    expect(quotas.quotas.find((quota) => quota.player === 'Keeper A')?.fieldMin).toBe(4);
    expect(quotas.quotas.find((quota) => quota.player === 'Keeper B')?.fieldMin).toBe(4);
  });

  it.each([
    [6, 2, 2],
    [8, 3, 3],
    [10, 4, 3],
    [12, 5, 4],
  ])('applies keeper field target/floor for %i blocks', (totalBlocks, target, floor) => {
    const { quotas } = quotasFor(totalBlocks);
    const rotationalKeeper = quotas.quotas.find((entry) => entry.player === 'Avery')!;
    const coreKeeper = quotas.quotas.find((entry) => entry.player === 'Maddie')!;
    const rotationalFieldTotal = rotationalKeeper.fieldTarget + rotationalKeeper.pinnedBlocks.length;
    const coreFieldTotal = coreKeeper.fieldTarget + coreKeeper.pinnedBlocks.length;
    expect(rotationalFieldTotal).toBeGreaterThanOrEqual(floor);
    expect(rotationalFieldTotal).toBeLessThanOrEqual(target);
    expect(rotationalKeeper.fieldMin + rotationalKeeper.pinnedBlocks.length).toBe(floor);
    expect(coreFieldTotal).toBe(target);
  });

  it('handles an all-core roster without relaxing its floor', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 4 }, (_, index) => ({ name: `Core D${index}`, group: 'core', general_positions: ['D'] })),
      ...Array.from({ length: 4 }, (_, index) => ({ name: `Core M${index}`, group: 'core', general_positions: ['M'] })),
      ...Array.from({ length: 3 }, (_, index) => ({ name: `Core F${index}`, group: 'core', general_positions: ['F'] })),
      { name: 'Dedicated keeper', group: 'rotational', general_positions: [], keeper: true, keeper_eligible: true },
    ];
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 8,
      firstHalfKeeper: 'Dedicated keeper', secondHalfKeeper: 'Dedicated keeper',
    }, roster);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.audit.errors).toEqual([]);
    expect(quotas.audit.warnings).toEqual([]);
    for (const quota of quotas.quotas.filter((entry) => entry.group === 'core')) {
      expect(quota.fieldTarget + quota.pinnedBlocks.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('reports a single-player group shortfall without creating invalid quotas', () => {
    const game = normalizeGame({
      format: '4v4', formation: '1-2-1', totalBlocks: 6,
      firstHalfKeeper: null, secondHalfKeeper: null,
    }, [
      { name: 'Only defender', group: 'core', general_positions: ['D'] },
      { name: 'Midfielder 1', group: 'core', general_positions: ['M'] },
      { name: 'Midfielder 2', group: 'core', general_positions: ['M'] },
      { name: 'Forward', group: 'core', general_positions: ['F'] },
    ]);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.audit.errors?.some((error) => error.includes('Defender group (D) is short 1'))).toBe(true);
    const defenderQuota = quotas.quotas.find((quota) => quota.player === 'Only defender')!;
    expect(defenderQuota.fieldTarget + defenderQuota.pinnedBlocks.length).toBe(5);
  });

  it('identifies a total-capacity shortfall that position backups cannot resolve', () => {
    const availablePlayerNames = chelseaRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const gameForRoster = (roster: RedesignPlayerInput[]) => normalizeGame({
        format: '9v9',
        formation: '3-3-2',
        totalBlocks: 8,
        firstHalfKeeper: 'Avery',
        secondHalfKeeper: 'Maddie',
        availablePlayerNames,
      }, roster);
    const quotasForRoster = (roster: RedesignPlayerInput[]) => {
      const game = gameForRoster(roster);
      return assignQuotas(game, buildDemandModel(game));
    };

    const before = quotasForRoster(chelseaRoster);
    const after = quotasForRoster(chelseaRoster.map((player) => player.name === 'Dolce'
      ? { ...player, backup_positions: [...(player.backup_positions ?? []), 'M'] }
      : player));

    expect(before.audit.underfill.map(({ group }) => group)).toContain('M');
    expect(before.audit.underfill.map(({ group }) => group)).toContain('F');
    expect(before.audit.maximumCapacityShortfall).toBe(4);
    expect(after.audit.maximumCapacityShortfall).toBe(4);
    expect(after.audit.underfill.map(({ group }) => group)).toContain('M');
    expect(after.audit.underfill.map(({ group }) => group)).toContain('F');

    const backedUpRoster = chelseaRoster.map((player) => player.name === 'Dolce'
      ? { ...player, backup_positions: [...(player.backup_positions ?? []), 'M'] }
      : player);
    const game = gameForRoster(backedUpRoster);
    const demand = buildDemandModel(game);
    const relaxed = assignQuotas(game, demand, false, true);

    expect(relaxed.audit.errors).toEqual([]);
    expect(relaxed.audit.maximumCapacityShortfall).toBe(4);
    expect(relaxed.audit.relaxedMaximums?.length).toBeGreaterThan(0);
    expect(runStages3And4(game, demand, relaxed).complete).toBe(true);
  });

  it('keeps relaxed playing time balanced with or without an extra midfield backup', () => {
    const availablePlayerNames = chelseaRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const rosterWithMidfieldBackup = chelseaRoster.map((player) => player.name === 'Dolce'
      ? { ...player, backup_positions: [...(player.backup_positions ?? []), 'M'] }
      : player);
    const createProfile = (roster: RedesignPlayerInput[]) => {
      const game = normalizeGame({
        format: '9v9',
        formation: '3-3-2',
        totalBlocks: 8,
        availablePlayerNames,
        firstHalfKeeper: 'Avery',
        secondHalfKeeper: 'Maddie',
      }, roster);
      const demand = buildDemandModel(game);
      const quotas = assignQuotas(game, demand, true, true);
      const placement = runStages3And4(game, demand, quotas);
      const loads = new Map(game.players.filter((player) => player.available).map((player) => [player.name, 0]));
      for (const block of placement.blocks) {
        for (const player of block.assignments.values()) {
          loads.set(player, (loads.get(player) ?? 0) + 1);
        }
      }
      for (const quota of quotas.quotas) {
        loads.set(quota.player, (loads.get(quota.player) ?? 0) + quota.keeperBlocks);
      }
      const values = [...loads.values()];
      return {
        complete: placement.complete,
        spread: Math.max(...values) - Math.min(...values),
      };
    };

    const baseline = createProfile(chelseaRoster);
    const withBackup = createProfile(rosterWithMidfieldBackup);

    expect(baseline.complete).toBe(true);
    expect(withBackup.complete).toBe(true);
    expect(baseline.spread).toBeLessThanOrEqual(2);
    expect(withBackup.spread).toBeLessThanOrEqual(2);
    expect(withBackup.spread).toBeLessThanOrEqual(baseline.spread);
  });

  it('balances the Chelsea roster when maximums are relaxed', () => {
    const availablePlayerNames = chelseaRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      availablePlayerNames,
      firstHalfKeeper: 'Maddie',
      secondHalfKeeper: 'Avery',
    }, chelseaRoster);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand, true, true);
    const nonKeeperFieldBlocks = quotas.quotas
      .filter((quota) => quota.keeperBlocks === 0)
      .map((quota) => quota.fieldTarget + quota.pinnedBlocks.length);
    const placement = runStages3And4(game, demand, quotas);
    const quotasByPlayer = new Map(quotas.quotas.map((quota) => [quota.player, quota]));
    const placedNonKeeperFieldBlocks = game.players
      .filter((player) => player.available && (quotasByPlayer.get(player.name)?.keeperBlocks ?? 0) === 0)
      .map((player) => placement.blocks.filter((block) => [...block.assignments.values()].includes(player.name)).length);
    const placedKeeperFieldBlocks = game.players
      .filter((player) => (quotasByPlayer.get(player.name)?.keeperBlocks ?? 0) > 0)
      .map((player) => placement.blocks.filter((block) => [...block.assignments.values()].includes(player.name)).length);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete).toBe(true);
    expect(placedKeeperFieldBlocks).toEqual([3, 3]);
    expect(Math.max(...nonKeeperFieldBlocks)).toBeLessThanOrEqual(7);
    expect(Math.max(...nonKeeperFieldBlocks) - Math.min(...nonKeeperFieldBlocks)).toBeLessThanOrEqual(2);
    expect(Math.max(...placedNonKeeperFieldBlocks)).toBeLessThanOrEqual(7);
    expect(Math.max(...placedNonKeeperFieldBlocks)).toBe(7);
    expect(Math.min(...placedNonKeeperFieldBlocks)).toBe(6);
    expect(Math.max(...placedNonKeeperFieldBlocks) - Math.min(...placedNonKeeperFieldBlocks)).toBe(1);
  });

  it.each([
    ['baseline', chelseaRoster],
    ['Dolce M backup', chelseaRoster.map((player) => player.name === 'Dolce'
      ? { ...player, backup_positions: ['M'] }
      : player)],
    ['Natalie M backup', chelseaRoster.map((player) => player.name === 'Natalie'
      ? { ...player, backup_positions: ['M'] }
      : player)],
  ])('places only Stage 2 group targets for the %s scenario', (scenario, roster) => {
    const availablePlayerNames = roster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      availablePlayerNames,
      firstHalfKeeper: 'Maddie',
      secondHalfKeeper: 'Avery',
    }, roster);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand, true, true);
    const placement = runStages3And4(game, demand, quotas);
    const misplaced = placement.audit.plannedVsPlaced?.filter((entry) => entry.difference !== 0);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete).toBe(true);
    expect(misplaced).toEqual([]);
    if (scenario === 'Dolce M backup') {
      const dolce = placement.audit.plannedVsPlaced?.filter((entry) => entry.player === 'Dolce');
      expect(dolce?.find((entry) => entry.group === 'D')?.placed).toBe(6);
      expect(dolce?.find((entry) => entry.group === 'M')?.placed).toBe(1);
    }
    if (scenario === 'Natalie M backup') {
      expect(placement.audit.plannedVsPlaced?.find((entry) =>
        entry.player === 'Natalie' && entry.group === 'M')?.placed).toBeGreaterThan(0);
    }
  });

  it.each(['Dolce', 'Meg', 'Natalie', 'Sophia'])(
    'completes relaxed Chelsea generation when %s is absent',
    (absentPlayer) => {
      const availablePlayerNames = chelseaRoster
        .filter((player) => player.name !== absentPlayer)
        .map((player) => player.name);
      const game = normalizeGame({
        format: '9v9',
        formation: '3-3-2',
        totalBlocks: 8,
        availablePlayerNames,
        firstHalfKeeper: 'Maddie',
        secondHalfKeeper: 'Avery',
      }, chelseaRoster);
      const demand = buildDemandModel(game);
      const quotas = assignQuotas(game, demand, true, true);
      const placement = runStages3And4(game, demand, quotas);

      expect(quotas.audit.relaxedEqualization).toBeDefined();
      expect(placement.complete).toBe(true);
    },
  );

  it('audits a soft guardrail relaxation while preserving the 40% floor', () => {
  });

  it('audits a soft guardrail relaxation while preserving the 40% floor', () => {
    const game = normalizeGame({
      format: '4v4', formation: '1-2-1', totalBlocks: 8,
      firstHalfKeeper: null, secondHalfKeeper: null,
    }, [
      { name: 'Core D1', group: 'core', general_positions: ['D'] },
      { name: 'Core D2', group: 'core', general_positions: ['D'] },
      { name: 'Rot M1', group: 'rotational', general_positions: ['M'] },
      { name: 'Rot M2', group: 'rotational', general_positions: ['M'] },
    ]);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.audit.warnings?.some((warning) => warning.includes('soft tier guardrail'))).toBe(true);
    for (const quota of quotas.quotas.filter((entry) => entry.keeperBlocks === 0)) {
      expect(quota.fieldTarget + quota.pinnedBlocks.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('rotates a same-tier shed to a different player on the next game', () => {
    const roster: RedesignPlayerInput[] = Array.from({ length: 5 }, (_, index) => ({
      name: `Rotation ${index + 1}`,
      group: 'rotational',
      general_positions: ['D'],
    }));
    roster.push(
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    );
    const createQuotas = (seasonRotation = {}) => {
      const game = normalizeGame({
        format: '9v9', formation: '3-3-2', totalBlocks: 8,
        firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B', seasonRotation,
      }, roster);
      return assignQuotas(game, buildDemandModel(game));
    };
    const first = createQuotas();
    const rotationKey = 'D:rotational' as const;
    const firstHit = first.audit.relaxedPlayers?.[0]?.player;
    expect(firstHit).toBeDefined();

    const next = createQuotas({ [rotationKey]: { lastShed: firstHit } });
    expect(next.audit.relaxedPlayers?.[0]?.player).not.toBe(firstHit);
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

    expect(quotas.rotationState?.['D:rotational']?.lastGained).toBe('Dolce');
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

  it('keeps the hard floor and reports a group that cannot shed to capacity', () => {
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

    expect(defenseTotal).toBe(24);
    expect(quotas.audit.errors?.some((error) => error.includes('Defender group (D) is over by 6'))).toBe(true);
    for (const quota of quotas.quotas) {
      const total = Object.values(counts.get(quota.player)!).reduce((sum, count) => sum + count, 0);
      if (quota.keeperBlocks === 0) expect(total).toBeGreaterThanOrEqual(3);
    }
  });

  it('never reduces an abundance-hit core player below pinned endpoint blocks', () => {
    const roster: RedesignPlayerInput[] = Array.from({ length: 5 }, (_, index) => ({
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
    expect([...counts.values()].reduce((sum, playerCounts) => sum + playerCounts.D, 0)).toBe(18);
  });

  it('collapses multiple abundance hits into one before/after entry per player', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `Core D${index + 1}`, group: 'core' as const, general_positions: ['D'],
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core M${index + 1}`, group: 'core' as const, general_positions: ['M'],
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        name: `Core F${index + 1}`, group: 'core' as const, general_positions: ['F'],
      })),
      { name: 'Keeper A', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
      { name: 'Keeper B', group: 'rotational', general_positions: ['M'], keeper: true, keeper_eligible: true },
    ];
    const game = normalizeGame({
      format: '9v9', formation: '3-3-2', totalBlocks: 8,
      firstHalfKeeper: 'Keeper A', secondHalfKeeper: 'Keeper B',
    }, roster);
    const quotas = assignQuotas(game, buildDemandModel(game));
    const hits = quotas.audit.relaxedPlayers ?? [];

    expect(quotas.audit.errors).toEqual([]);
    expect(new Set(hits.map((hit) => hit.player)).size).toBe(hits.length);
    expect(hits.some((hit) => hit.group === 'core' && hit.before - hit.after > 1)).toBe(true);
  });

  it('reports unresolved overfull groups when only keepers or pinned allocations remain', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 7 }, (_, index) => ({
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

    expect(quotas.audit.overage).toContainEqual({ group: 'D', blocks: 3 });
    expect(quotas.audit.errors?.some((error) =>
      error.includes('Defender group (D) is over by 3')
      && error.includes('backup to')
      && error.includes('or move'))).toBe(true);
  });

  it('relaxes overage-group floors one block at a time with explicit below-floor audit entries', () => {
    const roster: RedesignPlayerInput[] = [
      ...Array.from({ length: 7 }, (_, index) => ({
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
    const demand = buildDemandModel(game);
    const strict = assignQuotas(game, demand);
    const relaxed = assignQuotas(game, demand, true);

    expect(strict.audit.overage).toContainEqual({ group: 'D', blocks: 3 });
    expect(relaxed.audit.errors).toEqual([]);
    expect(relaxed.audit.overage).toEqual([]);
    expect(relaxed.audit.relaxedPlayers?.filter((entry) => entry.belowHardFloor).length).toBeGreaterThan(0);
    expect(relaxed.audit.relaxedGroups).toContainEqual({ group: 'core', amount: 3 });
  });

  it('rejects a roster whose hard 40% floors exceed all field slots', () => {
    const game = normalizeGame({
      format: '4v4', formation: '1-2-1', totalBlocks: 6,
      firstHalfKeeper: null, secondHalfKeeper: null,
    }, [
      ...Array.from({ length: 3 }, (_, index) => ({ name: `D${index}`, group: 'core', general_positions: ['D'] })),
      ...Array.from({ length: 3 }, (_, index) => ({ name: `M${index}`, group: 'core', general_positions: ['M'] })),
      ...Array.from({ length: 3 }, (_, index) => ({ name: `F${index}`, group: 'core', general_positions: ['F'] })),
    ]);
    const quotas = assignQuotas(game, buildDemandModel(game));

    expect(quotas.audit.errors?.[0]).toBe('Roster too large for 40% minimum playing time. Maximum 8 field players for 6 blocks.');
    expect(quotas.audit.rosterTooLarge).toEqual({ maxPlayers: 8 });
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

describe('Stage 2 reroute mover ordering', () => {
  const roster = [
    { name: 'Home', group: 'developing', general_positions: ['F'] },
    { name: 'Core backup', group: 'core', general_positions: ['M'], backup_positions: ['F'] },
    { name: 'Rotational A', group: 'rotational', general_positions: ['M'], backup_positions: ['F'] },
    { name: 'Rotational B', group: 'rotational', general_positions: ['D'], backup_positions: ['F'] },
    { name: 'Developing backup', group: 'developing', general_positions: ['D'], backup_positions: ['F'] },
  ] satisfies RedesignPlayerInput[];
  const game = normalizeGame({
    format: '4v4', formation: '1-2-1', totalBlocks: 6,
    firstHalfKeeper: null, secondHalfKeeper: null,
  }, roster);
  const candidate = (name: string, primary: FieldGroup) => {
    const player = game.players.find((entry) => entry.name === name);
    if (!player) throw new Error(`Missing test player: ${name}`);
    return {
      player,
      primaryGroup: primary,
      keeperBlocks: 0,
      selectedKeeper: false,
      hardFloor: 0,
      floor: 0,
      bandFloor: 0,
      bandMaximum: 6,
      maximum: 6,
      pinnedBlocks: [],
      pinnedByGroup: { D: 0, M: 0, F: 0 },
    };
  };

  it('prefers a home mover over a backup mover regardless of tier', () => {
    const ordered = orderRerouteMovers([
      candidate('Core backup', 'M'),
      candidate('Home', 'F'),
    ], 'F', {});

    expect(ordered.map((entry) => entry.player.name)).toEqual(['Home', 'Core backup']);
  });

  it('orders movers by core, rotational, then developing tier', () => {
    const ordered = orderRerouteMovers([
      candidate('Developing backup', 'D'),
      candidate('Rotational A', 'M'),
      candidate('Core backup', 'M'),
    ], 'F', {});

    expect(ordered.map((entry) => entry.player.name)).toEqual([
      'Core backup', 'Rotational A', 'Developing backup',
    ]);
  });

  it('rotates same-tier movers using the existing last-gained season state', () => {
    const ordered = orderRerouteMovers([
      candidate('Rotational A', 'M'),
      candidate('Rotational B', 'D'),
    ], 'F', { 'F:rotational': { lastGained: 'Rotational A' } });

    expect(ordered.map((entry) => entry.player.name)).toEqual(['Rotational B', 'Rotational A']);
  });
});

// Developing flex-in regression tests. All strict mode (allowRelaxedMaximums=false).
// At 8 blocks: core start = max = 6 (no flex room), rotational 5->6, developing 4->5.
// At 10 blocks: core 7->8, rotational 6->7, developing 5->6.
describe('Stage 2 developing flex-in (strict)', () => {
  const tierByPrefix = { C: 'core', R: 'rotational', D: 'developing' } as const;

  // `Name:general+backups`; the name prefix C/R/D is the tier and `+-` means no backup group.
  function parseRoster(spec: string): RedesignPlayerInput[] {
    return spec.split(/\s+/).map((token) => {
      const [name, positions] = token.split(':');
      const [general, backups] = positions.split('+');
      return {
        name,
        group: tierByPrefix[name[0] as keyof typeof tierByPrefix],
        general_positions: [general],
        primary_positions: ['ANY'],
        backup_positions: backups === '-' ? [] : backups.split(''),
      };
    });
  }

  const dedicatedKeepers: RedesignPlayerInput[] = [
    { name: 'GK1', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'], keeper: true },
    { name: 'GK2', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'], keeper: true },
  ];

  function strictQuotas(roster: RedesignPlayerInput[], input: Partial<RedesignGameInput> & { totalBlocks: number }) {
    const game = normalizeGame({ format: '9v9', formation: '3-3-2', ...input }, roster);
    return assignQuotas(game, buildDemandModel(game), false, false);
  }

  function strictNineVNine(spec: string) {
    return strictQuotas([...parseRoster(spec), ...dedicatedKeepers], {
      totalBlocks: 8, firstHalfKeeper: 'GK1', secondHalfKeeper: 'GK2',
    });
  }

  const quotaFor = (quotas: ReturnType<typeof assignQuotas>, player: string) =>
    quotas.quotas.find((quota) => quota.player === player)!;
  const totalFor = (quotas: ReturnType<typeof assignQuotas>, player: string) => {
    const quota = quotaFor(quotas, player);
    return quota.fieldTarget + quota.pinnedBlocks.length;
  };

  it('uses developing flex-in to cover a shortage when core has no flex room', () => {
    const quotas = strictNineVNine(
      'C0:F+D R1:D+- R2:M+D D3:F+M C4:D+- C5:F+- D6:D+F R7:M+F R8:D+- C9:F+DM R10:M+-',
    );

    expect(quotas.audit.underfill).toEqual([]);
    expect(quotas.audit.errors).toEqual([]);
    expect(quotas.audit.warnings).toEqual(['Developing flex-in used: D3 into M, 1 block']);

    // D3 (developing, F primary, M backup) is the single developing flex-in: start 4 -> 5, entirely in M.
    expect(totalFor(quotas, 'D3')).toBe(Math.round(0.5 * 8) + 1);
    expect(quotaFor(quotas, 'D3').groupTargets).toEqual({ D: 0, M: 5, F: 0 });
    expect(quotas.audit.surplusAssignments).toContainEqual({ group: 'developing', player: 'D3', amount: 1 });

    // No core or rotational flex-in: core has no room at 8 blocks, and rotational gains stay in their primary group.
    expect(quotas.audit.surplusAssignments?.filter((entry) => entry.group === 'core')).toEqual([]);
    expect(quotaFor(quotas, 'R2').groupTargets).toEqual({ D: 0, M: 6, F: 0 });
    expect(quotaFor(quotas, 'R7').groupTargets).toEqual({ D: 0, M: 6, F: 0 });
    for (const player of ['C0', 'C4', 'C5', 'C9']) expect(totalFor(quotas, player)).toBe(6);

    for (const quota of quotas.quotas.filter((entry) => entry.keeperBlocks === 0)) {
      const total = quota.fieldTarget + quota.pinnedBlocks.length;
      expect(total).toBeGreaterThanOrEqual(Math.ceil(0.4 * 8));
      if (quota.group === 'developing') expect(total).toBeLessThanOrEqual(Math.round(0.6 * 8));
    }
  });

  it('flexes rotational players in before touching a developing player who has a backup and room', () => {
    const quotas = strictNineVNine(
      'D0:M+- C1:D+M C2:F+DM R3:D+- R4:F+DM C5:D+- R6:M+D R7:D+- D8:M+F R9:M+- R10:F+DM',
    );

    expect(quotas.audit.underfill).toEqual([]);
    expect(quotas.audit.errors).toEqual([]);
    expect(quotas.audit.warnings).toEqual([]);
    expect(quotas.audit.warnings?.filter((warning) => warning.startsWith('Developing flex-in used:'))).toEqual([]);

    // R4 and R10 (rotational, F primary, M backup) are the two flex-ins: start 5 -> 6, one block in M.
    for (const player of ['R4', 'R10']) {
      expect(totalFor(quotas, player)).toBe(6);
      expect(quotaFor(quotas, player).groupTargets).toEqual({ D: 0, M: 1, F: 5 });
      expect(quotas.audit.surplusAssignments).toContainEqual({ group: 'rotational', player, amount: 1 });
    }

    // D8 has an F backup but is not flexed: its +1 over the start of 4 is an in-group (M) surplus gain,
    // which brings it to the developing band maximum (5).
    expect(quotaFor(quotas, 'D8').groupTargets).toEqual({ D: 0, M: 5, F: 0 });
    expect(totalFor(quotas, 'D8')).toBe(Math.round(0.5 * 8) + 1);
    expect(totalFor(quotas, 'D8')).toBeLessThanOrEqual(Math.round(0.6 * 8));
    expect(quotas.audit.surplusAssignments?.filter((entry) => entry.group === 'developing')
      .map((entry) => entry.player).sort()).toEqual(['D0', 'D8']);
  });

  // Chelsea 2024 (11v11, 3-4-3, 80 min / 10 blocks), device export 2026-10-21.
  it('flexes developing Makenzie into a constructed midfield shortage on the real Chelsea 2024 roster', () => {
    const player = (
      name: string, group: string, general: string, backups: string[] = [], keeperEligible = false,
    ): RedesignPlayerInput => ({
      name, group, general_positions: [general], primary_positions: ['ANY'], backup_positions: backups,
      keeper_eligible: keeperEligible,
    });
    const chelsea2024: RedesignPlayerInput[] = [
      player('Avery', 'core', 'M', [], true), player('Briana', 'developing', 'M'),
      player('Dolce', 'rotational', 'D'), player('Emma', 'core', 'F'),
      player('Isla', 'core', 'F', ['M']), player('Izzy', 'rotational', 'M', ['F', 'D']),
      player('Jasper', 'rotational', 'D'), player('Kalia', 'rotational', 'M'),
      player('Katelyn', 'rotational', 'F'), player('Maddie', 'core', 'F', [], true),
      player('Madelyn', 'core', 'M', ['F']), player('Makenzie', 'developing', 'F', ['M']),
      player('Natalie', 'core', 'D', [], true), player('Noor', 'rotational', 'M'),
      player('Rozenn', 'core', 'M', ['D']), player('Sophia', 'core', 'D'),
    ];
    // Constructed shortage: Avery (core M) is in goal for both halves and Kalia (rotational M) is out.
    // That leaves M primaries plus Isla's core flex-in short by one block, which Makenzie covers.
    const quotas = strictQuotas(chelsea2024, {
      format: '11v11',
      formation: '3-4-3',
      totalBlocks: 10,
      availablePlayerNames: chelsea2024.map((entry) => entry.name).filter((name) => name !== 'Kalia'),
      firstHalfKeeper: 'Avery',
      secondHalfKeeper: 'Avery',
    });

    expect(quotas.audit.underfill).toEqual([]);
    expect(quotas.audit.errors).toEqual([]);
    expect(quotas.audit.warnings).toEqual(['Developing flex-in used: Makenzie into M, 1 block']);

    // Every M primary on the field is at its band maximum, and the core flexer (Isla) is exhausted.
    expect(totalFor(quotas, 'Briana')).toBe(Math.round(0.6 * 10));
    for (const player of ['Izzy', 'Noor']) expect(totalFor(quotas, player)).toBe(Math.round(0.7 * 10));
    for (const player of ['Madelyn', 'Rozenn']) expect(totalFor(quotas, player)).toBe(Math.round(0.8 * 10));
    expect(totalFor(quotas, 'Isla')).toBe(Math.round(0.8 * 10));
    expect(quotaFor(quotas, 'Isla').groupTargets?.M).toBe(1);

    // Makenzie (developing F, M backup) covers the rest: start 5 -> 6, with M above her start of 0.
    expect(totalFor(quotas, 'Makenzie')).toBe(Math.round(0.5 * 10) + 1);
    expect(quotaFor(quotas, 'Makenzie').groupTargets).toEqual({ D: 0, M: 3, F: 3 });
    expect(quotas.audit.surplusAssignments).toContainEqual({ group: 'developing', player: 'Makenzie', amount: 1 });

    // Briana (developing M, no backup) is the negative control: she stays in M with no other group.
    expect(quotaFor(quotas, 'Briana').groupTargets).toEqual({ D: 0, M: 6, F: 0 });
    expect(quotaFor(quotas, 'Briana').pinnedBlocks).toEqual([]);
  });

  it('reroutes an existing allocation to cover a late-arrival forward shortage', () => {
    const roster: RedesignPlayerInput[] = [
      { name: 'Avery', group: 'core', general_positions: ['M'], primary_positions: ['LCM', 'RCM'], keeper_eligible: true },
      { name: 'Briana', group: 'developing', general_positions: ['M'], primary_positions: ['LM', 'RM'] },
      { name: 'Dolce', group: 'rotational', general_positions: ['D'], primary_positions: ['LB', 'RB'] },
      { name: 'Emma', group: 'core', general_positions: ['F'], primary_positions: ['LF'] },
      { name: 'Isla', group: 'core', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
      { name: 'Izzy', group: 'rotational', general_positions: ['M'], primary_positions: ['RM', 'LM'], backup_positions: ['F', 'D'] },
      { name: 'Jasper', group: 'rotational', general_positions: ['D'], primary_positions: ['RB', 'LB'] },
      { name: 'Kalia', group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'RM'], backup_positions: ['F'] },
      { name: 'Katelyn', group: 'rotational', general_positions: ['F'], primary_positions: ['RF'] },
      { name: 'Maddie', group: 'core', general_positions: ['F'], primary_positions: ['CF'], keeper_eligible: true },
      { name: 'Madelyn', group: 'core', general_positions: ['M'], primary_positions: ['LCM', 'RCM'], backup_positions: ['F'] },
      { name: 'Makenzie', group: 'developing', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
      { name: 'Natalie', group: 'core', general_positions: ['D'], primary_positions: ['LB'], keeper_eligible: true },
      { name: 'Noor', group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'RM'] },
      { name: 'Rozenn', group: 'core', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['D'] },
      { name: 'Sophia', group: 'core', general_positions: ['D'], primary_positions: ['CB'] },
    ];
    const createQuotas = (seasonRotation = {}) => {
      const game = normalizeGame({
        format: '11v11',
        formation: '3-4-3',
        totalBlocks: 10,
        availablePlayerNames: roster.map((player) => player.name).filter((name) => name !== 'Makenzie'),
        firstHalfKeeper: 'Maddie',
        secondHalfKeeper: 'Avery',
        lateArrival: { player: 'Rozenn', arrivalBlock: 4, targetBlocks: 5 },
        seasonRotation,
      }, roster);
      return assignQuotas(game, buildDemandModel(game), false, false);
    };
    const quotas = createQuotas();

    expect(quotas.audit.underfill).toEqual([]);
    expect(quotas.audit.errors).toEqual([]);
    expect(quotas.rotationState?.['F:core']?.lastGained).toBe('Madelyn');
    expect(quotas.rotationState?.['F:rotational']?.lastGained).toBe('Kalia');
    const rotated = createQuotas({ 'F:rotational': { lastGained: 'Izzy' } });
    expect(rotated.audit.underfill).toEqual([]);
    expect(rotated.rotationState?.['F:rotational']?.lastGained).toBe('Kalia');
  });
});
