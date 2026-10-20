import { describe, expect, it } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '..';
import type { PlacementResult } from '..';
import type { DemandModel, FieldGroup, NormalizedGame, RedesignPlayerInput } from '../model';

const deviceRoster: RedesignPlayerInput[] = [
  { name: 'Avery', group: 'rotational', general_positions: ['M'], primary_positions: ['M'], backup_positions: ['D'], keeper: true, keeper_eligible: true },
  { name: 'Brooklyn', group: 'core', general_positions: ['M'], primary_positions: ['CM'], backup_positions: ['D', 'F'], keeper_eligible: true },
  { name: 'Dolce', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M'] },
  { name: 'Emma', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'] },
  { name: 'Kelsey', group: 'core', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
  { name: 'Maddie', group: 'core', general_positions: ['F'], primary_positions: ['RF'], backup_positions: ['M'], keeper: true, keeper_eligible: true },
  { name: 'Madelyn', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'], backup_positions: ['D'] },
  { name: 'Meg', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M'] },
  { name: 'Natalie', group: 'rotational', general_positions: ['D'], primary_positions: ['LB'] },
  { name: 'Rachel', group: 'rotational', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
  { name: 'Reese', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
  { name: 'Selma', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] },
  { name: 'Sophia', group: 'core', general_positions: ['D'], primary_positions: ['CB'] },
];

const selectedKeepers = new Set(['Maddie', 'Avery']);
const sweepPlayers = deviceRoster.filter((player) => !selectedKeepers.has(player.name));

function makeGame(absent: string[] = []): NormalizedGame {
  return normalizeGame({
    format: '9v9',
    formation: '3-3-2',
    totalBlocks: 8,
    availablePlayerNames: deviceRoster
      .filter((player) => !absent.includes(player.name))
      .map((player) => player.name),
    firstHalfKeeper: 'Maddie',
    secondHalfKeeper: 'Avery',
  }, deviceRoster);
}

function attempt(game: NormalizedGame, relaxedMinimums: boolean, relaxedMaximums: boolean) {
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand, relaxedMinimums, relaxedMaximums);
  const placement = runStages3And4(game, demand, quotas);
  return { demand, quotas, placement };
}

function completeAttempt(game: NormalizedGame) {
  const strict = attempt(game, false, false);
  if (!strict.quotas.audit.errors?.length && strict.placement.complete) return strict;

  const relaxedMinimums = attempt(game, true, false);
  if (!relaxedMinimums.quotas.audit.errors?.length && relaxedMinimums.placement.complete) return relaxedMinimums;

  return attempt(game, true, true);
}

function fieldCounts(
  game: NormalizedGame,
  demand: DemandModel,
  placement: PlacementResult,
): { totals: Map<string, number>; groups: Map<string, Record<FieldGroup, number>> } {
  const totals = new Map<string, number>();
  const groups = new Map<string, Record<FieldGroup, number>>();
  for (const player of game.players.filter((entry) => entry.available)) {
    totals.set(player.name, 0);
    groups.set(player.name, { D: 0, M: 0, F: 0 });
  }
  for (const block of placement.blocks) {
    for (const slot of demand.fieldSlots) {
      const player = block.assignments.get(slot.slot);
      if (!player) continue;
      totals.set(player, (totals.get(player) ?? 0) + 1);
      const counts = groups.get(player);
      if (counts) counts[slot.group] += 1;
    }
  }
  return { totals, groups };
}

function groupForPosition(position: string): FieldGroup | null {
  if (['D', 'LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(position.toUpperCase())) return 'D';
  if (['M', 'LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM', 'LDM', 'RDM'].includes(position.toUpperCase())) return 'M';
  if (['F', 'LF', 'CF', 'RF', 'LW', 'RW', 'ST'].includes(position.toUpperCase())) return 'F';
  return null;
}

function eligibleForGroup(player: RedesignPlayerInput, group: FieldGroup): boolean {
  const primaryGroups = (player.general_positions ?? []).map(groupForPosition);
  const backupGroups = (player.backup_positions ?? []).map(groupForPosition);
  return primaryGroups.includes(group) || backupGroups.includes(group);
}

function tierInversions(
  players: RedesignPlayerInput[],
  totals: Map<string, number>,
  keepers: ReadonlySet<string> = selectedKeepers,
): number {
  const tierRank = { core: 0, rotational: 1, developing: 2 };
  const fieldPlayers = players.filter((player) => !keepers.has(player.name));
  let inversions = 0;
  for (let leftIndex = 0; leftIndex < fieldPlayers.length; leftIndex += 1) {
    const left = fieldPlayers[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < fieldPlayers.length; rightIndex += 1) {
      const right = fieldPlayers[rightIndex];
      if (left.group === right.group) continue;
      const higher = tierRank[left.group as keyof typeof tierRank] < tierRank[right.group as keyof typeof tierRank] ? left : right;
      const lower = higher === left ? right : left;
      if ((totals.get(higher.name) ?? 0) < (totals.get(lower.name) ?? 0)) inversions += 1;
    }
  }
  return inversions;
}

function eightBlockJustifications(
  game: NormalizedGame,
  demand: DemandModel,
  totals: Map<string, number>,
  groups: Map<string, Record<FieldGroup, number>>,
): { player: string; justification: string; forced: boolean }[] {
  const available = deviceRoster.filter((player) => game.players.find((entry) => entry.name === player.name)?.available);
  return [...totals]
    .filter(([name, total]) => total === 8 && !selectedKeepers.has(name))
    .map(([name]) => {
      const assignedGroups = groups.get(name)!;
      const bindingGroups = (['D', 'M', 'F'] as const)
        .filter((group) => assignedGroups[group] > 0)
        .map((group) => {
          const eligibleCount = available.filter((player) => eligibleForGroup(player, group)).length;
          const demandBlocks = demand.fieldSlots.filter((slot) => slot.group === group).length * game.totalBlocks;
          return { group, eligibleCount, demandBlocks, average: demandBlocks / eligibleCount };
        })
        .sort((left, right) => right.average - left.average);
      const binding = bindingGroups[0];
      const forced = Boolean(binding && binding.average > 7);
      return {
        player: name,
        forced,
        justification: binding
          ? `${forced ? 'forced' : 'not forced'}: ${binding.group} demand ${binding.demandBlocks} / ${binding.eligibleCount} eligible = ${binding.average.toFixed(2)} blocks`
          : 'not forced: no eligible assigned group',
      };
    });
}

function combinations<T>(values: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return values.flatMap((value, index) =>
    combinations(values.slice(index + 1), size - 1).map((rest) => [value, ...rest]));
}

describe('Stage 2 relaxed equalization', () => {
  it('keeps placed non-keeper totals balanced with Dolce absent', () => {
    const game = makeGame(['Dolce']);
    const { demand, quotas, placement } = attempt(game, true, true);
    const { totals } = fieldCounts(game, demand, placement);
    const nonKeeperTotals = [...totals]
      .filter(([name]) => !selectedKeepers.has(name))
      .map(([, total]) => total);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete).toBe(true);
    expect(Math.min(...nonKeeperTotals)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...nonKeeperTotals) - Math.min(...nonKeeperTotals)).toBeLessThanOrEqual(2);
    expect(quotas.audit.relaxedEqualization?.tierInversionsAfter)
      .toBeLessThanOrEqual(quotas.audit.relaxedEqualization?.tierInversionsBefore ?? -1);
  });

  it('does not change the 4-at-7 and 5-at-6 Emma/Madelyn absence profile', () => {
    const game = makeGame(['Emma', 'Madelyn']);
    const { demand, quotas, placement } = attempt(game, true, true);
    const { totals } = fieldCounts(game, demand, placement);
    const nonKeeperTotals = [...totals]
      .filter(([name]) => !selectedKeepers.has(name))
      .map(([, total]) => total);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete).toBe(true);
    expect(nonKeeperTotals.filter((total) => total === 7)).toHaveLength(4);
    expect(nonKeeperTotals.filter((total) => total === 6)).toHaveLength(5);
    expect(quotas.audit.relaxedEqualization?.iterations).toBe(0);
  });

  it('leaves full-roster normal-mode quotas unchanged', () => {
    const game = makeGame();
    const { demand, quotas, placement } = attempt(game, false, false);
    const { totals } = fieldCounts(game, demand, placement);
    const nonKeeperTotals = [...totals]
      .filter(([name]) => !selectedKeepers.has(name))
      .map(([, total]) => total)
      .sort((left, right) => left - right);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete).toBe(true);
    expect(quotas.audit.relaxedEqualization).toBeUndefined();
    expect(nonKeeperTotals).toEqual([4, 4, 4, 5, 5, 6, 6, 6, 6, 6, 6]);
  });

  it('balances all 11 single and 55 pair absences without worsening tier inversions', () => {
    const scenarios = [
      ...combinations(sweepPlayers, 1),
      ...combinations(sweepPlayers, 2),
    ];
    const startedAt = performance.now();
    const remainingEightBlockPlayers: {
      absent: string[];
      player: string;
      placedTotal: number;
      plannedTotal: number;
      plannedGroups: Record<FieldGroup, number>;
      equalizationIterations: number | null;
      justification: string;
    }[] = [];
    const incompleteScenarios: { absent: string[]; errors: string[] }[] = [];
    const sweepIssues: Record<string, unknown>[] = [];

    for (const absent of scenarios) {
      const game = makeGame(absent.map((player) => player.name));
      const absentNames = absent.map((player) => player.name);
      const { demand, quotas, placement } = completeAttempt(game);
      const { totals, groups } = fieldCounts(game, demand, placement);
      if (!placement.complete) {
        incompleteScenarios.push({ absent: absentNames, errors: placement.audit.errors });
      } else if (placement.audit.errors.some((error) => error.startsWith('Cannot place minimum'))) {
        sweepIssues.push({ absent: absentNames, completedPlacementMinimumErrors: placement.audit.errors });
      }
      const nonKeeperTotals = [...totals]
        .filter(([name]) => !selectedKeepers.has(name))
        .map(([, total]) => total);
      const equalization = quotas.audit.relaxedEqualization;

      if (equalization) {
        if (equalization.tierInversionsAfter > equalization.tierInversionsBefore || equalization.capped) {
          sweepIssues.push({
            absent: absentNames,
            tierInversionsBefore: equalization.tierInversionsBefore,
            tierInversionsAfter: equalization.tierInversionsAfter,
            capped: equalization.capped,
          });
        }
      }
      if (quotas.audit.errors?.length) sweepIssues.push({ absent: absentNames, quotaErrors: quotas.audit.errors });
      if (!placement.complete) sweepIssues.push({
        absent: absentNames,
        placementErrors: placement.audit.errors,
        repair: placement.audit.repair,
      });
      for (const keeper of selectedKeepers) {
        const placedKeeperBlocks = totals.get(keeper);
        if (game.players.find((player) => player.name === keeper)?.available) {
          if (placedKeeperBlocks !== 3) sweepIssues.push({ absent: absentNames, keeper, placedKeeperBlocks });
        }
      }

      const justifications = eightBlockJustifications(game, demand, totals, groups);
      for (const entry of justifications) {
        const quota = quotas.quotas.find((candidate) => candidate.player === entry.player);
        remainingEightBlockPlayers.push({
          absent: absent.map((player) => player.name),
          player: entry.player,
          placedTotal: totals.get(entry.player) ?? 0,
          plannedTotal: (quota?.fieldTarget ?? 0) + (quota?.pinnedBlocks.length ?? 0),
          plannedGroups: {
            D: quota?.groupTargets?.D ?? 0,
            M: quota?.groupTargets?.M ?? 0,
            F: quota?.groupTargets?.F ?? 0,
          },
          equalizationIterations: quotas.audit.relaxedEqualization?.iterations ?? null,
          justification: entry.justification,
        });
      }
      const notForced = justifications.filter((entry) => !entry.forced);
      if (notForced.length) {
        sweepIssues.push({ absent: absentNames, totals: nonKeeperTotals, notForced });
      }
    }

    const elapsedMs = performance.now() - startedAt;
    expect(scenarios).toHaveLength(66);
    expect(elapsedMs).toBeLessThan(5000);
    console.info('Stage 2 device absence sweep:', JSON.stringify({
      scenarios: scenarios.length,
      elapsedMs: Math.round(elapsedMs),
      eightBlockPlayers: remainingEightBlockPlayers,
      incompleteScenarios,
      issues: sweepIssues,
    }));
    expect(sweepIssues).toEqual([]);
  });

  it.each(['Dolce', 'Meg', 'Natalie', 'Sophia'])(
    'completes relaxed generation quickly with defender %s absent',
    (absentPlayer) => {
      const startedAt = performance.now();
      const result = completeAttempt(makeGame([absentPlayer]));

      expect(result.placement.complete).toBe(true);
      expect(performance.now() - startedAt).toBeLessThan(5000);
    },
  );

  it('repairs the Dolce/Reese absence to the exact Stage 2 group plan', () => {
    const game = makeGame(['Dolce', 'Reese']);
    const { quotas, placement } = attempt(game, true, true);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete, JSON.stringify({ repair: placement.audit.repair, errors: placement.audit.errors }))
      .toBe(true);
    expect(placement.audit.repair).toMatchObject({ attempted: true, success: true });
    expect(placement.audit.plannedVsPlaced?.every(({ difference }) => difference === 0)).toBe(true);
  });

  it('returns an infeasible exact plan within the bounded repair search', () => {
    const game = makeGame(['Dolce', 'Reese']);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand, true, true);
    for (const quota of quotas.quotas) quota.groupTargets = { D: 0, M: 0, F: 0 };
    for (const player of game.players) player.excludedPositions.push('F');
    const startedAt = performance.now();
    const placement = runStages3And4(game, demand, quotas);

    expect(placement.complete).toBe(false);
    expect(placement.audit.repair).toMatchObject({ attempted: true, success: false });
    expect(placement.audit.repair?.nodesSearched).toBeLessThanOrEqual(5_000);
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });

  it('never moves a pinned allocation during relaxed equalization', () => {
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Maddie',
      secondHalfKeeper: 'Avery',
      pins: [{ block: 1, slot: 'CB', player: 'Sophia' }],
    }, deviceRoster);
    const { demand, quotas, placement } = attempt(game, true, true);
    const firstBlock = placement.blocks.find((block) => block.block === 1);

    expect(quotas.audit.errors).toEqual([]);
    expect(placement.complete).toBe(true);
    expect(firstBlock?.assignments.get('CB')).toBe('Sophia');
    expect(quotas.quotas.find((quota) => quota.player === 'Sophia')?.pinnedBlocks).toContain(1);
    expect(quotas.audit.relaxedEqualization?.tierInversionsAfter)
      .toBeLessThanOrEqual(quotas.audit.relaxedEqualization?.tierInversionsBefore ?? -1);
    expect(demand.fieldSlots.some((slot) => slot.slot === 'CB')).toBe(true);
  });

  it('does not increase tier inversions in the placed relaxed plan', () => {
    const game = makeGame(['Dolce']);
    const { demand, quotas, placement } = attempt(game, true, true);
    const { totals } = fieldCounts(game, demand, placement);
    const before = quotas.audit.relaxedEqualization?.tierInversionsBefore;
    const after = tierInversions(deviceRoster, totals);

    expect(before).toBeDefined();
    expect(after).toBeLessThanOrEqual(before ?? -1);
  });
});
