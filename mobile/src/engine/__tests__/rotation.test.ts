import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.setConfig({ testTimeout: 15000 });

import cases from './fixtures/rotation_contract_cases.json';
import fingerprintCases from './fixtures/rotation_fingerprint_cases.json';
import regressionRoster from './fixtures/late-arrival-regression-roster.json';
import { createPlayer, generateSchedule, regenerateSchedule } from '../rotation';
import { SeasonSetup } from '../season';
import { backupEligiblePlayers, eligiblePlayers, exclusionBlocksSlot, positionalPriority } from '../positional';
import { DEVELOPMENTAL_MAX, HARD_MAXIMUM, ROTATIONAL_MAX, computeBlockTargets, fieldCapacityByHalf, intendedMaximumBlocksForPercentage, minimumBlocksForPercentage, positionCapacityCandidates, positionCapacityDeficits, positionCapacityWarnings, targetBlocksForPercentage } from '../quotas';
import { assignExactSlots, calculateMovementMetrics, canCoverSlot, estimateAdditionalPlayersNeeded, formationSlots, optimizeExactSlotSwitches, parseFormation, validateTimeline } from '../timeline';
import type { AfterGameReport, Game, GameInput, PlayerInput, ScheduleBlock } from '../models';
import { aggregateSeasonFairness } from '../../services/season-fairness';
import { summarizeStructuralErrors } from '../../services/structural-diagnostics';

function rotationFingerprint(result: ReturnType<typeof generateSchedule>): string {
  const payload = {
    timeline: result.timeline,
    block_counts: result.block_counts,
    gk_summary: result.gk_summary,
    position_summary: result.position_summary,
    metadata: result.metadata,
    warnings: result.warnings,
    errors: result.errors,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertBlockInvariants(block: ScheduleBlock, fieldPlayers: number, hasGoalkeeper: boolean): void {
  const assigned = Object.values(block.positions);
  expect(assigned).not.toContain('UNASSIGNED');
  expect(assigned).not.toContain('NO GK AVAILABLE');
  expect(new Set(assigned).size).toBe(assigned.length);
  expect(assigned.length).toBe(fieldPlayers + (hasGoalkeeper ? 1 : 0));
  if (hasGoalkeeper) {
    expect(block.positions.GK).toBeTruthy();
    expect(block.positions.GK).toBe(block.GK);
  }
}

function seasonSimulationRoster(): PlayerInput[] {
  return [
    { name: 'Alvin', group: 'core', general_positions: ['M'], primary_positions: ['ANY'] },
    { name: 'Artur', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
    { name: 'Blake', group: 'rotational', general_positions: ['D', 'M'], primary_positions: ['ANY'] },
    { name: 'Brad', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] },
    { name: 'Cameron', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY', 'GK'] },
    { name: 'Dane', group: 'core', general_positions: ['M'], primary_positions: ['ANY'] },
    { name: 'Eitan', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY', 'GK'] },
    { name: 'Everett', group: 'core', general_positions: ['D'], primary_positions: ['ANY'] },
    { name: 'Frank', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] },
    { name: 'Hanshith', group: 'core', general_positions: ['F'], primary_positions: ['ANY', 'GK'] },
    { name: 'Jonathan', group: 'core', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] },
    { name: 'Mahaswin', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] },
    { name: 'Max', group: 'core', general_positions: ['F'], primary_positions: ['ANY'] },
    { name: 'Prerith', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] },
    { name: 'Ryan', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] },
    { name: 'Sawyer', group: 'rotational', general_positions: ['F'], primary_positions: ['ANY'] },
    { name: 'Sid', group: 'core', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] },
    { name: 'Thanish', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] },
    { name: 'Yash', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] },
  ];
}

