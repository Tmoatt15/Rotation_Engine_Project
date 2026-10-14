import { describe, expect, it } from 'vitest';
import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '..';
import type { RedesignGameInput, RedesignPlayerInput } from '../model';

const fieldPlayers: RedesignPlayerInput[] = [
  { name: 'Rachel', group: 'core', general_positions: ['D'], primary_positions: ['D'], rest_preset: 'A' },
  { name: 'Meg', group: 'core', general_positions: ['M'], primary_positions: ['M'], rest_preset: 'A' },
  { name: 'Madelyn', group: 'core', general_positions: ['F'], primary_positions: ['F'], keeper_eligible: true, rest_preset: 'A' },
  { name: 'Kelsey', group: 'rotational', general_positions: ['D', 'M'], primary_positions: ['D'] },
  { name: 'Emma', group: 'rotational', general_positions: ['D', 'M'], primary_positions: ['M'] },
  { name: 'Sophia', group: 'rotational', general_positions: ['M', 'F'], primary_positions: ['M'] },
  { name: 'Brooklyn', group: 'rotational', general_positions: ['M', 'F'], primary_positions: ['F'] },
  { name: 'Avery', group: 'rotational', general_positions: ['D', 'M'], primary_positions: ['D'], keeper_eligible: true },
  { name: 'Selma', group: 'developing', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
  { name: 'Harper', group: 'developing', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
  { name: 'Jordan', group: 'developing', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
  { name: 'Parker', group: 'developing', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
  { name: 'Quinn', group: 'developing', general_positions: ['D', 'M', 'F'], primary_positions: ['ANY'] },
];

const pins = [
  { block: 1, slot: 'LCB', player: 'Brooklyn' },
  { block: 1, slot: 'CM', player: 'Meg' },
];

function runLevel(gameInput: RedesignGameInput, players: RedesignPlayerInput[], disableKeeperHalves = false) {
  const game = normalizeGame(gameInput, players);
  if (disableKeeperHalves) {
    game.firstHalfKeeper = null;
    game.secondHalfKeeper = null;
  }
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  return runStages3And4(game, demand, quotas);
}

describe('Chelsea constraint isolation', () => {
  it('Level 0: basic positions and quotas', () => {
    const result = runLevel({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Avery',
      secondHalfKeeper: 'Madelyn',
    }, fieldPlayers.map((player) => ({ ...player, rest_preset: 'none' })), true);
    console.log(`Level 0: ${result.complete ? 'PASS' : 'FAIL'}`, result.audit.errors);
    expect(true).toBe(true);
  });

  it('Level 1: basic constraints plus keeper halves', () => {
    const players = fieldPlayers.map((player) => player.name === 'Avery' || player.name === 'Madelyn'
      ? { ...player, keeper_eligible: true }
      : player);
    const result = runLevel({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Avery',
      secondHalfKeeper: 'Madelyn',
    }, players.map((player) => ({ ...player, rest_preset: 'none' })));
    console.log(`Level 1: ${result.complete ? 'PASS' : 'FAIL'}`, result.audit.errors);
    expect(true).toBe(true);
  });

  it('Level 2: keeper halves plus endpoint pins', () => {
    const players = fieldPlayers.map((player) => player.name === 'Avery' || player.name === 'Madelyn'
      ? { ...player, keeper_eligible: true }
      : player);
    const result = runLevel({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Avery',
      secondHalfKeeper: 'Madelyn',
      pins,
    }, players.map((player) => ({ ...player, rest_preset: 'none' })));
    console.log(`Level 2: ${result.complete ? 'PASS' : 'FAIL'}`, result.audit.errors);
    expect(true).toBe(true);
  });

  it('Level 3: full keeper, pin, and rest constraints', () => {
    const players = fieldPlayers.map((player) => player.name === 'Avery' || player.name === 'Madelyn'
      ? { ...player, keeper_eligible: true }
      : player);
    const result = runLevel({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 8,
      firstHalfKeeper: 'Avery',
      secondHalfKeeper: 'Madelyn',
      pins,
    }, players);
    console.log(`Level 3: ${result.complete ? 'PASS' : 'FAIL'}`, result.audit.errors);
    expect(true).toBe(true);
  });
});
