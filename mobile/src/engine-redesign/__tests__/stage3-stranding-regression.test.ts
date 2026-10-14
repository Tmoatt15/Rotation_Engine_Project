import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, normalizeGame, placeStage3 } from '..';

describe('Stage 3 stranding regression', () => {
  it('places a constrained 9v9 roster without a false stranding failure', () => {
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Avery',
      secondHalfKeeper: 'Maddie',
    }, [
      { name: 'Avery', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'], keeper: true },
      { name: 'Maddie', group: 'rotational', general_positions: ['GK'], primary_positions: ['GK'], keeper: true },
      { name: 'Blair', group: 'core', general_positions: ['D'], primary_positions: ['D'] },
      { name: 'Casey', group: 'core', general_positions: ['D', 'M'], primary_positions: ['D'] },
      { name: 'Drew', group: 'core', general_positions: ['M'], primary_positions: ['M'] },
      { name: 'Elliot', group: 'core', general_positions: ['F'], primary_positions: ['F'] },
      { name: 'Finley', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] },
      { name: 'Gray', group: 'rotational', general_positions: ['D', 'M'], primary_positions: ['M'] },
      { name: 'Harper', group: 'rotational', general_positions: ['M'], primary_positions: ['M'] },
      { name: 'Jordan', group: 'rotational', general_positions: ['M', 'F'], primary_positions: ['M'] },
      { name: 'Kai', group: 'rotational', general_positions: ['F'], primary_positions: ['F'] },
      { name: 'Logan', group: 'developing', general_positions: ['D', 'M'], primary_positions: ['D'] },
      { name: 'Morgan', group: 'developing', general_positions: ['M', 'F'], primary_positions: ['F'] },
      { name: 'Nico', group: 'developing', general_positions: ['ANY'], primary_positions: ['ANY'] },
      { name: 'Parker', group: 'developing', general_positions: ['ANY'], primary_positions: ['ANY'] },
      { name: 'Quinn', group: 'developing', general_positions: ['ANY'], primary_positions: ['ANY'] },
    ]);
    const demand = buildDemandModel(game);
    const started = Date.now();
    const placement = placeStage3(game, demand, assignQuotas(game, demand));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(placement.complete, JSON.stringify(placement.audit)).toBe(true);
  });
});
