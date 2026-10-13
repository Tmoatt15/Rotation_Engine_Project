import type { DemandModel, NormalizedGame, NormalizedPlayer } from './model';
import { BANDS } from './stage2';
import { positionTier } from './stage3';

export type FeasibilityIssueKind = 'total-minimums' | 'group-minimums' | 'keeper' | 'position-shortage';

export interface FeasibilityIssue {
  kind: FeasibilityIssueKind;
  message: string;
  group?: 'D' | 'M' | 'F';
}

function isDedicatedKeeper(player: NormalizedPlayer): boolean {
  return player.keeper && player.generalPositions.length === 0;
}

function minimumBlocks(game: NormalizedGame, player: NormalizedPlayer): number {
  return Math.round(game.totalBlocks * BANDS[player.group].min);
}

function playersForGroup(game: NormalizedGame, demand: DemandModel, group: 'D' | 'M' | 'F'): NormalizedPlayer[] {
  const slots = demand.fieldSlots.filter((slot) => slot.group === group);
  return game.players.filter((player) => player.available && !isDedicatedKeeper(player)
    && slots.some((slot) => positionTier(player, slot.slot) > 0));
}

export function checkRosterFeasibility(game: NormalizedGame, demand: DemandModel): FeasibilityIssue | null {
  const fieldPlayers = game.players.filter((player) => player.available && !isDedicatedKeeper(player));
  const totalMinimum = fieldPlayers.reduce((total, player) => total + minimumBlocks(game, player), 0);
  const totalFieldSlots = demand.fieldSlots.length * game.totalBlocks;
  if (totalMinimum > totalFieldSlots) {
    return {
      kind: 'total-minimums',
      message: `Total minimum playing time (${totalMinimum} blocks) exceeds available field time (${totalFieldSlots} blocks).`,
    };
  }

  for (const group of ['D', 'M', 'F'] as const) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    if (!slots.length) continue;
    const eligible = playersForGroup(game, demand, group);
    const singleGroupPlayers = eligible.filter((player) =>
      (['D', 'M', 'F'] as const).filter((candidate) => playersForGroup(game, demand, candidate).some((other) => other.name === player.name)).length === 1);
    const groupMinimum = singleGroupPlayers.reduce((total, player) => total + minimumBlocks(game, player), 0);
    const groupFieldSlots = slots.length * game.totalBlocks;
    if (groupMinimum > groupFieldSlots) {
      const label = group === 'D' ? 'defender' : group === 'M' ? 'midfielder' : 'forward';
      return {
        kind: 'group-minimums',
        group,
        message: `${label[0].toUpperCase()}${label.slice(1)} minimum playing time (${groupMinimum} blocks) exceeds available ${label} field time (${groupFieldSlots} blocks).`,
      };
    }
  }

  if (demand.goalkeeperRequired && !game.players.some((player) => player.available && player.keeperEligible)) {
    return {
      kind: 'keeper',
      message: 'No available keeper-eligible player is configured.',
    };
  }

  for (const group of ['D', 'M', 'F'] as const) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    if (slots.length && playersForGroup(game, demand, group).length < slots.length) {
      const label = group === 'D' ? 'defender' : group === 'M' ? 'midfielder' : 'forward';
      return {
        kind: 'position-shortage',
        group,
        message: `You need ${slots.length - playersForGroup(game, demand, group).length} more ${label}${slots.length - playersForGroup(game, demand, group).length === 1 ? '' : 's'} to cover the formation.`,
      };
    }
  }
  return null;
}