function dualRoleGoalkeeperRoster(): PlayerInput[] {
  return [
    { name: 'Cameron', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY', 'GK'] },
    { name: 'Eitan', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY', 'GK'] },
    ...Array.from({ length: 5 }, (_, index) => ({ name: `Defender ${index + 1}`, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['D'] })),
    ...Array.from({ length: 5 }, (_, index) => ({ name: `Midfielder ${index + 1}`, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['M'] })),
    ...Array.from({ length: 5 }, (_, index) => ({ name: `Forward ${index + 1}`, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['F'] })),
    { name: 'Flexible 1', group: 'rotational', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
    { name: 'Flexible 2', group: 'rotational', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
  ];
}

function coachAssignedSeasonBackups(roster: PlayerInput[]): PlayerInput[] {
  const coachAssignments: Record<string, string[]> = {
    Artur: ['D'],
    Blake: ['F'],
    Brad: ['D', 'F'],
    Mahaswin: ['D', 'F'],
    Prerith: ['D', 'F'],
    Thanish: ['D', 'F'],
    Everett: ['M', 'F'],
    Frank: ['M', 'F'],
    Hanshith: ['D'],
    Ryan: ['M', 'F'],
    Yash: ['M', 'F'],
  };
  return roster.map((player) => {
    const assignedBackups = coachAssignments[player.name] ?? [];
    if (!assignedBackups.length) return player;
    return { ...player, backup_positions: [...new Set([...(player.backup_positions ?? []), ...assignedBackups])] };
  });
}

function seededShuffle<T>(values: T[], seed: number): T[] {
  const shuffled = [...values];
  let state = seed;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function seasonAvailableNames(roster: PlayerInput[], count: number, seed: number): string[] {
  const required = roster.filter((player) => ['D', 'M', 'F'].some((group) => player.general_positions?.includes(group)));
  const selected = new Set(required.slice(0, 0).map((player) => player.name));
  const shuffled = seededShuffle(roster, seed);
  const addFromGroup = (group: string, minimum: number) => {
    roster.filter((player) => player.general_positions?.includes(group)).sort((left, right) => left.name.localeCompare(right.name)).forEach((player) => {
      if (selected.size >= count || [...selected].filter((name) => roster.find((candidate) => candidate.name === name)?.general_positions?.includes(group)).length >= minimum) return;
      selected.add(player.name);
    });
  };
  addFromGroup('F', 3);
  const goalkeeper = shuffled.find((player) => player.primary_positions?.includes('GK'));
  if (goalkeeper) selected.add(goalkeeper.name);
  shuffled.forEach((player) => { if (selected.size < count) selected.add(player.name); });
  return [...selected];
}

describe('rotation engine contract fixtures', () => {
  for (const testCase of cases) {
    it(`${testCase.id} preserves legal block invariants`, () => {
      const result = generateSchedule(
        testCase.game as GameInput,
        testCase.players.map((player) => createPlayer(player as PlayerInput)),
      );

      expect(result.errors).toEqual([]);
      result.timeline.forEach((block) => assertBlockInvariants(
        block,
        testCase.expect.field_players,
        testCase.expect.has_goalkeeper,
      ));
      if (testCase.expect.first_goalkeeper) {
        const midpoint = Math.ceil(result.timeline.length / 2);
        expect(result.timeline[0].GK).toBe(testCase.expect.first_goalkeeper);
        expect(result.timeline[midpoint].GK).toBe(testCase.expect.second_goalkeeper);
      }
    });
  }
});

describe('rotation engine TypeScript fingerprints', () => {
  for (const testCase of fingerprintCases) {
    it(`${testCase.id} preserves the TypeScript observable output`, () => {
      const result = generateSchedule(
        testCase.game as GameInput,
        testCase.players.map((player) => createPlayer(player as PlayerInput)),
      );

      expect(rotationFingerprint(result)).toBe(testCase.fingerprint);
    });
  }

  it('reports fingerprint cases that still need spec verification', () => {
    const unverified = fingerprintCases.filter((testCase) => testCase.spec_verified === false).map((testCase) => testCase.id);
    if (unverified.length) console.warn(`Fingerprint cases awaiting spec verification: ${unverified.join(', ')}`);
    expect(unverified).toBeDefined();
  });
});

describe('rotation engine happy-path fingerprint contracts', () => {
  for (const testCase of fingerprintCases.filter((candidate) => candidate.happy_path)) {
    it(`${testCase.id} satisfies policy bands and coverage`, () => {
      const result = generateSchedule(
        testCase.game as GameInput,
        testCase.players.map((player) => createPlayer(player as PlayerInput)),
      );
      expect(result.errors).toEqual([]);
      expect(result.warnings.filter((warning) => warning.toLowerCase().includes('infeas'))).toEqual([]);
      expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('UNASSIGNED');
      expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('NO GK AVAILABLE');

      for (const [goalkeeper, expectedBlocks] of Object.entries(testCase.expected_goalkeeper_blocks ?? {})) {
        expect(result.timeline.filter((block) => block.GK === goalkeeper)).toHaveLength(expectedBlocks);
      }
      for (const player of testCase.players) {
        if (player.primary_positions.includes('GK')) continue;
        const fieldBlocks = result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(player.name)).length;
        const percentage = fieldBlocks / testCase.game.total_blocks;
        const band = player.group === 'core'
          ? [0.7, 0.8]
          : player.group === 'developing'
            ? [0.4, 0.5]
            : [0.5, 0.7];
        expect(percentage, `${testCase.id} ${player.name}`).toBeGreaterThanOrEqual(band[0]);
        expect(percentage, `${testCase.id} ${player.name}`).toBeLessThanOrEqual(band[1]);
      }
    });
  }
});

describe('format and goalkeeper contracts', () => {
  it('generates the approved 4v4 field-player-only shape', () => {
    const testCase = fingerprintCases.find(({ id }) => id === '4v4-basic');
    if (!testCase) throw new Error('4v4-basic fixture missing');
    const result = generateSchedule(testCase.game as GameInput, testCase.players.map((player) => createPlayer(player as PlayerInput)));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.timeline.every((block) => block.GK === '' && block.positions.GK === undefined)).toBe(true);
    expect(result.gk_summary).toEqual({});
    expect(result.block_counts).toEqual(testCase.expected?.player_blocks);
    expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('UNASSIGNED');
  });

  it('rejects conflicting game format and goalkeeper settings', () => {
    expect(() => generateSchedule({ total_blocks: 1, formation: '1-1-1', game_format: '4v4', has_goalkeeper: true }, [])).toThrow('has_goalkeeper conflicts with game_format 4v4');
    expect(() => generateSchedule({ total_blocks: 1, formation: '1-2-1', game_format: '5v5', has_goalkeeper: false }, [])).toThrow('has_goalkeeper conflicts with game_format 5v5');
  });

  it('disambiguates 5v5 goalkeeper behavior from 4v4 with the same formation', () => {
    const fiveVFive = fingerprintCases.find(({ id }) => id === '5v5-keeper-disambiguation');
    const fourVFour = fingerprintCases.find(({ id }) => id === '4v4-basic');
    if (!fiveVFive || !fourVFour) throw new Error('5v5 or 4v4 fingerprint fixture missing');
    const fiveVFiveResult = generateSchedule(fiveVFive.game as GameInput, fiveVFive.players.map((player) => createPlayer(player as PlayerInput)));
    const fourVFourResult = generateSchedule(fourVFour.game as GameInput, fourVFour.players.map((player) => createPlayer(player as PlayerInput)));

    expect(fiveVFiveResult.errors).toEqual([]);
    expect(fiveVFiveResult.warnings).toEqual([]);
    expect(fiveVFiveResult.timeline.flatMap((block) => Object.values(block.positions)).filter((value) => value === 'UNASSIGNED')).toHaveLength(0);
    expect(fiveVFiveResult.timeline.every((block) => block.GK === 'Sam' && block.positions.GK === 'Sam')).toBe(true);
    expect(fiveVFiveResult.block_counts).toMatchObject(fiveVFive.expected?.player_blocks);
    expect(fiveVFiveResult.gk_summary).toEqual(fiveVFive.expected?.gk_summary);
    expect(fourVFourResult.timeline.every((block) => block.GK === '' && block.positions.GK === undefined)).toBe(true);
  });

  it('satisfies the 9v9 balanced happy-path contracts', () => {
    const testCase = fingerprintCases.find(({ id }) => id === '9v9-balanced-happy-path');
    if (!testCase) throw new Error('9v9 fingerprint fixture missing');
    const result = generateSchedule(testCase.game as GameInput, testCase.players.map((player) => createPlayer(player as PlayerInput)));
    const fieldBlocks = (name: string) => result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length;

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.timeline.flatMap((block) => Object.values(block.positions)).filter((value) => value === 'UNASSIGNED')).toHaveLength(0);
    expect(result.gk_summary).toEqual(testCase.expected_goalkeeper_summaries);
    expect(result.timeline[9].D).toHaveLength(3);
    expect(result.timeline[9].M).toHaveLength(3);
    expect(result.timeline[9].F).toHaveLength(2);
    expect(fieldBlocks('Everett')).toBeGreaterThanOrEqual(7);
    expect(fieldBlocks('Everett')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Sid')).toBeGreaterThanOrEqual(7);
    expect(fieldBlocks('Sid')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Alvin')).toBeGreaterThanOrEqual(7);
    expect(fieldBlocks('Alvin')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Max')).toBeGreaterThanOrEqual(7);
    expect(fieldBlocks('Max')).toBeLessThanOrEqual(8);
    for (const name of ['Ryan', 'Yash', 'Brad', 'Mahaswin', 'Sawyer', 'Blake']) {
      expect(fieldBlocks(name), `${name} rotational blocks`).toBeGreaterThanOrEqual(5);
      expect(fieldBlocks(name), `${name} rotational blocks`).toBeLessThanOrEqual(7);
    }
    expect(fieldBlocks('Prerith')).toBe(5);
    expect(fieldBlocks('Leo')).toBe(5);
  });

  it('keeps dual-role goalkeeper field time outside the goalkeeper half', () => {
    const testCase = fingerprintCases.find(({ id }) => id === 'new-dual-role-goalkeeper');
    if (!testCase) throw new Error('new-dual-role-goalkeeper fixture missing');
    const result = generateSchedule(testCase.game as GameInput, testCase.players.map((player) => createPlayer(player as PlayerInput)));
    const dualRoleFieldBlocks = result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes('Dual GK'));

    expect(result.errors).toEqual([]);
    expect(result.gk_summary).toEqual(testCase.expected_goalkeeper_summaries);
    expect(result.timeline.filter((block) => block.GK === 'Dual GK')).toHaveLength(5);
    expect(dualRoleFieldBlocks).toHaveLength(2);
    expect(dualRoleFieldBlocks.every((block) => block.GK !== 'Dual GK')).toBe(true);
    expect(result.block_counts['Dual GK']).toBe(7);
  });
});

describe('goalkeeper and minimum protection', () => {
  it('returns opt-in late-arrival approval data for a selected block', () => {
    const game = { total_blocks: 2, formation: '1-0', first_half_gk: 'Keeper', second_half_gk: 'Keeper', is_late_arrival_regen: true as const, late_arrival_approval: { player: 'Arriving', scope: 'one_block' as const, block: 1 } };
    const initial = generateSchedule(game, [
      { name: 'Keeper', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
      { name: 'Starter', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
    ].map(createPlayer));
    const result = regenerateSchedule(
      game,
      [
        { name: 'Keeper', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
        { name: 'Starter', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
        { name: 'Arriving', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      ].map(createPlayer),
      initial.timeline,
      [{ player: 'Arriving', action: 'available', block: 0, target_blocks: 1, minimum_blocks: 1, maximum_blocks: 1 }],
      ['Keeper', 'Starter', 'Arriving'],
      true,
    );
    expect(result.late_arrival_approval?.request.player).toBe('Arriving');
    expect(result.late_arrival_approval?.affected_blocks).toEqual([1]);
    const halfResult = regenerateSchedule(
      { ...game, late_arrival_approval: { player: 'Arriving', scope: 'entire_half' as const, half: 0 } },
      [
        { name: 'Keeper', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
        { name: 'Starter', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
        { name: 'Arriving', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      ].map(createPlayer),
      initial.timeline,
      [{ player: 'Arriving', action: 'available', block: 0, target_blocks: 1, minimum_blocks: 1, maximum_blocks: 1 }],
      ['Keeper', 'Starter', 'Arriving'],
      true,
    );
    expect(halfResult.late_arrival_approval?.affected_blocks).toEqual([1]);
  });

  it('allows a 19-player dual-role goalkeeper roster with Cameron and Eitan', () => {
    const players = dualRoleGoalkeeperRoster().map((player) => createPlayer(player));
    const result = generateSchedule({
      total_blocks: 10,
      formation: '3-4-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      allow_emergency_assignments: true,
    }, players);

    expect(result.errors.filter((error) => error.includes('half maximum'))).toEqual([]);
    expect(result.timeline).toHaveLength(10);
    for (const name of ['Cameron', 'Eitan']) {
      const fieldBlocks = result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length;
      expect(fieldBlocks, `${name} field blocks`).toBeGreaterThanOrEqual(2);
      expect(fieldBlocks, `${name} field blocks`).toBeLessThanOrEqual(3);
    }
  });

  it('uses the legacy single goalkeeper assignment for both halves', () => {
    const players = [
      createPlayer({ name: 'Gio', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] }),
      createPlayer({ name: 'D2', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] }),
      createPlayer({ name: 'M', group: 'rotational', general_positions: ['M'], primary_positions: ['M'] }),
      createPlayer({ name: 'M2', group: 'rotational', general_positions: ['M'], primary_positions: ['M'] }),
      createPlayer({ name: 'F', group: 'rotational', general_positions: ['F'], primary_positions: ['F'] }),
      createPlayer({ name: 'F2', group: 'rotational', general_positions: ['F'], primary_positions: ['F'] }),
    ];
    const result = generateSchedule({ total_blocks: 4, formation: '1-1-1', gk_assignment: 'Gio' }, players);

    expect(result.errors).toEqual([]);
    expect(result.timeline.every((block) => block.GK === 'Gio')).toBe(true);
  });

  it('accepts the legacy emergency-position option name', () => {
    const players = [
      createPlayer({ name: 'Gio', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D1', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] }),
      createPlayer({ name: 'D2', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] }),
    ];
    const legacy = generateSchedule({ total_blocks: 1, formation: '1-1-0', gk_assignment: 'Gio', allow_emergency_positions: true }, players);
    const current = generateSchedule({ total_blocks: 1, formation: '1-1-0', gk_assignment: 'Gio', allow_emergency_assignments: true }, players);

    expect(legacy.errors).toEqual(current.errors);
    expect(legacy.timeline).toEqual(current.timeline);
  });

  it('replaces an unavailable goalkeeper during regeneration', () => {
    const players = [
      createPlayer({ name: 'G1', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'G2', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D1', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] }),
      createPlayer({ name: 'F1', group: 'rotational', general_positions: ['F'], primary_positions: ['F'] }),
    ];
    const game = { total_blocks: 2, formation: '1-0-1', first_half_gk: 'G1', second_half_gk: 'G2' };
    const initial = generateSchedule(game, players);
    const updated = regenerateSchedule(game as Game, players, initial.timeline, [{ player: 'G1', action: 'unavailable', block: 1 }]);

    expect(updated.timeline[0].GK).toBe('G2');
    expect(updated.timeline[0].positions.GK).toBe('G2');
  });

  it('updates exact positions when replacing an unavailable field player', () => {
    const players = [
      createPlayer({ name: 'G1', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'G2', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D1', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'D2', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'F1', group: 'rotational', general_positions: ['F'], primary_positions: ['ST'] }),
    ];
    const game = { total_blocks: 2, formation: '1-0-1', first_half_gk: 'G1', second_half_gk: 'G2' };
    const initial = generateSchedule(game, players);
    const updated = regenerateSchedule(game as Game, players, initial.timeline, [{ player: 'D1', action: 'unavailable', block: 1 }]);

    expect(updated.timeline[0].D).toEqual(['D2']);
    expect(updated.timeline[0].positions.CB).toBe('D2');
    expect(updated.timeline[0].positions).not.toHaveProperty('CB', 'D1');
    expect(updated.timeline[1].positions.CB).not.toBe('D1');
  });

  it('does not auto-select a goalkeeper when the coach selection is missing or stale', () => {
    const players = [
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'M', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'F', group: 'rotational', general_positions: ['F'], primary_positions: ['ST'] }),
    ];
    const missing = generateSchedule({ total_blocks: 4, formation: '1-1-1', first_half_gk: 'GK', second_half_gk: null }, players);
    const stale = generateSchedule({ total_blocks: 4, formation: '1-1-1', first_half_gk: 'Missing', second_half_gk: 'GK' }, players);

    expect(missing.timeline.slice(0, 2).every((block) => block.GK === 'GK')).toBe(true);
    expect(missing.timeline.slice(2).every((block) => block.GK === 'NO GK AVAILABLE')).toBe(true);
    expect(stale.timeline.slice(0, 2).every((block) => block.GK === 'NO GK AVAILABLE')).toBe(true);
    expect(stale.timeline.slice(2).every((block) => block.GK === 'GK')).toBe(true);
    expect(missing.errors.some((error) => error.toLowerCase().includes('goalkeeper'))).toBe(true);
    expect(stale.errors.some((error) => error.toLowerCase().includes('goalkeeper'))).toBe(true);
  });

  it('preserves explicit goalkeeper preferences for each half', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB', 'RB'] })),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM'] })),
      ...['F1', 'F2'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['F'], primary_positions: ['LF', 'RF'] })),
      createPlayer({ name: 'GK1', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'GK2', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-4-2',
      first_half_gk: 'GK2',
      second_half_gk: 'GK1',
    }, players);

    expect(result.timeline[0].GK).toBe('GK2');
    expect(result.timeline[5].GK).toBe('GK1');
  });

  it('allows a goalkeeper to cover every block of a five-block half', () => {
    const goalkeeper = createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] });
    computeBlockTargets({ total_blocks: 10, formation: '0-0-0', quota_exempt_players: new Set(), replacement_bonuses: {} }, [goalkeeper]);
    const timeline: ScheduleBlock[] = Array.from({ length: 10 }, () => ({
      GK: 'GK', D: [], M: [], F: [], bench: [], positions: { GK: 'GK' },
    }));

    expect(goalkeeper.max_blocks_per_half).toBe(5);
    expect(validateTimeline([goalkeeper], timeline, parseFormation('0-0-0'), formationSlots(parseFormation('0-0-0')), 10)).toEqual([]);
  });

  it('uses cumulative total starts before position-specific starts', () => {
    const players = [
      createPlayer({ name: 'D1', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] }),
      createPlayer({ name: 'D2', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] }),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({
      total_blocks: 1,
      formation: '1-0-0',
      first_half_gk: 'GK',
      second_half_gk: 'GK',
      season_position_starts: { D1: { F: 5 }, D2: {} },
    }, players);

    expect(result.timeline[0].D).toEqual(['D1']);
  });

  it('treats Any as every legal field group but never as goalkeeper eligibility', () => {
    const player = createPlayer({ name: 'Any Player', group: 'rotational', general_positions: ['ANY'], primary_positions: ['ANY'] });

    expect(eligiblePlayers([player], 'D')).toEqual([player]);
    expect(eligiblePlayers([player], 'M')).toEqual([player]);
    expect(eligiblePlayers([player], 'F')).toEqual([player]);
    expect(player.primary_positions.includes('GK')).toBe(false);
  });

  it('scopes primary Any to the player general group', () => {
    const midfieldAny = createPlayer({ name: 'Midfield Any', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] });
    const unrestrictedAny = createPlayer({ name: 'Unrestricted Any', group: 'rotational', general_positions: ['ANY'], primary_positions: ['ANY'] });

    expect(canCoverSlot(midfieldAny, 'CM', 'M')).toBe(true);
    expect(canCoverSlot(midfieldAny, 'CB', 'D')).toBe(false);
    expect(canCoverSlot(unrestrictedAny, 'CB', 'D')).toBe(true);
    expect(canCoverSlot(unrestrictedAny, 'CM', 'M')).toBe(true);
  });

  it('applies case-insensitive zone-based slot exclusions', () => {
    const cases = [
      { forbidden: ['LM'], slot: 'LM', expected: true },
      { forbidden: ['M'], slot: 'RM', expected: true },
      { forbidden: ['CM'], slot: 'RCM', expected: true },
      { forbidden: ['cm'], slot: 'LCM', expected: true },
      { forbidden: ['CB'], slot: 'LCB', expected: true },
      { forbidden: ['CM'], slot: 'LM', expected: false },
      { forbidden: ['LM'], slot: 'RM', expected: false },
      { forbidden: ['CB'], slot: 'LB', expected: false },
    ];

    cases.forEach(({ forbidden, slot, expected }) => {
      expect(exclusionBlocksSlot(forbidden, slot), `${forbidden.join(',')} -> ${slot}`).toBe(expected);
    });
  });

  it('never assigns a CM-excluded midfielder to central midfield slots', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['D'] })),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
      createPlayer({ name: 'CM Excluded', group: 'developing', general_positions: ['M'], primary_positions: ['CM'], forbidden_positions: ['CM'] }),
      ...['F1', 'F2'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['F'], primary_positions: ['F'] })),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 5, formation: '4-4-2', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.timeline.flatMap((block) => ['LCM', 'CM', 'RCM', 'CDM', 'CAM'].map((slot) => block.positions[slot])).filter((name) => name === 'CM Excluded')).toEqual([]);
    expect(result.timeline.flatMap((block) => [...block.D, ...block.M, ...block.F]).filter((name) => name === 'CM Excluded').length).toBeGreaterThan(0);
  });

  it('honors central-defense and wide-slot exclusions independently', () => {
    const defenders = [
      createPlayer({ name: 'CB Excluded', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'], forbidden_positions: ['CB'] }),
      ...['D1', 'D2', 'D3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['D'] })),
    ];
    const midfielders = [
      createPlayer({ name: 'LM Excluded', group: 'rotational', general_positions: ['M'], primary_positions: ['LM'], forbidden_positions: ['LM'] }),
      ...['M1', 'M2', 'M3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
    ];
    const players = [
      ...defenders,
      ...midfielders,
      ...['F1', 'F2'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['F'], primary_positions: ['F'] })),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 5, formation: '4-4-2', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.timeline.flatMap((block) => ['LCB', 'CB', 'RCB'].map((slot) => block.positions[slot])).filter((name) => name === 'CB Excluded')).toEqual([]);
    expect(result.timeline.flatMap((block) => ['LM'].map((slot) => block.positions[slot])).filter((name) => name === 'LM Excluded')).toEqual([]);
    expect(result.timeline.flatMap((block) => ['LB', 'RB', 'RM', 'LCM', 'RCM'].map((slot) => block.positions[slot]))).toEqual(expect.arrayContaining(['CB Excluded', 'LM Excluded']));
  });

  it('reserves half capacity for dual-role goalkeeper assignments', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['D'] })),
      createPlayer({ name: 'F1', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'] }),
      createPlayer({ name: 'F2', group: 'rotational', general_positions: ['F'], primary_positions: ['RF'] }),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
      ...['RM1', 'RM2', 'RM3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
      createPlayer({ name: 'Thanish', group: 'developing', general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM'] }),
      createPlayer({ name: 'Cameron', group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM', 'GK'] }),
      createPlayer({ name: 'Eitan', group: 'rotational', general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB', 'RB', 'GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'Cameron', second_half_gk: 'Eitan' }, players);
    const cameron = players.find((player) => player.name === 'Cameron');
    const eitan = players.find((player) => player.name === 'Eitan');

    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
    expect(result.errors.filter((error) => error.includes('half maximum'))).toEqual([]);
    expect(cameron?.gk_blocks).toBe(5);
    expect(cameron?.field_blocks).toBeGreaterThanOrEqual(2);
    expect(cameron?.field_blocks).toBeLessThanOrEqual(3);
    expect(eitan?.gk_blocks).toBe(5);
    expect(eitan?.field_blocks).toBeGreaterThanOrEqual(2);
    expect(eitan?.field_blocks).toBeLessThanOrEqual(3);
    expect(eitan?.blocks_by_half[1]).toBe(5);
    expect(result.timeline.slice(5).every((block) => ![...block.D, ...block.M, ...block.F].includes('Eitan'))).toBe(true);
    expect(players.find((player) => player.name === 'Thanish')?.field_blocks).toBeGreaterThanOrEqual(4);
  });

  it('uses a dual-role goalkeeper as a field player before their goalkeeper half', () => {
    const players = [
      { name: 'Alvin', group: 'core' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Artur', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Blake', group: 'rotational' as const, general_positions: ['D', 'M'], primary_positions: ['ANY'] },
      { name: 'Brad', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Cameron', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY', 'GK'] },
      { name: 'Eitan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY', 'GK'] },
      { name: 'Everett', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Frank', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Jonathan', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Mahaswin', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Max', group: 'core' as const, general_positions: ['F'], primary_positions: ['ANY'] },
      { name: 'Prerith', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Ryan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Sawyer', group: 'rotational' as const, general_positions: ['F'], primary_positions: ['ANY'] },
      { name: 'Sid', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Yash', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan' }, players);
    const eitan = players.find((player) => player.name === 'Eitan');

    expect(eitan?.field_blocks).toBeGreaterThan(0);
    expect(eitan?.blocks_by_half[0]).toBeGreaterThan(0);
    expect(eitan?.blocks_by_half[1]).toBe(5);
    expect(result.timeline.slice(0, 5).some((block) => [...block.D, ...block.M, ...block.F].includes('Eitan'))).toBe(true);
    expect(result.timeline.slice(5).every((block) => ![...block.D, ...block.M, ...block.F].includes('Eitan'))).toBe(true);
  });

  it('uses a newly added backup forward to complete every forward block', () => {
    const players = [
      { name: 'Alvin', group: 'core' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Artur', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Blake', group: 'rotational' as const, general_positions: ['D', 'M'], primary_positions: ['ANY'] },
      { name: 'Brad', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Cameron', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY', 'GK'] },
      { name: 'Eitan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY', 'GK'], backup_positions: ['F'] },
      { name: 'Everett', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Frank', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Jonathan', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Mahaswin', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Max', group: 'core' as const, general_positions: ['F'], primary_positions: ['ANY'] },
      { name: 'Prerith', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Ryan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Sawyer', group: 'rotational' as const, general_positions: ['F'], primary_positions: ['ANY'] },
      { name: 'Sid', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Yash', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan', disable_maximum_limits: true }, players);

    expect(result.timeline.every((block) => block.F.length === 3)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('more Forward'))).toBe(false);
    expect(result.errors.some((error) => error.includes('F requires 3'))).toBe(false);
    expect(result.timeline.slice(5).every((block) => !block.F.includes('Eitan'))).toBe(true);
  });

  it('keeps general-position core forwards ahead of defender-to-forward backups at endpoints', () => {
    const players = [
      { name: 'Alvin', group: 'core' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['D'] },
      { name: 'Artur', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Blake', group: 'rotational' as const, general_positions: ['D', 'M'], primary_positions: ['ANY'] },
      { name: 'Brad', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Cameron', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY', 'GK'] },
      { name: 'Eitan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY', 'GK'] },
      { name: 'Everett', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M'] },
      { name: 'Frank', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Jonathan', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Mahaswin', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Max', group: 'core' as const, general_positions: ['F'], primary_positions: ['ANY'] },
      { name: 'Prerith', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Ryan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Sawyer', group: 'core' as const, general_positions: ['F'], primary_positions: ['ANY'] },
      { name: 'Sid', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Yash', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan' }, players);

    expect(result.timeline[0].F).toContain('Sawyer');
    expect(result.timeline[0].F).not.toContain('Jonathan');
    expect(result.timeline[0].F).not.toContain('Sid');
    expect(result.errors).not.toContain(expect.stringContaining('core player Sawyer'));
    expect(result.errors).not.toContain(expect.stringContaining('Jonathan exceeds hard maximum'));
  });

  it('N9-1 does not block a schedule when core endpoint demand exceeds field capacity', () => {
    const players = [
      { name: 'Core Defender 1', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Core Defender 2', group: 'core' as const, general_positions: ['D'], primary_positions: ['ANY'] },
      { name: 'Keeper', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 2, formation: '1-0', first_half_gk: 'Keeper', second_half_gk: 'Keeper' }, players);

    expect(result.timeline[0].D).toHaveLength(1);
    expect(result.timeline[1].D).toHaveLength(1);
    expect(result.timeline[0].D[0]).toBeTruthy();
    expect(result.timeline[1].D[0]).toBeTruthy();
    expect(result.errors.filter((error) => error.includes('endpoint'))).toEqual([]);
  });

  it('preserves the last endpoint during late-arrival regeneration', () => {
    const team = regressionRoster as { season_roster: PlayerInput[] };
    const unavailable = new Set(['RotD01', 'RotF01', 'CoreD03']);
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'RotD05', second_half_gk: 'RotM03', allow_emergency_assignments: true, disable_maximum_limits: true };
    const initial = generateSchedule(game, team.season_roster.filter((player) => !unavailable.has(player.name)).map(createPlayer));
    const players = team.season_roster.map(createPlayer);
    players.forEach((player) => { player.available = !unavailable.has(player.name); });
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: 'RotF01', action: 'available', block: 4, target_blocks: 3, minimum_blocks: 0, maximum_blocks: 3 }], undefined, true);
    const initialGoalkeeperCounts = new Map(['RotD05', 'RotM03'].map((name) => [name, initial.timeline.filter((block) => block.GK === name).length]));
    const initialTotalCounts = new Map(['RotD05', 'RotM03'].map((name) => [name, initial.timeline.filter((block) => block.GK === name || [...block.D, ...block.M, ...block.F].includes(name)).length]));

    expect(initial.errors).toEqual([]);
    expect(regenerated.errors).toEqual([]);
    expect(regenerated.timeline[9].D).toHaveLength(4);
    expect(regenerated.timeline[9].M).toHaveLength(3);
    expect(regenerated.timeline[9].F).toHaveLength(3);
    expect(regenerated.timeline[9].F).toContain('CoreF01');
    // CoreF01 meets the 7-block target in blocks 1, 2, 4, 5, 7, 8, and 10.
    expect(regenerated.timeline.slice(5, 9).filter((block) => [...block.D, ...block.M, ...block.F].includes('CoreF01'))).toHaveLength(2);
    const regeneratedFieldPlayers = regenerated.timeline.flatMap((block) => [block.GK, ...block.D, ...block.M, ...block.F]);
    expect(regeneratedFieldPlayers).not.toContain('RotD01');
    expect(regeneratedFieldPlayers).not.toContain('CoreD03');
    const frankBlocks = regenerated.timeline
      .map((block, index) => [...block.D, ...block.M, ...block.F].includes('RotF01') ? index + 1 : null)
      .filter((block): block is number => block !== null);
    expect(frankBlocks).toEqual(expect.arrayContaining([5]));
    expect(frankBlocks).toHaveLength(3);
    initialGoalkeeperCounts.forEach((count, name) => expect(regenerated.timeline.filter((block) => block.GK === name).length).toBe(count));
    initialTotalCounts.forEach((count, name) => expect(regenerated.timeline.filter((block) => block.GK === name || [...block.D, ...block.M, ...block.F].includes(name)).length).toBe(count));
  });

  it('keeps other unavailable players out when one late arrival returns', () => {
    const team = regressionRoster as { season_roster: PlayerInput[] };
    const unavailable = new Set(['RotD01', 'RotF01', 'CoreD03']);
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'RotD05', second_half_gk: 'RotM03', allow_emergency_assignments: true };
    const initial = generateSchedule(game, team.season_roster.filter((player) => !unavailable.has(player.name)).map(createPlayer));
    const players = team.season_roster.map(createPlayer);
    const availableNames = team.season_roster.filter((player) => !unavailable.has(player.name) || player.name === 'RotF01').map((player) => player.name);
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: 'RotF01', action: 'available', block: 4, target_blocks: 3, minimum_blocks: 0, maximum_blocks: 3 }], availableNames, true);
    const fieldPlayers = regenerated.timeline.flatMap((block) => [block.GK, ...block.D, ...block.M, ...block.F]);
    const benchPlayers = regenerated.timeline.flatMap((block) => block.bench);

    expect(regenerated.available_player_names).toEqual(availableNames);
    expect(regenerated.available_player_names).toContain('RotF01');
    expect(regenerated.available_player_names).not.toContain('RotD01');
    expect(regenerated.available_player_names).not.toContain('CoreD03');
    expect(fieldPlayers).not.toContain('RotD01');
    expect(fieldPlayers).not.toContain('CoreD03');
    expect(benchPlayers).not.toContain('RotD01');
    expect(benchPlayers).not.toContain('CoreD03');
  });

  it('preserves Cameron total blocks when Frank arrives late', () => {
    const roster = seasonSimulationRoster();
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan', allow_emergency_assignments: true };
    const initial = generateSchedule(game, roster.filter((player) => player.name !== 'Frank').map(createPlayer));
    const players = roster.map(createPlayer);
    players.find((player) => player.name === 'Frank')!.available = false;
    const initialCameronBlocks = initial.timeline.filter((block) => block.GK === 'Cameron' || [...block.D, ...block.M, ...block.F].includes('Cameron')).length;
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: 'Frank', action: 'available', block: 4, target_blocks: 3, minimum_blocks: 3, maximum_blocks: 3 }], undefined, true);
    const regeneratedCameronBlocks = regenerated.timeline.filter((block) => block.GK === 'Cameron' || [...block.D, ...block.M, ...block.F].includes('Cameron')).length;

    expect(initialCameronBlocks).toBeGreaterThan(5);
    expect(regeneratedCameronBlocks).toBe(8);
  });

  it.each(['Blake', 'Sid', 'Frank'] as const)('places real-roster late arrival %s when arriving at block 5', (latePlayer) => {
    const rosterInputs = coachAssignedSeasonBackups(seasonSimulationRoster()).map((player) => player.name === 'Blake' ? { ...player, group: 'core' as const } : player);
    const unavailableNames = new Set(['Blake', 'Frank', 'Sid']);
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan', allow_emergency_assignments: true };
    const initial = generateSchedule(game, rosterInputs.filter((player) => !unavailableNames.has(player.name)).map(createPlayer));
    const players = rosterInputs.map(createPlayer);
    const availableNames = rosterInputs.filter((player) => !unavailableNames.has(player.name) || player.name === latePlayer).map((player) => player.name);
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: latePlayer, action: 'available', block: 4, target_blocks: 3, minimum_blocks: 3, maximum_blocks: 3 }], availableNames, true);
    const fieldBlocks = regenerated.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(latePlayer));

    expect(initial.errors).toEqual([]);
    expect(regenerated.errors).not.toContain(expect.stringContaining(`${latePlayer} could not be placed in block 5`));
    expect(regenerated.errors).not.toContain(expect.stringContaining(`${latePlayer} could not reach 3 blocks`));
    expect(regenerated.errors.filter((error) => /exceeds hard maximum|under minimum|under target/.test(error))).toEqual([]);
    expect(regenerated.errors.filter((error) => error.includes('under minimum'))).toEqual([]);
    expect(regenerated.needs_coach_approval).not.toBe(true);
    expect(regenerated.errors.some((error) => error.startsWith('Block 1:') && error.includes('endpoint'))).toBe(false);
    expect(regenerated.timeline.slice(0, 4).map(({ GK, D, M, F, positions }) => ({ GK, D, M, F, positions })))
      .toEqual(initial.timeline.slice(0, 4).map(({ GK, D, M, F, positions }) => ({ GK, D, M, F, positions })));
    expect(fieldBlocks).toHaveLength(3);
    if (latePlayer === 'Sid') {
      const count = (timeline: typeof initial.timeline, name: string): number => timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(name)).length;
      const reductions = rosterInputs
        .map((player) => ({ name: player.name, reduction: count(initial.timeline, player.name) - count(regenerated.timeline, player.name) }))
        .filter(({ reduction }) => reduction > 0);
      expect(reductions.every(({ reduction }) => reduction === 1)).toBe(true);
      expect(reductions.reduce((total, { reduction }) => total + reduction, 0)).toBe(3);
    }
    expect(regenerated.timeline[4].D.concat(regenerated.timeline[4].M, regenerated.timeline[4].F)).toContain(latePlayer);
  });

  it.each([
    ['Blake', 2, 3],
    ['Sid', 2, 3],
    ['Frank', 2, 3],
    ['Max', 2, 3],
    ['Sawyer', 2, 3],
    ['Blake', 3, 3],
    ['Sid', 3, 3],
    ['Frank', 3, 3],
    ['Max', 3, 3],
    ['Sawyer', 3, 3],
    ['Blake', 4, 3],
    ['Sid', 4, 3],
    ['Frank', 4, 3],
    ['Max', 4, 3],
    ['Sawyer', 4, 3],
  ] as const)('places realistic late arrival %s at block %s', (latePlayer, arrivalBlock, targetBlocks) => {
    const rosterInputs = coachAssignedSeasonBackups(seasonSimulationRoster()).map((player) => {
      if (player.name === 'Blake') return { ...player, group: 'core' as const };
      if (player.name === 'Max' || player.name === 'Sawyer') return { ...player, backup_positions: ['M'] as const };
      return player;
    });
    const unavailableNames = new Set(['Blake', 'Frank', 'Sid']);
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan', allow_emergency_assignments: true };
    const initial = generateSchedule(game, rosterInputs.filter((player) => !unavailableNames.has(player.name)).map(createPlayer));
    const players = rosterInputs.map(createPlayer);
    const availableNames = rosterInputs.filter((player) => !unavailableNames.has(player.name) || player.name === latePlayer).map((player) => player.name);
    const startedAt = performance.now();
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: latePlayer, action: 'available', block: arrivalBlock - 1, target_blocks: targetBlocks, minimum_blocks: targetBlocks, maximum_blocks: targetBlocks }], availableNames, true);
    if (latePlayer === 'Sid' && arrivalBlock === 5) {
      expect(performance.now() - startedAt).toBeLessThan(5000);
    }
    const fieldBlocks = regenerated.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(latePlayer));
    expect(initial.errors).toEqual([]);
    expect(regenerated.errors).not.toContain(expect.stringContaining(`${latePlayer} could not be placed in block ${arrivalBlock}`));
    expect(regenerated.errors).not.toContain(expect.stringContaining(`${latePlayer} could not reach ${targetBlocks} blocks`));
    expect(regenerated.errors.filter((error) => /exceeds hard maximum|under minimum|under target/.test(error))).toEqual([]);
    expect(fieldBlocks).toHaveLength(targetBlocks);
    expect(regenerated.timeline[arrivalBlock - 1].D.concat(regenerated.timeline[arrivalBlock - 1].M, regenerated.timeline[arrivalBlock - 1].F)).toContain(latePlayer);
  });

  it.each([
    ['Alvin', 5, 3],
    ['Blake', 5, 3],
    ['Dane', 5, 3],
    ['Everett', 5, 3],
    ['Hanshith', 5, 3],
    ['Jonathan', 5, 3],
    ['Max', 5, 3],
    ['Sawyer', 5, 3],
    ['Sid', 5, 3],
    ['Blake', 3, 3],
    ['Blake', 7, 3],
    ['Sid', 3, 3],
    ['Sid', 7, 3],
    ['Blake', 9, 2],
    ['Max', 8, 3],
  ] as const)('places core late arrival %s at block %s', (latePlayer, arrivalBlock, targetBlocks) => {
    // These are roster-constrained limits: the remaining core reservations or exact slots
    // prevent a legal placement even though the aggregate block count is sufficient.
    const expectedLimits = new Set<string>();
    const rosterInputs = coachAssignedSeasonBackups(seasonSimulationRoster()).map((player) => player.name === 'Blake' ? { ...player, group: 'core' as const } : player);
    const unavailableNames = new Set(['Blake', 'Frank', 'Sid', latePlayer]);
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan', allow_emergency_assignments: true, disable_maximum_limits: unavailableNames.size >= 4 };
    const initial = generateSchedule(game, rosterInputs.filter((player) => !unavailableNames.has(player.name)).map(createPlayer));
    const players = rosterInputs.map(createPlayer);
    const availableNames = rosterInputs.filter((player) => !unavailableNames.has(player.name) || player.name === latePlayer).map((player) => player.name);
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: latePlayer, action: 'available', block: arrivalBlock - 1, target_blocks: targetBlocks, minimum_blocks: targetBlocks, maximum_blocks: targetBlocks }], availableNames, true);
    const fieldBlocks = regenerated.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(latePlayer));
    const errors = regenerated.errors.filter((error) => !error.includes('under minimum') && !error.includes('under target'));

    if (latePlayer === 'Sid' && arrivalBlock === 5) {
      expect(regenerated.needs_coach_approval).toBeFalsy();
    }

    const caseKey = `${latePlayer}:${arrivalBlock}`;
    const approvalCase = latePlayer === 'Blake' && arrivalBlock === 3
      ? 'entire_half'
      : latePlayer === 'Sid' && arrivalBlock === 3
        ? 'entire_half'
        : latePlayer === 'Blake' && arrivalBlock === 9
          ? 'entire_half'
          : latePlayer === 'Jonathan' && arrivalBlock === 5
            ? 'one_block'
            : latePlayer === 'Hanshith' && arrivalBlock === 5
                ? 'one_block'
                : latePlayer === 'Max' && arrivalBlock === 5
                  ? 'one_block'
                : null;
    if (approvalCase) {
      // Update 5: constrained late arrivals require explicit coach approval
      // instead of silently accepting a partial or structurally invalid schedule.
      expect(regenerated.needs_coach_approval).toBe(true);
      expect(regenerated.approval_candidates?.length).toBeGreaterThan(0);
      expect(regenerated.approval_scope).toBe(approvalCase);
      expect(regenerated.timeline.every((block) => block.D.length === 4 && block.M.length === 3 && block.F.length === 3)).toBe(true);
      if (latePlayer === 'Sid' && arrivalBlock === 5) {
        const approvedStartedAt = performance.now();
        const approvedName = regenerated.approval_candidates?.[0];
        if (!approvedName) throw new Error('Sid approval candidate missing');
        const approvedBefore = initial.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(approvedName)).length;
        const mahaswinBefore = initial.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes('Mahaswin')).length;
        const approved = regenerateSchedule(
          { ...game, late_arrival_approval: { player: latePlayer, scope: approvalCase, block: arrivalBlock } },
          players,
          initial.timeline,
          [{ player: latePlayer, action: 'available', block: arrivalBlock - 1, target_blocks: targetBlocks, minimum_blocks: targetBlocks, maximum_blocks: targetBlocks }],
          availableNames,
          true,
          approvedName,
        );
        expect(performance.now() - approvedStartedAt).toBeLessThan(5000);
        expect(approved.timeline).toHaveLength(game.total_blocks);
        expect(approved.needs_coach_approval).not.toBe(true);
        expect(approved.timeline.slice(0, arrivalBlock - 1).every((block) => !block.bench.includes(latePlayer) && block.bench.length === 5)).toBe(true);
        expect(approved.timeline[arrivalBlock - 1].D.concat(approved.timeline[arrivalBlock - 1].M, approved.timeline[arrivalBlock - 1].F)).toContain(latePlayer);
        expect(approved.timeline[arrivalBlock - 1].bench).toHaveLength(6);
        expect(approved.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(approvedName))).toHaveLength(approvedBefore + 1);
        expect(approved.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes('Mahaswin'))).toHaveLength(mahaswinBefore);
      }
      return;
    }
    const passed = errors.length === 0 && fieldBlocks.length === targetBlocks;
    console.log(`${latePlayer} at block ${arrivalBlock}: ${passed ? 'PASSED' : expectedLimits.has(caseKey) ? 'EXPECTED LIMIT' : 'FAILED'}${errors.length ? ` - ${errors.join(' | ')}` : ''}`);
    if (!passed) console.log('strict-window', JSON.stringify(regenerated.timeline.slice(arrivalBlock - 1).map((block, index) => ({ block: arrivalBlock + index, D: block.D, M: block.M, F: block.F }))));
    if (expectedLimits.has(caseKey)) {
      console.log('stress-evidence', JSON.stringify({
        caseKey,
        latePlayerStats: players.find((player) => player.name === latePlayer),
        eligibleByGroup: Object.fromEntries(['D', 'M', 'F'].map((group) => [group, players.filter((player) => player.available && player.general_positions.includes(group)).map((player) => player.name)])),
        lateWindow: regenerated.timeline.slice(arrivalBlock - 1).map((block, index) => ({ block: arrivalBlock + index, D: block.D, M: block.M, F: block.F })),
      }));
      expect(passed).toBe(false);
      return;
    }
    expect(initial.errors).toEqual([]);
    expect(errors).toEqual([]);
    expect(fieldBlocks).toHaveLength(targetBlocks);
    expect(regenerated.timeline[arrivalBlock - 1].D.concat(regenerated.timeline[arrivalBlock - 1].M, regenerated.timeline[arrivalBlock - 1].F)).toContain(latePlayer);
  });

  it('allows core Blake to skip the impossible first endpoint when arriving late', () => {
    const latePlayer = 'Blake' as const;
    const roster = [
      ...seasonSimulationRoster().map((player) => player.name === 'Blake' ? { ...player, group: 'core' as const } : player),
      { name: 'GK1', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
      { name: 'GK2', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ];
    const game = { game_format: '11v11' as const, has_goalkeeper: true, total_blocks: 10, formation: '4-3-3', first_half_gk: 'GK1', second_half_gk: 'GK2', allow_emergency_assignments: true };
    const initial = generateSchedule(game, roster.filter((player) => player.name !== latePlayer).map(createPlayer));
    const players = roster.map(createPlayer);
    players.find((player) => player.name === latePlayer)!.available = false;
    const regenerated = regenerateSchedule(game, players, initial.timeline, [{ player: latePlayer, action: 'available', block: 4, target_blocks: 3, minimum_blocks: 3, maximum_blocks: 3 }], undefined, true);

    expect(initial.errors).toEqual([]);
    expect(regenerated.errors).not.toContain(expect.stringContaining(`Block 1: core player ${latePlayer}`));
    expect(regenerated.errors).not.toContain(expect.stringContaining(`${latePlayer} could not be placed in block 5`));
    expect(regenerated.errors).not.toContain(expect.stringContaining(`${latePlayer} could not reach 3 blocks`));
    expect([...regenerated.timeline[4].D, ...regenerated.timeline[4].M, ...regenerated.timeline[4].F]).toContain(latePlayer);
    expect([...regenerated.timeline[9].D, ...regenerated.timeline[9].M, ...regenerated.timeline[9].F]).toContain(latePlayer);
    expect(regenerated.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(latePlayer))).toHaveLength(3);
  });

  it('keeps feasible-capacity but illegal core endpoint misses blocking', () => {
    const players = [
      { name: 'Core Midfielder', group: 'core' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Defender', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['CB'] },
      { name: 'Keeper', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 2, formation: '1-0', first_half_gk: 'Keeper', second_half_gk: 'Keeper' }, players);

    expect(result.errors.filter((error) => error.includes('Core Midfielder') && error.includes('endpoint'))).toHaveLength(2);
  });
});

