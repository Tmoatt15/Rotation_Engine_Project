import { describe, expect, it } from 'vitest';

import { createPlayer } from '../rotation';
import { computeSurplus, filterStaleQuotaWarnings } from '../surplus';

describe('rotation notes', () => {
  it('only reports under-target warnings for available players', () => {
    const roster = [
      createPlayer({ name: 'Blake', group: 'core', general_positions: ['D'], primary_positions: ['D'] }),
      createPlayer({ name: 'Frank', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] }),
      createPlayer({ name: 'Everett', group: 'core', general_positions: ['D'], primary_positions: ['D'] }),
    ];
    roster[0].available = false;
    roster[0].minimum_blocks = 7;
    roster[1].available = false;
    roster[1].minimum_blocks = 5;
    roster[2].minimum_blocks = 1;
    roster.forEach((player) => { player.block_count = 0; });

    const result = computeSurplus({ total_blocks: 10, formation: '1-0' }, roster);

    expect(result.warnings).not.toContain(expect.stringContaining('Blake'));
    expect(result.warnings).not.toContain(expect.stringContaining('Frank'));
    expect(result.warnings).toContain('Everett (core) is under target by 7 blocks.');
  });

  it('does not report a late arrival as under target', () => {
    const sid = createPlayer({ name: 'Sid', group: 'core', general_positions: ['D'], primary_positions: ['D'] });
    sid.minimum_blocks = 6;
    sid.block_count = 3;

    const result = computeSurplus({
      total_blocks: 10,
      formation: '1-0',
      availability_changes: [{ player: 'Sid', action: 'available', block: 4, target_blocks: 6 }],
    }, [sid]);

    expect(result.warnings.some((warning) => warning.includes('Sid') && warning.includes('under target'))).toBe(false);
  });

  it('does not warn when a core player has eight blocks in a ten-block game', () => {
    const sawyer = createPlayer({ name: 'Sawyer', group: 'core', general_positions: ['F'], primary_positions: ['F'] });
    sawyer.minimum_blocks = 12;
    sawyer.block_count = 8;

    const result = computeSurplus({ total_blocks: 10, formation: '4-3-3' }, [sawyer]);

    expect(result.warnings).not.toContain(expect.stringContaining('Sawyer'));
  });

  it('keeps only the most relevant quota warning per player', () => {
    const mah = createPlayer({ name: 'Mahaswin', group: 'rotational', general_positions: ['M'], primary_positions: ['M'] });
    const blocks = Array.from({ length: 10 }, () => ({ GK: 'GK', D: [], M: [], F: [], bench: [], positions: {} }));
    const warnings = filterStaleQuotaWarnings([
      'Mahaswin (rotational) is under max by 3 blocks.',
      'Mahaswin (rotational) is under minimum by 1 blocks.',
    ], blocks, [mah]);

    expect(warnings).toEqual(['Mahaswin (rotational) is under minimum by 1 blocks.']);
  });
});
