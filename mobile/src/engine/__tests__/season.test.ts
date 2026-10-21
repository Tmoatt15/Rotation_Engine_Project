import { describe, expect, it } from 'vitest';
import { blockDurationSummary, blockStartMinutes, calculateBlockDurations, commitGameLengthInput, maxBlocksForGameLength, nearestValidBlockCount, SeasonSetup } from '../season';

describe('block time selection', () => {
  it.each([
    [50, 12, [5, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4]],
    [70, 10, [7, 7, 7, 7, 7, 7, 7, 7, 7, 7]],
    [45, 6, [8, 8, 7, 8, 7, 7]],
  ])('distributes whole minutes for %d minutes and %d blocks', (minutes, blocks, expected) => {
    expect(calculateBlockDurations(minutes, blocks)).toEqual(expected);
  });

  it('caps blocks at the three-minute average rule', () => {
    expect(maxBlocksForGameLength(50)).toBe(12);
    expect(maxBlocksForGameLength(30)).toBe(10);
    expect(nearestValidBlockCount(30, 16)).toBe(10);
    expect(nearestValidBlockCount(50, 16)).toBe(12);
    expect(nearestValidBlockCount(20, 4)).toBe(6);
  });

  it('commits game length input on blur, clamping out-of-range values and restoring empty input', () => {
    expect(commitGameLengthInput('80', 20)).toBe(80);
    expect(commitGameLengthInput('200', 20)).toBe(120);
    expect(commitGameLengthInput('10', 80)).toBe(20);
    expect(commitGameLengthInput('', 80)).toBe(80);
    expect(calculateBlockDurations(commitGameLengthInput('80', 20), 6)).toEqual([14, 13, 13, 14, 13, 13]);
    expect(blockDurationSummary(calculateBlockDurations(80, 6))).toBe('Blocks 1, 4 = 14 min (post-break first)\nAll others = 13 min each');
  });

  it('supports only even block counts from 6 through 12', () => {
    expect(() => new SeasonSetup({ game_length_minutes: 20, game_format: '7v7', total_blocks: 4, formation: '2-3-1' })).toThrow();
    expect(new SeasonSetup({ game_length_minutes: 50, game_format: '7v7', total_blocks: 12, formation: '2-3-1' }).total_blocks).toBe(12);
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
