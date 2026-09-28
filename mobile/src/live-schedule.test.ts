import { describe, expect, it } from 'vitest';

import { buildAfterGameReport, canonicalFieldAssignments } from './report-utils';
import type { LiveSchedule } from './live-schedule';

function makeSchedule(): LiveSchedule {
  return {
    game_number: 1,
    block_lengths_minutes: [7],
    blocks: [{
      GK: 'Keeper',
      positions: {
        GK: 'Keeper',
        LB: 'Left back',
        LCB: 'Left center back',
        RCB: 'Right center back',
        RB: 'Right back',
        LM: 'Left mid',
        LCM: 'Left center mid',
        RCM: 'Right center mid',
        RM: 'Right mid',
        LF: 'Left forward',
        RF: 'Right forward',
      },
      bench: ['Bench player'],
    }],
  };
}

describe('live schedule reporting', () => {
  it('uses the dedicated goalkeeper when a legacy positions map is stale', () => {
    const schedule = makeSchedule();
    schedule.blocks[0].GK = 'Replacement keeper';

    expect(canonicalFieldAssignments(schedule.blocks[0]).find(([position]) => position === 'GK')).toEqual(['GK', 'Replacement keeper']);
  });

  it('does not create report players for sentinel assignments', () => {
    const schedule = makeSchedule();
    schedule.blocks[0].positions.RF = 'UNASSIGNED';
    schedule.blocks[0].bench.push('UNASSIGNED');

    const report = buildAfterGameReport(schedule, schedule.blocks, []);

    expect(report.players.map((player) => player.player)).not.toContain('UNASSIGNED');
    expect(report.players).toHaveLength(11);
  });

  it('records the first block starters for season history', () => {
    const report = buildAfterGameReport(makeSchedule(), makeSchedule().blocks, []);

    expect(report.starting_positions).toEqual({
      GK: 'Keeper',
      LB: 'Left back',
      LCB: 'Left center back',
      RCB: 'Right center back',
      RB: 'Right back',
      LM: 'Left mid',
      LCM: 'Left center mid',
      RCM: 'Right center mid',
      RM: 'Right mid',
      LF: 'Left forward',
      RF: 'Right forward',
    });
  });

  it('records attendance and structural errors for season acceptance', () => {
    const schedule = { ...makeSchedule(), available_player_names: ['Keeper', 'Left back'], structural_errors: ['Block 1: a required slot is unassigned.'] };
    const report = buildAfterGameReport(schedule, schedule.blocks, []);

    expect(report.attendance).toBe(2);
    expect(report.structural_errors).toEqual(['Block 1: a required slot is unassigned.']);
  });

  it('preserves player totals when legal field positions are manually swapped', () => {
    const generated = makeSchedule();
    const manual = makeSchedule();
    manual.blocks[0].positions.LF = generated.blocks[0].positions.RF;
    manual.blocks[0].positions.RF = generated.blocks[0].positions.LF;

    const generatedReport = buildAfterGameReport(generated, generated.blocks, []);
    const manualReport = buildAfterGameReport(manual, manual.blocks, []);

    expect(manualReport.players.map(({ player, blocksPlayed, minutesPlayed }) => ({ player, blocksPlayed, minutesPlayed })))
      .toEqual(generatedReport.players.map(({ player, blocksPlayed, minutesPlayed }) => ({ player, blocksPlayed, minutesPlayed })));
  });

  it('includes illegal live overrides as report warnings without changing player totals', () => {
    const schedule = makeSchedule();
    const overrides = [{
      blockIndex: 0,
      player: 'Left forward',
      fromPosition: 'LF',
      toPosition: 'LB',
      scope: 'current_block' as const,
      reason: 'coach_swap' as const,
      legalBefore: false,
    }];

    const report = buildAfterGameReport(schedule, schedule.blocks, [], overrides);

    expect(report.position_overrides).toEqual(overrides);
    expect(report.position_override_warnings).toEqual([
      'Manual position override: Left forward moved from LF to LB in Block 1.',
    ]);
    expect(report.players.find((player) => player.player === 'Left forward')?.minutesPlayed).toBe(7);
  });
});