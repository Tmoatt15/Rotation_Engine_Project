import { describe, expect, it } from 'vitest';

import { aggregateSeasonFairness } from './season-fairness';
import type { AfterGameReport } from '@/engine/models';

function report(gameNumber: number, attendance: number, starters: Record<string, string>, players: AfterGameReport['players'], structuralErrors: string[] = [], endingPositions: Record<string, string> = starters, corePlayerNames: string[] = []): AfterGameReport {
  return { game_number: gameNumber, created_at: `2026-09-${String(gameNumber).padStart(2, '0')}`, total_blocks: 10, attendance, starting_positions: starters, ending_positions: endingPositions, core_player_names: corePlayerNames, structural_errors: structuralErrors, players };
}

function player(name: string, blocksPlayed: number, minutesPlayed = blocksPlayed * 7, positions: Record<string, number> = {}): AfterGameReport['players'][number] {
  return { player: name, blocksPlayed, minutesPlayed, positions, unavailableBlocks: 0 };
}

describe('season fairness acceptance', () => {
  it('flags zero-start players after two appearances and structural games', () => {
    const result = aggregateSeasonFairness([
      report(1, 12, { ST: 'Starter' }, [player('Starter', 10), player('Bench', 5)]),
      report(2, 18, { ST: 'Starter' }, [player('Starter', 10), player('Bench', 5)], ['Block 2: required slot is unassigned.']),
    ]);

    expect(result.zeroStartPlayers).toEqual(['Bench']);
    expect(result.structuralErrors).toEqual([{ game: 2, errors: ['Game 2: required slot is unassigned.'] }]);
    expect(result.accepted).toBe(false);
    expect(result.players.find((item) => item.player === 'Bench')?.attendanceAdjustedMinutes).toBeCloseTo(35 * (12 / 18) + 35);
  });

  it('flags a same-role position-start gap above the threshold', () => {
    const result = aggregateSeasonFairness([
      report(1, 12, { ST: 'A' }, [player('A', 10, 70, { ST: 10 }), player('B', 10, 70, { ST: 10 })]),
      report(2, 12, { ST: 'A' }, [player('A', 10, 70, { ST: 10 }), player('B', 10, 70, { ST: 10 })]),
      report(3, 12, { ST: 'A' }, [player('A', 10, 70, { ST: 10 }), player('B', 10, 70, { ST: 10 })]),
    ]);

    expect(result.sameRoleDisparities).toEqual([{ position: 'ALL', highPlayer: 'A', lowPlayer: 'B', gap: 3 }]);
  });

  it('reports first and last endpoint misses separately', () => {
    const result = aggregateSeasonFairness([
      report(1, 12, { ST: 'A' }, [player('A', 10), player('B', 10)], [], { ST: 'B' }, ['A', 'B']),
    ]);

    expect(result.first_endpoint_misses).toEqual([{ game: 1, player: 'B' }]);
    expect(result.last_endpoint_misses).toEqual([{ game: 1, player: 'A' }]);
    expect(result.accepted).toBe(false);
  });
});