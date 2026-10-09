import { describe, expect, it } from 'vitest';
import { blockDurationSummary, blockStartMinutes, calculateBlockDurations, maxBlocksForGameLength, nearestValidBlockCount, SeasonSetup } from '../season';

describe('block time selection', () => {
  it.each([
    [50, 14, [4, 4, 4, 4, 3, 3, 3, 4, 4, 4, 4, 3, 3, 3]],
    [70, 10, [7, 7, 7, 7, 7, 7, 7, 7, 7, 7]],
    [45, 6, [8, 8, 7, 8, 7, 7]],
  ])('distributes whole minutes for %d minutes and %d blocks', (minutes, blocks, expected) => {
    expect(calculateBlockDurations(minutes, blocks)).toEqual(expected);
  });

  it('caps blocks at the three-minute average rule', () => {
    expect(maxBlocksForGameLength(50)).toBe(16);
    expect(maxBlocksForGameLength(30)).toBe(10);
    expect(nearestValidBlockCount(30, 16)).toBe(10);
  });

  it('calculates cumulative clock starts', () => {
    expect(blockStartMinutes([4, 3, 3, 4])).toEqual([0, 4, 7, 10]);
  });

  it('summarizes bonus blocks in ascending display order', () => {
    expect(blockDurationSummary([4, 3, 3, 4])).toBe('Blocks 1, 4 = 4 min (post-break first)\nAll others = 3 min each');
  });

  it('rejects game lengths outside the supported range', () => {
    expect(() => new SeasonSetup({ game_length_minutes: 19, game_format: '7v7', total_blocks: 6, formation: '2-3-1' })).toThrow();
    expect(() => new SeasonSetup({ game_length_minutes: 121, game_format: '7v7', total_blocks: 6, formation: '2-3-1' })).toThrow();
  });
});