function compactRoster(): PlayerInput[] {
  return [
    ...['LB1', 'LB2', 'RB1', 'RB2'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['LB', 'RB'] })),
    ...['M1', 'M2', 'M3', 'M4'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LCM', 'RCM', 'LM', 'RM'] })),
    ...['F1', 'F2'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] })),
    { name: 'GK1', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'] },
    { name: 'GK2', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'] },
  ];
}

describe('quota fairness and controlled coverage', () => {
  function singleGroupRoster(names: string[]): PlayerInput[] {
    return [
      ...names.map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['CB'] })),
      { name: 'GK1', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
      { name: 'GK2', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ];
  }

  function singleGroupGame(totalBlocks: number, disableMaximumLimits = false, formation = '1-0'): GameInput {
    return { total_blocks: totalBlocks, formation, first_half_gk: 'GK1', second_half_gk: 'GK2', disable_maximum_limits: disableMaximumLimits };
  }

  it('keeps a feasible rotation inside intended bands when capacity allows', () => {
    const players = singleGroupRoster(['D1', 'D2', 'D3', 'D4']).map(createPlayer);
    const result = generateSchedule(singleGroupGame(4, false, '2-0'), players);
    const fieldPlayers = players.filter((player) => !player.name.startsWith('GK'));
    const counts = fieldPlayers.map((player) => player.field_blocks);

    expect(result.errors.filter((error) => error.includes('D1') || error.includes('D2') || error.includes('D3') || error.includes('D4'))).toEqual([]);
    expect(Math.max(...counts) - Math.min(...counts), JSON.stringify(counts)).toBeLessThanOrEqual(1);
    expect(fieldPlayers.every((player) => player.field_blocks <= player.maximum_blocks)).toBe(true);
  });

  it('enforces group maximums before considering coverage failures', () => {
    const players = singleGroupRoster(['D1', 'D2', 'D3']).map(createPlayer);
    const result = generateSchedule({ ...singleGroupGame(10), formation: '2-0' }, players);
    const fieldPlayers = players.filter((player) => player.name !== 'GK');

    expect(fieldPlayers.every((player) => player.field_blocks <= player.maximum_blocks)).toBe(true);
    expect(fieldPlayers.every((player) => player.field_blocks <= player.hard_maximum_blocks)).toBe(true);
    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
  });

  it('enforces hard maximums when a single legal player cannot cover every block', () => {
    const players = singleGroupRoster(['D1']).map(createPlayer);
    const result = generateSchedule(singleGroupGame(10), players);
    const defender = players.find((player) => player.name === 'D1');

    expect(defender?.field_blocks).toBeLessThanOrEqual(defender?.hard_maximum_blocks ?? 0);
    expect(result.errors.some((error) => error.includes('unassigned'))).toBe(true);
    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
  });

  it('preflights per-level maximum capacity for an all-rotational roster', () => {
    const players = Array.from({ length: 15 }, (_, index) => createPlayer({
      name: `Rotational ${index + 1}`,
      group: 'rotational',
      general_positions: ['D', 'M', 'F'],
      primary_positions: ['ANY'],
    }));
    players.push(createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }));

    const result = computeBlockTargets({
      total_blocks: 10,
      formation: '4-3-3',
      quota_exempt_players: new Set<string>(),
      replacement_bonuses: {},
      disable_maximum_limits: false,
      season_game_number: 1,
      season_seed: 1,
    } as Game, players);

    expect(result.errors.some((error) => error.startsWith('Preflight:'))).toBe(false);
  });

  it('does not report independent position minimum deficits for flexible players', () => {
    const players = Array.from({ length: 15 }, (_, index) => createPlayer({
      name: `Flexible ${index + 1}`,
      group: 'rotational',
      general_positions: ['D', 'M', 'F'],
      primary_positions: ['ANY'],
    }));
    players.push(createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }));

    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'GK',
      second_half_gk: 'GK',
    }, players);

    expect(result.warnings.filter((warning) => /[DMF] minimums require/.test(warning))).toEqual([]);
  });

  it('allows intended-band and hard-limit overflow only with maximum limits disabled', () => {
    const players = singleGroupRoster(['D1']).map(createPlayer);
    const result = generateSchedule(singleGroupGame(10, true), players);
    const defender = players.find((player) => player.name === 'D1');

    expect(defender?.field_blocks).toBe(10);
    expect(result.errors.filter((error) => error.includes('maximum'))).toEqual([]);
  });

  it('uses distinct minimum, intended maximum, and target rounding policies', () => {
    expect(minimumBlocksForPercentage(5, 0.5)).toBe(3);
    expect(intendedMaximumBlocksForPercentage(5, 0.5)).toBe(2);
    expect(targetBlocksForPercentage(5, 0.5)).toBe(3);
  });

  it('keeps rotational high targets at 60% below the 70% maximum', () => {
    const players = ['R1', 'R2', 'R3', 'R4'].map((name) => createPlayer({
      name,
      group: 'rotational',
      general_positions: ['D'],
      primary_positions: ['CB'],
    }));
    computeBlockTargets({
      total_blocks: 10,
      formation: '2-0',
      quota_exempt_players: new Set<string>(),
      replacement_bonuses: {},
      disable_maximum_limits: false,
      season_game_number: 1,
      season_seed: 1,
    } as Game, players);

    expect(players.map((player) => player.target_blocks).sort()).toEqual([5, 5, 6, 6]);
    expect(players.every((player) => player.hard_maximum_blocks === 7)).toBe(true);
  });

  it('uses one shared Core target and exposes short-game feasibility metadata', () => {
    const players = [
      createPlayer({ name: 'Core A', group: 'core_a', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'Core B', group: 'core_b', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'Extra', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
    ];
    const game = {
      total_blocks: 3,
      formation: '1-0',
      first_half_gk: null,
      second_half_gk: null,
      quota_exempt_players: new Set<string>(),
      replacement_bonuses: {},
      disable_maximum_limits: false,
      season_game_number: 1,
      season_seed: 1,
    } as Game;
    const result = computeBlockTargets(game, players);
    const coreTargets = players.filter((player) => player.group.startsWith('core')).map((player) => player.target_blocks);

    expect(coreTargets).toEqual([3, 3]);
    expect(result.metadata.quota_feasibility).toEqual({
      minimumRequirement: 8,
      legalAvailableCapacity: 3,
      minimumsFeasible: false,
      affectedPlayers: ['Core A', 'Core B', 'Extra'],
      affectedGroups: ['D'],
    });
  });

  it('reports position-specific preflight capacity warnings', () => {
    const players = [
      ...['D1', 'D2', 'D3'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB'] })),
      ...['M1', 'M2', 'M3'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LM', 'CM', 'RM'] })),
      ...['F1', 'F2', 'F3'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['LF', 'CF', 'RF'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.warnings).toContain('Preflight: only 3 available D players can cover 4 D slots.');
  });

  it('calculates legal position capacity warnings before generation', () => {
    const players = [
      ...['D1', 'D2', 'D3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB'] })),
      ...['M1', 'M2', 'M3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'CM', 'RM'] })),
      ...['F1', 'F2', 'F3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['F'], primary_positions: ['LF', 'CF', 'RF'] })),
    ];

    expect(positionCapacityWarnings('4-3-3', players)).toContain('Preflight: only 3 available D players can cover 4 D slots.');
  });

  it('counts dual-role goalkeepers as field players unless assigned to goal', () => {
    const dualRoleKeeper = createPlayer({ name: 'Dual GK', group: 'rotational', general_positions: ['GK', 'F'], primary_positions: ['GK', 'CF'] });
    const dedicatedKeeper = createPlayer({ name: 'Pure GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] });

    expect(fieldCapacityByHalf(dualRoleKeeper, 10)).toEqual([4, 4]);
    expect(fieldCapacityByHalf(dualRoleKeeper, 10, { firstHalfGk: 'Dual GK' })).toEqual([0, 3]);
    expect(fieldCapacityByHalf(dedicatedKeeper, 10)).toEqual([0, 0]);
  });

  it('reports a position deficit limited to one half', () => {
    const defenders = ['D1', 'D2', 'D3', 'D4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }));
    const dualRoleKeeper = createPlayer({ name: 'Dual GK', group: 'rotational', general_positions: ['GK', 'D'], primary_positions: ['GK', 'CB'] });

    expect(positionCapacityDeficits('3-0-0', [...defenders, dualRoleKeeper], 10, { firstHalfGk: 'Dual GK' })).toEqual([]);
    expect(positionCapacityDeficits('5-0-0', [...defenders, dualRoleKeeper], 10, { firstHalfGk: 'Dual GK' })).toEqual([
      { position: 'D', candidates: [] },
    ]);
  });

  it('ranks load-bearing primary players after safer backup candidates', () => {
    const players = [
      ...['Alvin', 'Everett', 'Ryan', 'Yash'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] })),
      ...['Artur', 'Brad', 'Mahaswin'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] })),
      ...['Midfield backup 1', 'Midfield backup 2'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] })),
    ];

    expect(positionCapacityCandidates('F', players, 10, '4-3-3')).toEqual(['Artur', 'Brad', 'Mahaswin', 'Alvin', 'Everett', 'Ryan', 'Yash']);
  });

  it('recommends eligible backup-position candidates by capacity and name', () => {
    const unavailablePlayer = createPlayer({ name: 'Unavailable Player', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] });
    unavailablePlayer.available = false;
    const players = [
      createPlayer({ name: 'Eligible Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'High Capacity', group: 'core', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'Alpha Capacity', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'Zulu Capacity', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'Already Backup', group: 'rotational', general_positions: ['M'], backup_positions: ['D'], primary_positions: ['CM'] }),
      createPlayer({ name: 'Dedicated Keeper', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'Forbidden Player', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'], forbidden_positions: ['D'] }),
      unavailablePlayer,
    ];

    expect(positionCapacityDeficits('2-0-0', players, 10)).toEqual([
      { position: 'D', candidates: ['High Capacity', 'Alpha Capacity', 'Zulu Capacity'] },
    ]);
  });

  it('reports an empty candidate list and multiple position deficits', () => {
    const onlyDefender = createPlayer({ name: 'Only Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] });

    expect(positionCapacityDeficits('2-0-0', [onlyDefender], 10)).toEqual([{ position: 'D', candidates: [] }]);
    expect(positionCapacityDeficits('1-1-1', [], 10)).toEqual([
      { position: 'D', candidates: [] },
      { position: 'M', candidates: [] },
      { position: 'F', candidates: [] },
    ]);
  });

  it('reports infeasible fixed-roster 11v11 capacity', () => {
    const testCase = fingerprintCases.find(({ id }) => id === '11v11-position-flexibility');
    if (!testCase) throw new Error('11v11 fingerprint fixture is missing.');

    const result = generateSchedule(
      testCase.game as GameInput,
      testCase.players.map((player) => createPlayer(player as PlayerInput)),
    );

    expect(result.errors).toContain('Preflight: this roster cannot legally support any even block count for the requested 4-4-2 formation.');
    expect(result.warnings.some((warning) => warning.includes('reduce the game'))).toBe(false);
  });

  it('allows exactly 11 available players to play every block when maximums are disabled', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB', 'RB'] })),
      ...['M1', 'M2', 'M3'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LM', 'CM', 'RM'] })),
      ...['F1', 'F2', 'F3'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['LF', 'CF', 'RF'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'GK',
      second_half_gk: 'GK',
      disable_maximum_limits: true,
    }, players);

    expect(result.errors.filter((error) => error.includes('maximum'))).toEqual([]);
    result.timeline.forEach((block) => assertBlockInvariants(block, 10, true));
    expect(players.every((player) => player.field_blocks + player.gk_blocks === 10)).toBe(true);
  });

  it('fills every field player to eight before assigning a ninth in maximum override mode', () => {
    const players = [
      ...Array.from({ length: 11 }, (_, index) => ({ name: `Field ${index + 1}`, group: 'rotational' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'GK', second_half_gk: 'GK', disable_maximum_limits: true }, players);
    const fieldNames = players.filter((player) => player.name !== 'GK').map((player) => player.name);
    const counts = new Map(fieldNames.map((name) => [name, 0]));

    result.timeline.forEach((block) => {
      Object.entries(block.positions).filter(([position]) => position !== 'GK').forEach(([, name]) => counts.set(name, (counts.get(name) ?? 0) + 1));
    });
    const values = [...counts.values()];
    expect(Math.min(...values), `${JSON.stringify([...counts])}`).toBeGreaterThanOrEqual(8);
    expect(Math.max(...values), `${JSON.stringify([...counts])}`).toBeLessThanOrEqual(10);
  }, 20_000);

  it('uses phased core-first filling in maximum override mode', () => {
    const players = [
      ...['Core 1', 'Core 2', 'Core 3', 'Core 4'].map((name) => ({ name, group: 'core' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      ...['Rot 1', 'Rot 2', 'Rot 3', 'Rot 4'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      ...['Dev 1', 'Dev 2', 'Dev 3', 'Dev 4'].map((name) => ({ name, group: 'developing' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'GK', second_half_gk: 'GK', disable_maximum_limits: true }, players);

    expect(result.errors).toEqual([]);
    const corePlayers = players.filter((player) => player.group === 'core');
    const rotationalPlayers = players.filter((player) => player.group === 'rotational');
    const developingPlayers = players.filter((player) => player.group === 'developing');
    const average = (group: typeof corePlayers): number => group.reduce((total, player) => total + player.field_blocks, 0) / group.length;
    expect(corePlayers.filter((player) => player.field_blocks >= 9)).toHaveLength(3);
    expect(average(rotationalPlayers)).toBeGreaterThan(average(developingPlayers));
    expect(Math.max(...developingPlayers.map((player) => player.field_blocks))).toBe(8);
  }, 20_000);

  it('plans core blocks across both halves before filling remaining positions', () => {
    const players = [
      ...compactRoster(),
      { name: 'Core F1', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] },
      { name: 'Core F2', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
    for (const player of players.filter((candidate) => candidate.group === 'core')) {
      expect(player.field_blocks).toBeGreaterThanOrEqual(player.minimum_blocks);
      expect(player.blocks_by_half[0]).toBeGreaterThan(0);
      expect(player.blocks_by_half[1]).toBeGreaterThan(0);
    }
  });

  it('starts available core players in the first and last block for supported game lengths', () => {
    for (const totalBlocks of [4, 10]) {
      const players = [
        { name: 'Core D', group: 'core' as const, general_positions: ['D'], primary_positions: ['CB'] },
        { name: 'Core M', group: 'core' as const, general_positions: ['M'], primary_positions: ['CM'] },
        { name: 'Core F', group: 'core' as const, general_positions: ['F'], primary_positions: ['ST'] },
        ...Array.from({ length: 7 }, (_, index) => ({ name: `Extra ${index + 1}`, group: 'rotational' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
        { name: 'GK1', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
        { name: 'GK2', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
      ].map(createPlayer);
      const result = generateSchedule({ total_blocks: totalBlocks, game_format: '11v11', formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2', disable_maximum_limits: true }, players);
      const endpointBlocks = [result.timeline[0], result.timeline[totalBlocks - 1]];

      expect(result.errors).toEqual([]);
      endpointBlocks.forEach((block) => {
        expect(block.D).toContain('Core D');
        expect(block.M).toContain('Core M');
        expect(block.F).toContain('Core F');
      });
    }
    for (const totalBlocks of [4, 6, 8, 10, 12, 14, 16]) {
      expect(() => new SeasonSetup({ game_length_minutes: 80, game_format: '11v11', total_blocks: totalBlocks, formation: '4-4-2' })).not.toThrow();
    }
  });

  it('keeps every legal multi-position core player at both endpoints', () => {
    const players = seasonSimulationRoster().map(createPlayer);
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      disable_maximum_limits: true,
    }, players);
    const corePlayers = players.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group));

    if (result.metadata.quota_feasibility?.minimumsFeasible) {
      expect(result.errors).toEqual([]);
      for (const [index, block] of [result.timeline[0], result.timeline[9]].entries()) {
        const fieldPlayers = new Set([...block.D, ...block.M, ...block.F]);
        corePlayers.forEach((player) => expect(fieldPlayers, `endpoint ${index === 0 ? 'first' : 'last'} missing ${player.name}`).toContain(player.name));
      }
    } else {
      expect(result.metadata.quota_feasibility?.affectedPlayers.length).toBeGreaterThan(0);
    }
  });

  it('generates the feasible 16-player endpoint roster', () => {
    const players = [
      { name: 'Alvin', group: 'core' as const, general_positions: ['D'], primary_positions: ['LCB', 'RCB'], backup_positions: ['M'] },
      { name: 'Artur', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Brad', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['F'] },
      { name: 'Cameron', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY', 'GK'] },
      { name: 'Dane', group: 'core' as const, general_positions: ['M'], primary_positions: ['LM', 'RM'], backup_positions: ['F'] },
      { name: 'Eitan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY', 'GK'], backup_positions: ['M'] },
      { name: 'Everett', group: 'core' as const, general_positions: ['D'], primary_positions: ['LCB', 'RCB'], backup_positions: ['CM'] },
      { name: 'Hanshith', group: 'core' as const, general_positions: ['F'], primary_positions: ['CF', 'GK'], backup_positions: ['M', 'CM'] },
      { name: 'Jonathan', group: 'core' as const, general_positions: ['M'], primary_positions: ['CM'], backup_positions: ['D'] },
      { name: 'Mahaswin', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'] },
      { name: 'Max', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF'] },
      { name: 'Prerith', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['LB', 'RB'] },
      { name: 'Ryan', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M'] },
      { name: 'Sawyer', group: 'core' as const, general_positions: ['F'], primary_positions: ['RF'] },
      { name: 'Thanish', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['LB', 'RB'] },
      { name: 'Yash', group: 'rotational' as const, general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-3-3', first_half_gk: 'Cameron', second_half_gk: 'Eitan' }, players);

    expect(result.errors).toEqual([]);
    expect(result.timeline[0].D).toContain('Alvin');
    expect(result.timeline[9].D).toHaveLength(4);
    expect(result.timeline[9].M).toHaveLength(3);
    expect(result.timeline[9].F).toHaveLength(3);
    const endpointFieldPlayers = new Set([...result.timeline[9].D, ...result.timeline[9].M, ...result.timeline[9].F]);
    ['Dane', 'Everett', 'Hanshith', 'Jonathan', 'Max', 'Sawyer'].forEach((name) => expect(endpointFieldPlayers).toContain(name));
    expect(result.timeline[9].F).toEqual(expect.arrayContaining(['Hanshith', 'Max', 'Sawyer']));
  });

  it('generates a later season game with prior history and mixed eligibility', () => {
    const players = seasonSimulationRoster().map(createPlayer);
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      season_total_games: 10,
      season_game_number: 3,
      season_player_blocks: Object.fromEntries(players.map((player) => [player.name, player.name.startsWith('Core') ? 16 : 8])),
      season_position_starts: Object.fromEntries(players.map((player) => [player.name, { D: 1, M: 1, F: 1 }])),
      season_goalkeeper_starts: { Cameron: 1, Eitan: 1 },
    }, players);

    expect(result.timeline).toHaveLength(10);
    expect(result.errors).not.toContain('undefined is not a function');
  });

  // The endpoint reservation search is intentionally exhaustive for this
  // constrained roster; allow it to finish instead of reporting a false timeout.
  it('spreads core rests through the middle window and staggers substitutions', { timeout: 180000 }, () => {
    const players = [
      ...Array.from({ length: 8 }, (_, index) => createPlayer({
        name: `Core ${index + 1}`,
        group: 'core',
        general_positions: ['D', 'M', 'F'],
        primary_positions: [index < 4 ? 'D' : index < 6 ? 'M' : 'F'],
      })),
      ...Array.from({ length: 4 }, (_, index) => createPlayer({
        name: `Rot D${index + 1}`,
        group: 'rotational',
        general_positions: ['D'],
        primary_positions: ['D'],
      })),
      ...Array.from({ length: 3 }, (_, index) => createPlayer({
        name: `Rot M${index + 1}`,
        group: 'rotational',
        general_positions: ['M'],
        primary_positions: ['M'],
      })),
      ...Array.from({ length: 2 }, (_, index) => createPlayer({
        name: `Rot F${index + 1}`,
        group: 'rotational',
        general_positions: ['F'],
        primary_positions: ['F'],
      })),
      createPlayer({ name: 'GK1', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'GK2', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'GK1',
      second_half_gk: 'GK2',
      season_total_games: 1,
      season_game_number: 1,
    }, players);
    const coreNames = players.filter((player) => player.group === 'core').map((player) => player.name);
    const coreBenchCounts = result.timeline.map((block) => coreNames.filter((name) => block.bench.includes(name)).length);
    const middleBenchBlocks = coreBenchCounts.slice(1, -1);
    const restWindowBenchBlocks = coreBenchCounts.slice(3, 7);
    const totalCoreBenchBlocks = middleBenchBlocks.reduce((sum, count) => sum + count, 0);
    const windowCoreBenchBlocks = restWindowBenchBlocks.reduce((sum, count) => sum + count, 0);

    expect(result.errors).toEqual([]);
    for (const block of [result.timeline[0], result.timeline[9]]) {
      const fieldPlayers = new Set([...block.D, ...block.M, ...block.F]);
      coreNames.forEach((name) => expect(fieldPlayers).toContain(name));
    }
    expect(totalCoreBenchBlocks).toBeGreaterThan(0);
    expect(windowCoreBenchBlocks / totalCoreBenchBlocks).toBeGreaterThanOrEqual(0.8);
    expect(Math.max(...middleBenchBlocks)).toBeLessThanOrEqual(Math.ceil(totalCoreBenchBlocks / 4));
    expect(result.movement_metrics?.max_turnovers_per_boundary).toBeLessThanOrEqual(6);
    expect(result.timeline.filter((block) => block.GK === 'GK1')).toHaveLength(5);
    expect(result.timeline.filter((block) => block.GK === 'GK2')).toHaveLength(5);
  });

  it('does not report endpoint misses when core demand exceeds endpoint capacity', () => {
    const players = [
      { name: 'Core D1', group: 'core' as const, general_positions: ['D'], primary_positions: ['CB'] },
      { name: 'Core D2', group: 'core' as const, general_positions: ['D'], primary_positions: ['CB'] },
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({
      total_blocks: 2,
      formation: '1-0-0',
      first_half_gk: 'GK',
      second_half_gk: 'GK',
      disable_maximum_limits: true,
    }, players);

    expect(result.errors.filter((error) => error.includes('core player') && error.includes('endpoint'))).toHaveLength(0);
  });

  it('keeps seven blocks as the core target while allowing an eighth legal block', () => {
    const players = [
      ...compactRoster(),
      ...['Core D1', 'Core D2', 'Core D3', 'Core D4', 'Core M1', 'Core M2', 'Core F1'].map((name) => ({ name, group: 'core' as const, general_positions: ['D'], primary_positions: ['LB', 'RB', 'LCB', 'RCB'] })),
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(players.filter((player) => player.group === 'core').every((player) => player.target_blocks === 7)).toBe(true);
    expect(players.filter((player) => player.group === 'core').every((player) => player.hard_maximum_blocks === 8)).toBe(true);
    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
  });

  it('does not rotate Core targets using cumulative season totals', () => {
    const players = [
      ...compactRoster().filter((player) => !player.general_positions?.includes('F')),
      { name: 'Core A', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] },
      { name: 'Core B', group: 'core' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] },
    ].map(createPlayer);
    generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2', season_game_number: 2, season_player_blocks: { 'Core A': 8, 'Core B': 0 } }, players);

    expect(players.find((player) => player.name === 'Core A')?.target_blocks).toBe(7);
    expect(players.find((player) => player.name === 'Core B')?.target_blocks).toBe(7);
  });

  it('reports exact-position starts separately from total position usage', () => {
    const players = compactRoster().map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);
    const firstBlockPlayers = Object.entries(result.timeline[0].positions).map(([position, player]) => [player, position]);

    expect(result.starting_position_counts).toBeDefined();
    firstBlockPlayers.forEach(([player, position]) => expect(result.starting_position_counts?.[player]?.[position]).toBe(1));
  });

  it('validates and locks a legal first block before exact-slot optimization', () => {
    const players = compactRoster().map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);
    const firstBlock = result.timeline[0];

    expect(result.errors.filter((error) => error.startsWith('First block:'))).toEqual([]);
    expect(new Set(Object.values(firstBlock.positions)).size).toBe(Object.values(firstBlock.positions).length);
    expect(firstBlock.D).toHaveLength(4);
    expect(firstBlock.M).toHaveLength(4);
    expect(firstBlock.F).toHaveLength(2);
    expect(firstBlock.positions.GK).toBe(firstBlock.GK);
  });

  it('allows a named-position player to use their general group for exact assignment', () => {
    const players = [
      ...compactRoster().filter((player) => !player.general_positions?.includes('M')),
      { name: 'M1', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LM'] },
      { name: 'M2', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LCM'] },
      { name: 'M3', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['RCM'] },
      { name: 'Versatile', group: 'rotational' as const, general_positions: ['M'], primary_positions: ['CAM'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
    expect(result.timeline.some((block) => Object.values(block.positions).includes('Versatile'))).toBe(true);
  });

  it('repairs avoidable defender minimum deficits when defender capacity permits', () => {
    const players = [
      ...['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['D'], primary_positions: ['LB', 'LCB', 'RCB', 'RB'] })),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['M'], primary_positions: ['LM', 'LCM', 'RCM', 'RM'] })),
      ...['F1', 'F2'].map((name) => ({ name, group: 'rotational' as const, general_positions: ['F'], primary_positions: ['LF', 'RF'] })),
      { name: 'GK1', group: 'rotational' as const, general_positions: ['GK'], primary_positions: ['GK'] },
      { name: 'GK2', group: 'rotational' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK1', second_half_gk: 'GK2' }, players);

    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
    expect(players.filter((player) => player.general_positions.includes('D')).every((player) => player.field_blocks >= 5)).toBe(true);
  });

  it('flags total and per-half hard maximum violations from final positions', () => {
    const formation = parseFormation('1-1-1');
    const slots = formationSlots(formation);
    const players = [
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'M', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'F', group: 'rotational', general_positions: ['F'], primary_positions: ['ST'] }),
    ];
    const defender = players.find((player) => player.name === 'D');
    if (!defender) throw new Error('test defender missing');
    defender.hard_maximum_blocks = 1;
    defender.max_blocks_per_half = 1;
    const timeline: ScheduleBlock[] = Array.from({ length: 3 }, () => ({
      GK: 'GK', D: ['D'], M: ['M'], F: ['F'], bench: [],
      positions: { GK: 'GK', CB: 'D', CM: 'M', ST: 'F' },
    }));

    const errors = validateTimeline(players, timeline, formation, slots, 3);
    expect(errors.some((error) => error.includes('D exceeds hard maximum'))).toBe(true);
    expect(errors.some((error) => error.includes('D exceeds the half 1 maximum'))).toBe(true);
  });

  it('recalculates cross-group switches from final positions', () => {
    const first: ScheduleBlock = {
      GK: 'GK', D: ['D'], M: ['M'], F: ['F'], bench: [], positions: { GK: 'GK', CB: 'D', CM: 'M', ST: 'F' },
    };
    const switched: ScheduleBlock = {
      GK: 'GK', D: ['M'], M: ['D'], F: ['F'], bench: [], positions: { GK: 'GK', CB: 'M', CM: 'D', ST: 'F' },
    };
    const blocks: ScheduleBlock[] = [
      first,
      switched,
      switched,
      switched,
    ];
    const metrics = calculateMovementMetrics(blocks, 4, [], { D: ['CB'], M: ['CM'], F: ['ST'] });

    expect(metrics.group_switches).toBe(2);
    expect(metrics.exact_slot_switches).toBe(2);
  });

  it('does not label a normal-planning defect as emergency when attendance is sufficient', () => {
    const roster = ['D', 'M', 'F'].map((name, index) => createPlayer({
      name,
      group: 'rotational',
      general_positions: [(['D', 'M', 'F'] as const)[index]],
      primary_positions: ['ANY'],
    }));
    const block: ScheduleBlock = {
      GK: 'GK', D: ['D'], M: ['D'], F: ['F'], bench: [],
      positions: { GK: 'GK', CB: 'D', CM: 'D', ST: 'F' },
    };
    const metrics = calculateMovementMetrics([block], 1, roster, { D: ['CB'], M: ['CM'], F: ['ST'] }, true);

    expect(metrics.emergency_assignments).toBe(0);
  });

  it('reports general and explicit backup assignment tiers separately', () => {
    const roster = [
      createPlayer({ name: 'General', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] }),
      createPlayer({ name: 'Backup', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['F'] }),
    ];
    const block: ScheduleBlock = {
      GK: '', D: ['General'], M: [], F: ['Backup'], bench: [],
      positions: { CB: 'General', ST: 'Backup' },
    };
    const metrics = calculateMovementMetrics([block], 1, roster, { D: ['CB'], M: [], F: ['ST'] });

    expect(metrics.general_assignments).toBe(1);
    expect(metrics.backup_assignments).toBe(1);
    expect(metrics.emergency_assignments).toBe(0);
  });

  it('scores equivalent central and striker slots as primary assignments', () => {
    const roster = [
      createPlayer({ name: 'Central Midfielder', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'Central Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'Striker', group: 'rotational', general_positions: ['F'], primary_positions: ['ST'] }),
    ];
    const block: ScheduleBlock = {
      GK: '', D: ['Central Defender'], M: ['Central Midfielder'], F: ['Striker'], bench: [],
      positions: { LCB: 'Central Defender', RCM: 'Central Midfielder', CF: 'Striker' },
    };

    const metrics = calculateMovementMetrics([block], 1, roster, { D: ['LCB'], M: ['RCM'], F: ['CF'] });

    expect(metrics.primary_assignments).toBe(3);
    expect(metrics.general_assignments).toBe(0);
  });

  it('places a CM-primary midfielder in a central 4-4-2 slot', () => {
    const players = [
      createPlayer({ name: 'CM Primary', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      ...['General 1', 'General 2', 'General 3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] })),
    ];
    const assignment = assignExactSlots(players, players.map((player) => player.name), formationSlots(parseFormation('4-4-2')).M, 'M', {});
    const primarySlot = Object.entries(assignment).find(([, name]) => name === 'CM Primary')?.[0];

    expect(['LCM', 'RCM']).toContain(primarySlot);
  });

  it.each(['CDM', 'CAM'])('treats %s as a central-midfield primary zone', (primaryPosition) => {
    const players = [
      createPlayer({ name: 'Zone Primary', group: 'rotational', general_positions: ['M'], primary_positions: [primaryPosition] }),
      ...['General 1', 'General 2'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] })),
    ];
    const assignment = assignExactSlots(players, players.map((player) => player.name), ['LM', 'CM', 'RM'], 'M', {});

    expect(assignment.CM).toBe('Zone Primary');
  });

  it('surfaces slot-only backups to their position group without widening slot assignment', () => {
    const slotBackup = createPlayer({ name: 'Right Back Backup', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['RB'] });

    expect(backupEligiblePlayers([slotBackup], 'D')).toEqual([slotBackup]);
    expect(backupEligiblePlayers([slotBackup], 'M')).toEqual([]);
    expect(canCoverSlot(slotBackup, 'RB', 'D')).toBe(true);
    expect(canCoverSlot(slotBackup, 'LB', 'D')).toBe(false);
  });

  it('uses a slot-only right-back backup to complete a defender group', () => {
    const players = [
      ...['D1', 'D2', 'D3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['D'] })),
      createPlayer({ name: 'Right Back Backup', group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['RB'] }),
      ...['M1', 'M2', 'M3', 'M4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['M'] })),
      ...['F1', 'F2'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['F'], primary_positions: ['F'] })),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 1, formation: '4-4-2', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.errors).toEqual([]);
    expect(result.timeline[0].positions.RB).toBe('Right Back Backup');
  });

  it('ranks primary group players ahead of general group players', () => {
    const primaryDefender = createPlayer({ name: 'Primary Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['RB'] });
    const generalDefender = createPlayer({ name: 'General Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] });

    expect(positionalPriority(primaryDefender, 'D')).toBeLessThan(positionalPriority(generalDefender, 'D'));
  });

  it('starts a primary defender before a general defender in group planning', () => {
    const players = [
      createPlayer({ name: 'StarRB', group: 'rotational', general_positions: ['D'], primary_positions: ['RB'] }),
      createPlayer({ name: 'General Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] }),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 2, formation: '1-0', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.timeline[0].D).toContain('StarRB');
  });

  it('uses positional eligibility only when emergency mode is active', () => {
    const roster = [createPlayer({ name: 'Defender', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] })];
    const block: ScheduleBlock = { GK: '', D: [], M: ['Defender'], F: [], bench: [], positions: { CM: 'Defender' } };
    const slots = { D: [], M: ['CM', 'RM'], F: [] };

    expect(calculateMovementMetrics([block], 1, roster, slots, false).emergency_assignments).toBe(0);
    expect(calculateMovementMetrics([block], 1, roster, slots, true).emergency_assignments).toBe(1);
  });

  it('does not count emergency assignments with eleven available players', () => {
    const roster = [
      ...['D1', 'D2', 'D3', 'D4'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] })),
      ...['M1', 'M2', 'M3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['M'], primary_positions: ['ANY'] })),
      ...['F1', 'F2', 'F3'].map((name) => createPlayer({ name, group: 'rotational', general_positions: ['F'], primary_positions: ['ANY'] })),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const block: ScheduleBlock = {
      GK: '', D: ['D1', 'D2', 'D3', 'D4'], M: ['M1', 'M2', 'M3'], F: ['F1', 'F2', 'F3'], bench: [],
      positions: { LB: 'D1', LCB: 'D2', RCB: 'D3', RB: 'D4', LM: 'M1', CM: 'M2', RM: 'M3', LF: 'F1', CF: 'F2', RF: 'F3' },
    };
    const metrics = calculateMovementMetrics([block], 1, roster, { D: ['LB', 'LCB', 'RCB', 'RB'], M: ['LM', 'CM', 'RM'], F: ['LF', 'CF', 'RF'] }, true);

    expect(metrics.emergency_assignments).toBe(0);
  });

  it('reports a structural shortage instead of hiding it behind fallback', () => {
    const players = [
      createPlayer({ name: 'D1', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'D2', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const result = generateSchedule({ total_blocks: 1, formation: '1-1-0', first_half_gk: 'GK', second_half_gk: 'GK', allow_emergency_assignments: true }, players);

    expect(result.errors.some((error) => error.includes('unassigned'))).toBe(true);
    expect(result.movement_metrics?.emergency_assignments ?? 0).toBe(0);
  });

  it('optimizes coupled adjacent assignments instead of moving a switch', () => {
    const roster = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'X'].map((name) => createPlayer({
      name, group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'],
    }));
    const slots = { D: ['LB', 'LCB', 'RCB', 'RB'], M: [], F: [] };
    const block = (names: string[]): ScheduleBlock => ({
      GK: '', D: names, M: [], F: [], bench: [],
      positions: { LB: names[0], LCB: names[1], RCB: names[2], RB: names[3] },
    });
    const timeline = [
      block(['A', 'B', 'C', 'D']),
      block(['B', 'E', 'C', 'D']),
      block(['X', 'E', 'F', 'G']),
      block(['X', 'E', 'F', 'G']),
      block(['X', 'E', 'F', 'G']),
      block(['X', 'E', 'F', 'G']),
    ];
    const before = calculateMovementMetrics(timeline, 6, roster, slots);

    optimizeExactSlotSwitches({ total_blocks: 6 } as Game, roster, timeline, slots, 1);

    const after = calculateMovementMetrics(timeline, 6, roster, slots);
    expect(before.exact_slot_switches).toBe(1);
    expect(after.exact_slot_switches).toBe(0);
  });

  it('prioritizes primary-central placement over exact-slot switches', () => {
    const primary = createPlayer({ name: 'Primary', group: 'rotational', general_positions: ['D'], primary_positions: ['RB'] });
    const general = createPlayer({ name: 'General', group: 'rotational', general_positions: ['D'], primary_positions: ['ANY'] });
    const slots = { D: ['LB', 'RB'], M: [], F: [] };
    const block = (positions: Record<string, string>): ScheduleBlock => ({
      GK: '', D: [positions.LB, positions.RB], M: [], F: [], bench: [], positions,
    });
    const timeline = [
      block({ LB: 'Primary', RB: 'General' }),
      block({ LB: 'Primary', RB: 'General' }),
      block({ LB: 'Primary', RB: 'General' }),
      block({ LB: 'Primary', RB: 'General' }),
    ];

    optimizeExactSlotSwitches({ total_blocks: 4 } as Game, [primary, general], timeline, slots, 2);

    const metrics = calculateMovementMetrics(timeline, 4, [primary, general], slots);
    expect(timeline[1].positions).toMatchObject({ LB: 'General', RB: 'Primary' });
    expect(metrics.primary_assignments).toBe(3);
    expect(metrics.exact_slot_switches).toBe(2);
  });

  it('estimates additional eligible players from missing slots by half', () => {
    const formation = parseFormation('4-3-3');
    const makeBlock = (forwards: string[]): ScheduleBlock => ({
      GK: 'GK', D: ['D1', 'D2', 'D3', 'D4'], M: ['M1', 'M2', 'M3'], F: forwards, bench: [],
      positions: {
        GK: 'GK', LB: 'D1', LCB: 'D2', RCB: 'D3', RB: 'D4', LM: 'M1', CM: 'M2', RM: 'M3',
        LF: forwards[0] ?? 'UNASSIGNED', CF: forwards[1] ?? 'UNASSIGNED', RF: forwards[2] ?? 'UNASSIGNED',
      },
    });
    const timeline = [
      makeBlock(['F1']), makeBlock(['F1']), makeBlock(['F1']), makeBlock(['F1']), makeBlock(['F1']),
      makeBlock(['F1']), makeBlock(['F1']), makeBlock(['F1']), makeBlock([]), makeBlock([]),
    ];

    expect(estimateAdditionalPlayersNeeded(timeline, formation, 10)).toEqual([
      'Please assign 3 more Forwards to successfully complete this schedule.',
    ]);
  });

  it('does not treat repeated unassigned placeholders as duplicate players', () => {
    const formation = parseFormation('1-1-3');
    const slots = formationSlots(formation);
    const roster = [
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
      createPlayer({ name: 'D', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'M', group: 'rotational', general_positions: ['M'], primary_positions: ['CM'] }),
      createPlayer({ name: 'F', group: 'rotational', general_positions: ['F'], primary_positions: ['LF'] }),
    ];
    const block: ScheduleBlock = {
      GK: 'GK', D: ['D'], M: ['M'], F: ['F'], bench: [],
      positions: { GK: 'GK', CB: 'D', CM: 'M', LF: 'F', CF: 'UNASSIGNED', RF: 'UNASSIGNED' },
    };

    expect(validateTimeline(roster, [block], formation, slots, 1)).not.toContain('Block 1: duplicate players are assigned on the field.');
  });
});

describe('ten-game season availability simulation', () => {
  it('balances identical rotational midfield profiles within one block', () => {
    const identicalNames = new Set(['Artur', 'Mahaswin', 'Prerith', 'Thanish']);
    const players = seasonSimulationRoster().map((player) => identicalNames.has(player.name)
      ? createPlayer({ ...player, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] })
      : createPlayer(player));
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      allow_emergency_assignments: true,
    }, players);
    const repeat = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      allow_emergency_assignments: true,
    }, seasonSimulationRoster().map((player) => identicalNames.has(player.name)
      ? createPlayer({ ...player, general_positions: ['M'], primary_positions: ['ANY'], backup_positions: [], excluded_positions: [] })
      : createPlayer(player)));
    const names = ['Artur', 'Mahaswin', 'Prerith', 'Thanish'];
    const counts = names.map((name) => result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length);

    expect(Math.max(...counts) - Math.min(...counts), JSON.stringify(Object.fromEntries(names.map((name, index) => [name, counts[index]])))).toBeLessThanOrEqual(1);
    expect(repeat.timeline).toEqual(result.timeline);
  });

  it('keeps the Test 4.0 16-player game within hard maximums', () => {
    const availableNames = ['Alvin', 'Artur', 'Blake', 'Brad', 'Cameron', 'Eitan', 'Everett', 'Frank', 'Jonathan', 'Mahaswin', 'Max', 'Prerith', 'Ryan', 'Sawyer', 'Sid', 'Yash'];
    const players = seasonSimulationRoster().filter((player) => availableNames.includes(player.name)).map(createPlayer);
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      season_total_games: 10,
      season_game_number: 1,
      allow_emergency_assignments: true,
      disable_maximum_limits: false,
    }, players);
    const fieldBlocks = (name: string): number => result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length;

    expect(fieldBlocks('Jonathan')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Sawyer')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Eitan')).toBeLessThanOrEqual(7);
    expect(result.timeline.filter((block) => block.GK === 'Eitan')).toHaveLength(5);
    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
  });

  it('does not count assigned goalkeeper blocks toward a rotational hard maximum', () => {
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      season_total_games: 1,
      season_game_number: 1,
      allow_emergency_assignments: true,
      disable_maximum_limits: false,
    }, seasonSimulationRoster().map(createPlayer));
    const eitanFieldBlocks = result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes('Eitan')).length;

    expect(result.timeline).toHaveLength(10);
    expect(result.timeline.filter((block) => block.GK === 'Eitan')).toHaveLength(5);
    expect(eitanFieldBlocks).toBeLessThanOrEqual(7);
    expect(result.errors.filter((error) => error.includes('Eitan exceeds hard maximum'))).toEqual([]);
  });

  it('fills minimums before higher-priority targets when field capacity is short', () => {
    const coreNames = new Set(['Alvin', 'Artur', 'Blake', 'Dane', 'Everett', 'Hanshith', 'Jonathan', 'Max', 'Sid']);
    const players = seasonSimulationRoster().map((player) => createPlayer({
      ...player,
      group: coreNames.has(player.name) ? 'core' : 'rotational',
      ...(player.name === 'Cameron' || player.name === 'Eitan' ? {} : { general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] }),
    }));
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      season_total_games: 1,
      season_game_number: 1,
      allow_emergency_assignments: true,
      disable_maximum_limits: false,
    }, players);
    const fieldBlocks = (name: string): number => result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length;
    const corePlayers = players.filter((player) => player.group === 'core').map((player) => player.name);
    const rotationalShortfalls = players
      .filter((player) => player.group === 'rotational')
      .filter((player) => fieldBlocks(player.name) < 5);

    expect(result.timeline).toHaveLength(10);
    expect(Math.max(...corePlayers.map(fieldBlocks))).toBeLessThanOrEqual(7);
    expect(rotationalShortfalls.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => /^Below minimum \(\d+\): .+\(\d+\)/.test(warning))).toBe(true);
    expect(result.warnings.some((warning) => warning.startsWith('Roster minimums exceed capacity (107 needed, 100 available). Adjusted minimums:') && warning.includes('7 core at 6 blocks (was 7)'))).toBe(true);
    expect(result.warnings.some((warning) => warning.startsWith('Minimums adjusted for roster size:'))).toBe(true);
  });

  it('protects the Test 6.0 defensive minimum for Yash', () => {
    const rosterInputs = seasonSimulationRoster().map((player) => player.name === 'Blake'
      ? { ...player, backup_positions: ['F'] }
      : player.name === 'Everett'
        ? { ...player, backup_positions: ['M'] }
        : player);
    const availableNames = ['Alvin', 'Artur', 'Blake', 'Brad', 'Cameron', 'Eitan', 'Everett', 'Frank', 'Jonathan', 'Mahaswin', 'Max', 'Prerith', 'Ryan', 'Sawyer', 'Sid', 'Yash'];
    const players = rosterInputs.filter((player) => availableNames.includes(player.name)).map(createPlayer);
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      season_total_games: 10,
      season_game_number: 1,
      allow_emergency_assignments: true,
      disable_maximum_limits: false,
    }, players);
    const fieldBlocks = (name: string): number => result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length;

    expect(fieldBlocks('Yash')).toBeGreaterThanOrEqual(5);
  });

  it('balances the Test 5.0 16-player game without exhausting Sawyer', () => {
    const rosterInputs = coachAssignedSeasonBackups(seasonSimulationRoster());
    const availableNames = ['Alvin', 'Artur', 'Blake', 'Brad', 'Cameron', 'Eitan', 'Everett', 'Frank', 'Jonathan', 'Mahaswin', 'Max', 'Prerith', 'Ryan', 'Sawyer', 'Sid', 'Yash'];
    const players = rosterInputs.filter((player) => availableNames.includes(player.name)).map(createPlayer);
    const result = generateSchedule({
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      season_total_games: 10,
      season_game_number: 1,
      disable_maximum_limits: false,
    }, players);
    const fieldBlocks = (name: string): number => result.timeline.filter((block) => [...block.D, ...block.M, ...block.F].includes(name)).length;

    expect(Object.values(result.timeline[0].positions)).toContain('Alvin');
    expect(fieldBlocks('Sawyer')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Artur')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Jonathan')).toBeLessThanOrEqual(8);
    expect(fieldBlocks('Yash')).toBeGreaterThanOrEqual(5);
    expect(result.errors.filter((error) => error.includes('exceeds hard maximum'))).toEqual([]);
  });

  it('generates ten sequential games with 11 to 19 available players across deterministic seeds', { timeout: 180000 }, () => {
    const rosterInputs = coachAssignedSeasonBackups(seasonSimulationRoster());
    const seedBases = [20260924, 20261001, 20261015];
    type MinimumSummary = { player: string; expectedMinimum: number; actualFieldBlocks: number; deficit: number; capacityExempt: boolean };
    type GameSummary = { game: number; available: number; maximumOverride: boolean; structuralErrors: string[]; quotaErrors: string[]; minimumWarnings: string[]; warnings: string[]; goalkeeperStarts: Record<string, number> };
    type ScenarioSummary = { seed: number; games: GameSummary[]; fairness: ReturnType<typeof aggregateSeasonFairness>; minimums: MinimumSummary[]; coreLastBlocks: Record<string, number>; acceptance: { fairness: boolean; minimums: boolean; structural: boolean } };
    const scenarioSummaries: ScenarioSummary[] = [];

    for (const seedBase of seedBases) {
      const seasonPlayerBlocks: Record<string, number> = {};
      const seasonPositionStarts: Record<string, Record<string, number>> = {};
      const seasonReports: AfterGameReport[] = [];
      const gameSummaries: GameSummary[] = [];
      const coreLastBlocks: Record<string, number> = {};
      const seasonMinimums = new Map<string, { expectedMinimum: number; actualFieldBlocks: number; capacityExempt: boolean }>();

      for (let gameNumber = 1; gameNumber <= 10; gameNumber += 1) {
      const availablePlayerNames = seasonAvailableNames(rosterInputs, 11 + ((gameNumber - 1) % 9), seedBase + gameNumber);
      const players = rosterInputs
        .filter((player) => availablePlayerNames.includes(player.name))
        .map(createPlayer);
      const availableGoalkeepers = players.filter((player) => player.primary_positions.includes('GK'));
      const firstHalfGoalkeeper = availableGoalkeepers.find((player) => player.name === 'Cameron')?.name ?? availableGoalkeepers[0]?.name;
      const secondHalfGoalkeeper = availableGoalkeepers.find((player) => player.name === 'Eitan')?.name ?? firstHalfGoalkeeper;
      const availableCount = availablePlayerNames.length;
      const fieldCapacity = players
        .filter((player) => !player.general_positions.includes('GK'))
        .reduce((total, player) => {
          const maximum = player.group === 'rotational'
            ? ROTATIONAL_MAX
            : ['developing', 'developmental'].includes(player.group)
              ? DEVELOPMENTAL_MAX
              : HARD_MAXIMUM;
          return total + Math.max(1, Math.floor(10 * maximum));
        }, 0);
      const maximumOverride = fieldCapacity < 10 * 11 || availableCount <= 11 + 4;
      const result = generateSchedule({
        total_blocks: 10,
        formation: '4-3-3',
        first_half_gk: firstHalfGoalkeeper,
        second_half_gk: secondHalfGoalkeeper,
        season_total_games: 10,
        season_game_number: gameNumber,
        season_seed: seedBase,
        season_player_blocks: seasonPlayerBlocks,
        season_position_starts: seasonPositionStarts,
        allow_emergency_assignments: false,
        disable_maximum_limits: maximumOverride,
      }, players);
      expect(availablePlayerNames.length).toBe(11 + ((gameNumber - 1) % 9));
      expect(result.timeline).toHaveLength(10);
      if (availablePlayerNames.includes('Alvin')) {
        expect(Object.values(result.timeline[0].positions)).toContain('Alvin');
      }
      result.timeline.forEach((block) => {
        const assignedNames = Object.values(block.positions).filter((name) => !['UNASSIGNED', 'NO GK AVAILABLE'].includes(name));
        expect(new Set(assignedNames).size).toBe(assignedNames.length);
        expect(availablePlayerNames).toEqual(expect.arrayContaining(assignedNames));
        if (assignedNames.length === 11) assertBlockInvariants(block, 10, true);
      });

      const structuralErrors = summarizeStructuralErrors(gameNumber, result.errors.filter((error) => !error.includes('exceeds') && !error.includes('under target') && !error.includes('under minimum')));

      if (result.timeline.some((block) => Object.values(block.positions).some((name) => ['UNASSIGNED', 'NO GK AVAILABLE'].includes(name)))) {
        expect(structuralErrors.length).toBeGreaterThan(0);
      }
      const quotaErrors = result.errors.filter((error) => error.includes('exceeds') || error.includes('under target') || error.includes('under minimum'));
      const minimumWarnings = result.warnings.filter((warning) => warning.includes('under minimum') || warning.includes('under target'));
      const capacityExemptGroups = new Set(result.metadata.quota_feasibility?.affectedGroups ?? []);
      const goalkeeperStarts: Record<string, number> = {};
      [result.timeline[0]?.GK, result.timeline[Math.ceil(result.timeline.length / 2)]?.GK].forEach((goalkeeper) => {
        if (goalkeeper && goalkeeper !== 'NO GK AVAILABLE') goalkeeperStarts[goalkeeper] = (goalkeeperStarts[goalkeeper] ?? 0) + 1;
      });
      const actualBlocks = new Map<string, number>();
      const actualPlayingBlocks = new Map<string, number>();
      const actualPositions = new Map<string, Record<string, number>>();
      result.timeline.forEach((block) => {
        if (block.GK && block.GK !== 'NO GK AVAILABLE') actualPlayingBlocks.set(block.GK, (actualPlayingBlocks.get(block.GK) ?? 0) + 1);
        const blockPlayers = new Set([...block.D, ...block.M, ...block.F].filter((name) => !['UNASSIGNED', 'NO GK AVAILABLE'].includes(name)));
        blockPlayers.forEach((player) => {
          actualBlocks.set(player, (actualBlocks.get(player) ?? 0) + 1);
          actualPlayingBlocks.set(player, (actualPlayingBlocks.get(player) ?? 0) + 1);
        });
        Object.entries(block.positions).forEach(([position, player]) => {
          if (['UNASSIGNED', 'NO GK AVAILABLE'].includes(player)) return;
          const positions = actualPositions.get(player) ?? {};
          positions[position] = (positions[position] ?? 0) + 1;
          actualPositions.set(player, positions);
        });
      });
      players.forEach((player) => {
        const current = seasonMinimums.get(player.name) ?? { expectedMinimum: 0, actualFieldBlocks: 0, capacityExempt: false };
        const goalkeeperBlocks = result.timeline.filter((block) => block.GK === player.name).length;
        current.expectedMinimum += goalkeeperBlocks > 0 ? player.gk_field_minimum_blocks : player.minimum_blocks;
        current.actualFieldBlocks += actualBlocks.get(player.name) ?? 0;
        current.capacityExempt ||= result.metadata.quota_feasibility?.minimumsFeasible === false
          || (player.general_positions.includes('ANY')
            ? capacityExemptGroups.size > 0
            : player.general_positions.some((position) => capacityExemptGroups.has(position)));
        seasonMinimums.set(player.name, current);
      });
      const lastBlockPlayers = new Set([
        result.timeline[result.timeline.length - 1]?.GK,
        ...result.timeline[result.timeline.length - 1].D,
        ...result.timeline[result.timeline.length - 1].M,
        ...result.timeline[result.timeline.length - 1].F,
      ]);
      players.filter((player) => ['core', 'core_a', 'core_b'].includes(player.group) && lastBlockPlayers.has(player.name))
        .forEach((player) => { coreLastBlocks[player.name] = (coreLastBlocks[player.name] ?? 0) + 1; });
      gameSummaries.push({ game: gameNumber, available: availablePlayerNames.length, maximumOverride, structuralErrors, quotaErrors, minimumWarnings, warnings: result.warnings, goalkeeperStarts });
      const startingPositions = Object.fromEntries(Object.entries(result.timeline[0]?.positions ?? {}).filter(([position]) => position !== 'GK'));
      seasonReports.push({
        game_number: gameNumber,
        created_at: new Date(2026, 8, gameNumber).toISOString(),
        total_blocks: result.timeline.length,
        attendance: availablePlayerNames.length,
        starting_positions: { GK: result.timeline[0]?.GK ?? 'NO GK AVAILABLE', ...startingPositions },
        structural_errors: structuralErrors,
        players: players.map((player) => ({
          player: player.name,
          blocksPlayed: actualPlayingBlocks.get(player.name) ?? 0,
          minutesPlayed: (actualPlayingBlocks.get(player.name) ?? 0) * 7,
          positions: actualPositions.get(player.name) ?? {},
          unavailableBlocks: 0,
        })),
      });

      Object.entries(result.block_counts).forEach(([player, blocks]) => { seasonPlayerBlocks[player] = (seasonPlayerBlocks[player] ?? 0) + blocks; });
      Object.entries(result.starting_position_counts ?? {}).forEach(([player, positions]) => {
        seasonPositionStarts[player] = { ...(seasonPositionStarts[player] ?? {}) };
        Object.entries(positions).forEach(([position, count]) => {
          seasonPositionStarts[player][position] = (seasonPositionStarts[player][position] ?? 0) + count;
        });
      });
      }

      const fairness = aggregateSeasonFairness(seasonReports);
      const minimums = [...seasonMinimums.entries()].map(([player, summary]) => ({ player, ...summary, deficit: Math.max(0, summary.expectedMinimum - summary.actualFieldBlocks) })).sort((left, right) => left.player.localeCompare(right.player));
      scenarioSummaries.push({
        seed: seedBase,
        games: gameSummaries,
        fairness,
        minimums,
        coreLastBlocks,
        acceptance: {
          fairness: fairness.zeroStartPlayers.length === 0 && fairness.sameRoleDisparities.length === 0,
          minimums: minimums.every((summary) => summary.capacityExempt || summary.deficit === 0),
          structural: gameSummaries.every((summary) => summary.structuralErrors.length === 0),
        },
      });
    }

    for (const scenario of scenarioSummaries) {
      console.log(`\n10-game season summary (seed ${scenario.seed})`);
      scenario.games.forEach((summary) => {
        console.log(`Game ${summary.game}: ${summary.available} available; maximum override ${summary.maximumOverride ? 'on' : 'off'}; GK starts ${Object.entries(summary.goalkeeperStarts).map(([player, starts]) => `${player} ${starts}`).join(', ')}`);
        summary.structuralErrors.forEach((error) => console.log(`  ${error}`));
        summary.minimumWarnings.forEach((warning) => console.log(`  Game ${summary.game}: ${warning}`));
      });
      console.log('Player summary:');
      scenario.fairness.players.forEach((player) => console.log(`  ${player.player}: ${player.minutes} minutes; ${player.starts} starts; adjusted ${player.attendanceAdjustedMinutes.toFixed(1)} minutes / ${player.attendanceAdjustedStarts.toFixed(1)} starts; position starts ${JSON.stringify(player.positionStarts)}`));
      console.log('Core endpoint summary:');
      scenario.fairness.players.filter((player) => Object.prototype.hasOwnProperty.call(scenario.coreLastBlocks, player.player))
        .forEach((player) => console.log(`  ${player.player}: ${player.appearances} games played; ${player.starts} starts; last block in ${scenario.coreLastBlocks[player.player]} games`));
      console.log('Season minimum summary:');
      scenario.minimums.forEach((summary) => console.log(`  ${summary.player}: expected minimum ${summary.expectedMinimum} field blocks; actual ${summary.actualFieldBlocks}; deficit ${summary.deficit}${summary.capacityExempt ? ' (capacity exempt)' : ''}`));
      console.log(`Acceptance: fairness ${scenario.acceptance.fairness ? 'PASS' : 'FAIL'}; quota/minimums ${scenario.acceptance.minimums ? 'PASS' : 'FAIL'}; structural coverage ${scenario.acceptance.structural ? 'PASS' : 'FAIL'}`);
    }
    scenarioSummaries.forEach((scenario) => {
      expect(scenario.games.map((summary) => summary.available)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 11]);
      expect(scenario.games.filter((summary) => summary.maximumOverride).map((summary) => summary.game)).toEqual([1, 2, 3, 4, 5, 10]);
      expect(scenario.games.filter((summary) => summary.maximumOverride).every((summary) => summary.quotaErrors.length === 0)).toBe(true);
      const unexpectedStructuralErrors = scenario.games.flatMap((summary) => summary.structuralErrors)
        .filter((error) => !error.includes('core player') || !error.includes('endpoint'));
      expect(unexpectedStructuralErrors).toEqual([]);
      expect(scenario.fairness.players.length).toBeGreaterThan(0);
    });
    scenarioSummaries.forEach((scenario) => {
      expect(scenario.acceptance.minimums, `seed ${scenario.seed} quota/minimum acceptance`).toBe(true);
    });
    const investigatedScenario = scenarioSummaries.find((scenario) => scenario.seed === 20261001);
    expect(investigatedScenario?.games.filter((summary) => [5, 6].includes(summary.game)).flatMap((summary) => summary.structuralErrors)).toEqual([]);
  }, 60000);

  it('keeps bounded planning deterministic for flexible and constrained rosters', () => {
    const makeRoster = (count: number, constrained: boolean): PlayerInput[] => [
      { name: 'Stress Keeper', group: 'rotational', general_positions: ['M'], primary_positions: ['GK', 'ANY'] },
      ...Array.from({ length: count - 1 }, (_, index) => {
        const group = ['D', 'M', 'F'][index % 3];
        return {
          name: `Stress ${index + 1}`,
          group: 'rotational' as const,
          general_positions: [group],
          primary_positions: constrained ? [group] : ['ANY'],
        };
      }),
    ];
    const game: GameInput = { total_blocks: 8, formation: '3-2-2', first_half_gk: 'Stress Keeper', second_half_gk: 'Stress Keeper' };

    for (const [count, constrained] of [[15, false], [15, true], [21, false]] as const) {
      const roster = makeRoster(count, constrained).map(createPlayer);
      const first = generateSchedule(game, roster);
      const second = generateSchedule(game, roster.map((player) => createPlayer(player)));
      expect(first.timeline.map((block) => block.positions)).toEqual(second.timeline.map((block) => block.positions));
      expect(first.timeline).toHaveLength(game.total_blocks);
    }
  }, 20000);

  it('generates a complete ten-block all-flexible roster', () => {
    const players = [
      ...Array.from({ length: 15 }, (_, index) => ({ name: `Flexible ${index + 1}`, group: 'rotational' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.timeline).toHaveLength(10);
    expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('UNASSIGNED');
  }, 20000);

  it('handles ANY-general candidates without late-block holes', () => {
    const players = [
      ...Array.from({ length: 15 }, (_, index) => ({ name: `Any ${index + 1}`, group: 'rotational' as const, general_positions: ['ANY'], primary_positions: ['ANY'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.timeline).toHaveLength(10);
    expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('UNASSIGNED');
  }, 20000);

  it('rejects a roster above the format core-player cap', () => {
    const players = [
      ...Array.from({ length: 11 }, (_, index) => ({ name: `Core ${index + 1}`, group: 'core' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      { name: 'Core GK', group: 'core' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);

    expect(() => generateSchedule({
      total_blocks: 10,
      game_format: '11v11',
      formation: '4-4-2',
      first_half_gk: 'Core GK',
      second_half_gk: 'Core GK',
    }, players)).toThrow('Core is limited to 10 field players');
  }, 20000);

  it('completes a mixed flexible roster without late-block holes', () => {
    const players = [
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Core ${index + 1}`, group: 'core' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Rotational ${index + 1}`, group: 'rotational' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Developing ${index + 1}`, group: 'developing' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] })),
      { name: 'GK', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK', second_half_gk: 'GK' }, players);

    expect(result.timeline).toHaveLength(10);
    expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('UNASSIGNED');
  }, 20000);

  it('completes a mixed flexible roster with D/M/F primary positions', () => {
    const players = [
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Core primary ${index + 1}`, group: 'core' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['D', 'M', 'F'] })),
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Rotational primary ${index + 1}`, group: 'rotational' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['D', 'M', 'F'] })),
      ...Array.from({ length: 5 }, (_, index) => ({ name: `Developing primary ${index + 1}`, group: 'developing' as const, general_positions: ['D', 'M', 'F'], primary_positions: ['D', 'M', 'F'] })),
      { name: 'GK primary', group: 'rotational_gk' as const, general_positions: ['GK'], primary_positions: ['GK'] },
    ].map(createPlayer);
    const result = generateSchedule({ total_blocks: 10, formation: '4-4-2', first_half_gk: 'GK primary', second_half_gk: 'GK primary' }, players);

    expect(result.timeline).toHaveLength(10);
    expect(result.timeline.flatMap((block) => Object.values(block.positions))).not.toContain('UNASSIGNED');
    expect(result.errors).toEqual([]);
  }, 20000);

  it('covers strict mode and production emergency field fallback separately', () => {
    const players = [
      createPlayer({ name: 'D1', group: 'rotational', general_positions: ['D'], primary_positions: ['CB'] }),
      createPlayer({ name: 'GK', group: 'rotational_gk', general_positions: ['GK'], primary_positions: ['GK'] }),
    ];
    const baseGame = { total_blocks: 2, formation: '0-2-0' as const, first_half_gk: 'GK', second_half_gk: 'GK', season_total_games: 1, season_game_number: 1 };
    const strict = generateSchedule({ ...baseGame, allow_emergency_assignments: false }, players.map((player) => createPlayer(player)));
    const production = generateSchedule({ ...baseGame, allow_emergency_assignments: true }, players.map((player) => createPlayer(player)));

    expect(strict.timeline.every((block) => block.M.length === 0)).toBe(true);
    expect(production.movement_metrics?.emergency_assignments ?? 0).toBeGreaterThan(0);
    expect(production.timeline.flatMap((block) => [block.D, block.M, block.F].flat())).not.toContain('GK');
  });

  it('keeps initial generation under five seconds with sixteen available players', () => {
    const unavailableNames = new Set(['Blake', 'Frank', 'Sid']);
    const players = coachAssignedSeasonBackups(seasonSimulationRoster())
      .filter((player) => !unavailableNames.has(player.name))
      .map(createPlayer);
    const startedAt = performance.now();
    const result = generateSchedule({
      game_format: '11v11',
      has_goalkeeper: true,
      total_blocks: 10,
      formation: '4-3-3',
      first_half_gk: 'Cameron',
      second_half_gk: 'Eitan',
      allow_emergency_assignments: true,
    }, players);

    expect(performance.now() - startedAt).toBeLessThan(5000);
    expect(result.timeline).toHaveLength(10);
  });
});