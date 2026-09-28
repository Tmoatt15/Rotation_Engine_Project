import { describe, expect, it } from 'vitest';

import { summarizeStructuralErrors } from './structural-diagnostics';

describe('structural diagnostics', () => {
  it('deduplicates repeated shortage messages by game, role, and block', () => {
    expect(summarizeStructuralErrors(1, [
      'Block 1: D players cannot form a complete legal exact-slot assignment.',
      'Block 1: D players cannot form a complete legal exact-slot assignment.',
      'Block 2: D players cannot form a complete legal exact-slot assignment.',
      'Block 7: D requires 4 players but only 3 were assigned.',
      'Block 8: D requires 4 players but only 3 were assigned.',
      'Block 10: M players cannot form a complete legal exact-slot assignment.',
    ])).toEqual([
      'Game 1: Defender exact-slot coverage unavailable in 2 blocks',
      'Game 1: Defender coverage unavailable in 2 blocks',
      'Game 1: Midfield exact-slot coverage unavailable in 1 block',
    ]);
  });

  it('deduplicates ungrouped diagnostics without losing them', () => {
    expect(summarizeStructuralErrors(10, ['Block 1: duplicate players are assigned on the field.', 'Block 1: duplicate players are assigned on the field.']))
      .toEqual(['Game 10: duplicate players are assigned on the field.']);
  });
});