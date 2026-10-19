import { describe, expect, it } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '..';
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

  it('improves the relaxed playing-time spread when a midfield backup enables more balanced placement', () => {
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
    expect(baseline.spread).toBe(3);
    expect(withBackup.spread).toBe(1);
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
