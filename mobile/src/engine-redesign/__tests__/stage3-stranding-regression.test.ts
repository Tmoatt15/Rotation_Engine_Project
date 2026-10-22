import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, normalizeGame, placeStage3 } from '..';
import { REPAIR_NODE_CAP } from '../stage3';

function chelseaIncidentGame(katelynHasMidfieldBackup = false) {
  return normalizeGame({
    format: '11v11',
    formation: '3-4-3',
    totalBlocks: 10,
    availablePlayerNames: ['Avery', 'Briana', 'Emma', 'Isla', 'Izzy', 'Jasper', 'Katelyn', 'Maddie', 'Madelyn', 'Makenzie', 'Natalie', 'Rozenn', 'Sophia'],
    firstHalfKeeper: 'Maddie',
    secondHalfKeeper: 'Avery',
  }, [
    { name: 'Avery', group: 'core', general_positions: ['M'], primary_positions: ['LCM', 'RCM'], keeper_eligible: true },
    { name: 'Briana', group: 'developing', general_positions: ['M'], primary_positions: ['LM', 'RM'] },
    { name: 'Dolce', group: 'rotational', general_positions: ['D'], primary_positions: ['LB', 'RB'] },
    { name: 'Emma', group: 'core', general_positions: ['F'], primary_positions: ['LF'] },
    { name: 'Isla', group: 'core', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
    { name: 'Izzy', group: 'rotational', general_positions: ['M'], primary_positions: ['RM', 'LM'], backup_positions: ['F', 'D'] },
    { name: 'Jasper', group: 'rotational', general_positions: ['D'], primary_positions: ['RB', 'LB'] },
    { name: 'Kalia', group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'RM'] },
    { name: 'Katelyn', group: 'rotational', general_positions: ['F'], primary_positions: ['RF'], backup_positions: katelynHasMidfieldBackup ? ['M'] : [] },
    { name: 'Maddie', group: 'core', general_positions: ['F'], primary_positions: ['CF'], keeper_eligible: true },
    { name: 'Madelyn', group: 'core', general_positions: ['M'], primary_positions: ['LCM', 'RCM'], backup_positions: ['F'] },
    { name: 'Makenzie', group: 'developing', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['M'] },
    { name: 'Natalie', group: 'core', general_positions: ['D'], primary_positions: ['LB'], keeper_eligible: true },
    { name: 'Noor', group: 'rotational', general_positions: ['M'], primary_positions: ['LM', 'RM'] },
    { name: 'Rozenn', group: 'core', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['D'] },
    { name: 'Sophia', group: 'core', general_positions: ['D'], primary_positions: ['CB'] },
  ]);
}

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
      { name: 'Casey', group: 'core', general_positions: ['D'], primary_positions: ['D'], backup_positions: ['M'] },
      { name: 'Drew', group: 'core', general_positions: ['M'], primary_positions: ['M'] },
      { name: 'Elliot', group: 'core', general_positions: ['F'], primary_positions: ['F'] },
      { name: 'Finley', group: 'rotational', general_positions: ['D'], primary_positions: ['D'] },
      { name: 'Gray', group: 'rotational', general_positions: ['M'], primary_positions: ['M'], backup_positions: ['D'] },
      { name: 'Harper', group: 'rotational', general_positions: ['M'], primary_positions: ['M'] },
      { name: 'Jordan', group: 'rotational', general_positions: ['M'], primary_positions: ['M'], backup_positions: ['F'] },
      { name: 'Kai', group: 'rotational', general_positions: ['F'], primary_positions: ['F'] },
      { name: 'Logan', group: 'developing', general_positions: ['D'], primary_positions: ['D'], backup_positions: ['M'] },
      { name: 'Morgan', group: 'developing', general_positions: ['F'], primary_positions: ['F'], backup_positions: ['M'] },
      { name: 'Nico', group: 'developing', general_positions: ['D'], primary_positions: ['ANY'], backup_positions: ['M', 'F'] },
      { name: 'Parker', group: 'developing', general_positions: ['M'], primary_positions: ['ANY'], backup_positions: ['D', 'F'] },
      { name: 'Quinn', group: 'developing', general_positions: ['F'], primary_positions: ['ANY'], backup_positions: ['D', 'M'] },
    ]);
    const demand = buildDemandModel(game);
    const started = Date.now();
    const placement = placeStage3(game, demand, assignQuotas(game, demand));

    expect(Date.now() - started).toBeLessThan(5000);
    expect(placement.complete, JSON.stringify(placement.audit)).toBe(true);
  });

  it('bounds Chelsea incident repair and marks an expired search deadline', () => {
    const game = chelseaIncidentGame();
    const demand = buildDemandModel(game);
    const assignedQuotas = assignQuotas(game, demand, true, true);
    const quotas = {
      ...assignedQuotas,
      audit: { ...assignedQuotas.audit, errors: undefined },
    };
    const started = Date.now();
    const placement = placeStage3(game, demand, quotas);

    expect(placement.complete).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    const expiredPlacement = placeStage3(game, demand, quotas, [], false, Date.now() - 1);
    expect(expiredPlacement.audit.failureReason).toBe('search-budget-exhausted');
    expect(expiredPlacement.audit.repair?.nodesSearched).toBeLessThanOrEqual(REPAIR_NODE_CAP);
  });

  it('skips repair when greedy placement is complete or quota audit already failed', () => {
    const game = chelseaIncidentGame(true);
    const demand = buildDemandModel(game);
    const completePlacement = placeStage3(game, demand, assignQuotas(game, demand, true, true));
    const invalidQuotaPlacement = placeStage3(game, demand, assignQuotas(game, demand));

    expect(completePlacement.complete).toBe(true);
    expect(completePlacement.audit.repair).toBeUndefined();
    expect(invalidQuotaPlacement.audit.repair).toBeUndefined();
  });
});
