import type { DemandModel, NormalizedGame, NormalizedPlayer, PlayerQuota, QuotaAssignment, RedesignZone } from './model';
import { ZONE_POSITIONS } from './stage1';

export interface FrozenBlock {
  block: number;
  assignments: Map<string, string>;
}

export interface PlacementBlock {
  block: number;
  assignments: Map<string, string>;
}

export interface RestPin {
  player: string;
  blocks: number[];
}

export interface PlacementAudit {
  restPins: RestPin[];
  softRestFallback: boolean;
  outOfPositionBlocks: Record<string, number>;
  errors: string[];
}

export interface PlacementResult {
  blocks: PlacementBlock[];
  audit: PlacementAudit;
  complete: boolean;
}

interface PlacementState {
  remainingMin: Map<string, number>;
  remainingMax: Map<string, number>;
  outOfPosition: Map<string, number>;
}

function groupForSlot(slot: string): 'D' | 'M' | 'F' {
  if (['LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(slot)) return 'D';
  if (['LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM'].includes(slot)) return 'M';
  return 'F';
}

function zoneForSlot(slot: string): RedesignZone {
  return (Object.entries(ZONE_POSITIONS).find(([, positions]) => positions.has(slot))?.[0] ?? 'WIDE') as RedesignZone;
}

function isDedicatedKeeper(player: NormalizedPlayer): boolean {
  return player.generalPositions.length > 0 && player.generalPositions.every((position) => position === 'GK');
}

function isZonePosition(position: string, zone: RedesignZone, group: 'D' | 'M' | 'F'): boolean {
  return position === 'ANY' || position === group || ZONE_POSITIONS[zone].has(position);
}

export function positionTier(player: NormalizedPlayer, slot: string): 2 | 1 | 0 {
  const zone = zoneForSlot(slot);
  const group = groupForSlot(slot);
  if (player.primaryPositions.some((position) => isZonePosition(position, zone, group))) return 2;
  if (player.backupPositions.some((position) => isZonePosition(position, zone, group))) return 1;
  return 0;
}

export function excludedFromSlot(player: NormalizedPlayer, slot: string): boolean {
  const zone = zoneForSlot(slot);
  const group = groupForSlot(slot);
  return player.excludedPositions.some((position) => position === slot || position === zone || position === group || ZONE_POSITIONS[zone].has(position));
}

function restBlocks(game: NormalizedGame, quota: PlayerQuota, player: NormalizedPlayer): number[] {
  if (player.group !== 'core' || player.restPreset === 'none') return [];
  const restCount = Math.max(0, game.totalBlocks - quota.totalMax);
  if (!restCount) return [];
  const arrival = game.lateArrival?.player === player.name ? game.lateArrival.arrivalBlock : 1;
  const pins: number[] = [];
  if (player.restPreset === 'B') {
    const start = game.totalBlocks / 2 - Math.floor((restCount - 1) / 2);
    for (let index = 0; index < restCount; index += 1) pins.push(start + index);
  } else if (restCount === 1) {
    pins.push(Math.round(game.totalBlocks / 2));
  } else {
    const first = Math.round(game.totalBlocks / (restCount + 1));
    const last = game.totalBlocks - first + 1;
    for (let index = 0; index < restCount; index += 1) {
      pins.push(Math.round(first + index * (last - first) / (restCount - 1)));
    }
  }
  const used = new Set<number>();
  return pins
    .map((block) => Math.max(2, Math.min(game.totalBlocks - 1, block)))
    .filter((block) => block >= arrival && !used.has(block) && (used.add(block), true));
}

export function deriveRestPins(game: NormalizedGame, quotas: QuotaAssignment): RestPin[] {
  return quotas.quotas.flatMap((quota) => {
    const player = game.players.find((candidate) => candidate.name === quota.player);
    if (!player) return [];
    const blocks = restBlocks(game, quota, player);
    return blocks.length ? [{ player: player.name, blocks }] : [];
  });
}

function cloneState(state: PlacementState): PlacementState {
  return {
    remainingMin: new Map(state.remainingMin),
    remainingMax: new Map(state.remainingMax),
    outOfPosition: new Map(state.outOfPosition),
  };
}

function candidateAllowed(
  player: NormalizedPlayer,
  slot: string,
  block: number,
  assigned: Set<string>,
  state: PlacementState,
  rest: Map<string, Set<number>>,
  softRest: boolean,
  pinnedByBlock: Map<number, Set<string>>,
): boolean {
  if (!player.available || isDedicatedKeeper(player) || assigned.has(player.name)) return false;
  if ((state.remainingMax.get(player.name) ?? 0) <= 0 || excludedFromSlot(player, slot)) return false;
  if (!softRest && rest.get(player.name)?.has(block)) return false;
  if (positionTier(player, slot) === 0 && (state.outOfPosition.get(player.name) ?? 0) >= 2) return false;
  const futurePins = [...pinnedByBlock.entries()]
    .filter(([pinBlock, names]) => pinBlock > block && names.has(player.name)).length;
  if ((state.remainingMax.get(player.name) ?? 0) <= futurePins) return false;
  return true;
}

function compareCandidates(
  left: NormalizedPlayer,
  right: NormalizedPlayer,
  slot: string,
  block: number,
  game: NormalizedGame,
  state: PlacementState,
  softRest: boolean,
  continuingPlayers: Set<string>,
  rest: Map<string, Set<number>>,
): number {
  const leftMin = state.remainingMin.get(left.name) ?? 0;
  const rightMin = state.remainingMin.get(right.name) ?? 0;
  if ((leftMin > 0) !== (rightMin > 0)) return Number(rightMin > 0) - Number(leftMin > 0);
  if (leftMin !== rightMin) return rightMin - leftMin;
  const leftTier = positionTier(left, slot);
  const rightTier = positionTier(right, slot);
  if (leftTier !== rightTier) return rightTier - leftTier;
  if (softRest) {
    const leftRest = left.restPreset !== 'none' && game.totalBlocks > 0 ? 0 : 1;
    const rightRest = right.restPreset !== 'none' && game.totalBlocks > 0 ? 0 : 1;
    if (leftRest !== rightRest) return rightRest - leftRest;
  }
  const groupRank: Record<NormalizedPlayer['group'], number> = { core: 3, rotational: 2, developing: 1 };
  if (groupRank[left.group] !== groupRank[right.group]) return groupRank[right.group] - groupRank[left.group];
  if (block === Math.floor(game.totalBlocks / 2) + 1) {
    const leftContinuity = continuingPlayers.has(left.name) ? 1 : 0;
    const rightContinuity = continuingPlayers.has(right.name) ? 1 : 0;
    if (leftContinuity !== rightContinuity) return rightContinuity - leftContinuity;
  }
  if (softRest && block > 0) {
    const leftPinned = rest.get(left.name)?.has(block) ? 1 : 0;
    const rightPinned = rest.get(right.name)?.has(block) ? 1 : 0;
    if (leftPinned !== rightPinned) return leftPinned - rightPinned;
  }
  if (left.history.historicalFieldBlocks !== right.history.historicalFieldBlocks) {
    return left.history.historicalFieldBlocks - right.history.historicalFieldBlocks;
  }
  return left.name.localeCompare(right.name);
}

function futureFeasible(
  game: NormalizedGame,
  demand: DemandModel,
  players: NormalizedPlayer[],
  state: PlacementState,
  blocks: PlacementBlock[],
  rest: Map<string, Set<number>>,
  fromBlock: number,
  softRest: boolean,
  pinnedByBlock: Map<number, Set<string>>,
): boolean {
  const remainingSlots = demand.slotsPerBlock * (game.totalBlocks - fromBlock);
  const totalMax = [...state.remainingMax.values()].reduce((sum, value) => sum + value, 0);
  if (totalMax < remainingSlots) return false;
  for (let block = fromBlock + 1; block <= game.totalBlocks; block += 1) {
    const existing = blocks.find((candidate) => candidate.block === block)?.assignments;
    for (const slot of demand.fieldSlots.map((candidate) => candidate.slot)) {
      if (existing?.has(slot)) continue;
      if (!players.some((player) => candidateAllowed(player, slot, block, new Set(existing?.values()), state, rest, softRest, pinnedByBlock))) return false;
    }
  }
  return true;
}

function placeBlock(
  game: NormalizedGame,
  demand: DemandModel,
  players: NormalizedPlayer[],
  state: PlacementState,
  rest: Map<string, Set<number>>,
  blockNumber: number,
  previous: PlacementBlock[],
  softRest: boolean,
  pinnedByBlock: Map<number, Set<string>>,
  excludedCandidate?: string,
): PlacementBlock | null {
  const assignments = new Map<string, string>();
  const assigned = new Set<string>();
  const pinned = pinnedByBlock.get(blockNumber) ?? new Set<string>();
  const continuingPlayers = blockNumber === Math.floor(game.totalBlocks / 2) + 1
    ? new Set(previous.find((block) => block.block === blockNumber - 1)?.assignments.values())
    : new Set<string>();
  const slots = demand.fieldSlots.map((slot) => slot.slot);
  const assignPlayer = (player: NormalizedPlayer, slot: string, preAccounted = false): boolean => {
    if (!candidateAllowed(player, slot, blockNumber, assigned, state, rest, softRest, pinnedByBlock)) return false;
    assignments.set(slot, player.name);
    assigned.add(player.name);
    if (positionTier(player, slot) === 0) state.outOfPosition.set(player.name, (state.outOfPosition.get(player.name) ?? 0) + 1);
    if (!preAccounted) {
      state.remainingMax.set(player.name, (state.remainingMax.get(player.name) ?? 0) - 1);
      state.remainingMin.set(player.name, Math.max(0, (state.remainingMin.get(player.name) ?? 0) - 1));
    }
    return true;
  };
  for (const playerName of [...pinned].sort()) {
    if (excludedCandidate === playerName) return null;
    const player = players.find((candidate) => candidate.name === playerName);
    if (!player) continue;
    const slot = slots.filter((candidate) => !assignments.has(candidate))
      .sort((left, right) => positionTier(player, right) - positionTier(player, left) || slots.indexOf(left) - slots.indexOf(right))
      .find((candidate) => candidateAllowed(player, candidate, blockNumber, assigned, state, rest, softRest, pinnedByBlock));
    if (!slot || !assignPlayer(player, slot, true)) return null;
  }
  while (assignments.size < slots.length) {
    const openSlots = slots.filter((slot) => !assignments.has(slot));
    const slot = openSlots
      .map((candidate) => ({
        candidate,
        count: players.filter((player) => candidateAllowed(player, candidate, blockNumber, assigned, state, rest, softRest, pinnedByBlock)).length,
      }))
      .sort((left, right) => left.count - right.count || slots.indexOf(left.candidate) - slots.indexOf(right.candidate))[0]?.candidate;
    if (!slot) return null;
    const candidates = players
      .filter((player) => player.name !== excludedCandidate && candidateAllowed(player, slot, blockNumber, assigned, state, rest, softRest, pinnedByBlock))
      .sort((left, right) => compareCandidates(left, right, slot, blockNumber, game, state, softRest, continuingPlayers, rest));
    if (!candidates[0] || !assignPlayer(candidates[0], slot)) return null;
  }
  return { block: blockNumber, assignments };
}

export function placeStage3(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
  frozen: FrozenBlock[] = [],
  softRest = false,
): PlacementResult {
  const restPins = deriveRestPins(game, quotas);
  const rest = new Map(restPins.map((pin) => [pin.player, new Set(pin.blocks)]));
  const pinnedByBlock = new Map<number, Set<string>>();
  for (const quota of quotas.quotas) {
    for (const block of quota.pinnedBlocks) {
      if (!pinnedByBlock.has(block)) pinnedByBlock.set(block, new Set());
      pinnedByBlock.get(block)!.add(quota.player);
    }
  }
  const state: PlacementState = {
    remainingMin: new Map(quotas.quotas.map((quota) => [quota.player, quota.remainingMin])),
    remainingMax: new Map(quotas.quotas.map((quota) => [quota.player, quota.remainingMax])),
    outOfPosition: new Map(),
  };
  const players = game.players;
  const blocks: PlacementBlock[] = [];
  const frozenByBlock = new Map(frozen.map((block) => [block.block, block]));
  const errors: string[] = [];
  for (let blockNumber = 1; blockNumber <= game.totalBlocks; blockNumber += 1) {
    const frozenBlock = frozenByBlock.get(blockNumber);
    if (frozenBlock) {
      const assignments = new Map(frozenBlock.assignments);
      for (const player of assignments.values()) {
        state.remainingMax.set(player, (state.remainingMax.get(player) ?? 0) - 1);
        state.remainingMin.set(player, Math.max(0, (state.remainingMin.get(player) ?? 0) - 1));
      }
      blocks.push({ block: blockNumber, assignments });
      continue;
    }
    const snapshot = cloneState(state);
    const first = placeBlock(game, demand, players, state, rest, blockNumber, blocks, softRest, pinnedByBlock);
    const candidate = first ? [...first.assignments.values()][first.assignments.size - 1] : undefined;
    if (!first || !futureFeasible(game, demand, players, state, [...blocks, first], rest, blockNumber, softRest, pinnedByBlock)) {
      Object.assign(state, cloneState(snapshot));
      const retry = placeBlock(game, demand, players, state, rest, blockNumber, blocks, softRest, pinnedByBlock, candidate);
      if (!retry || !futureFeasible(game, demand, players, state, [...blocks, retry], rest, blockNumber, softRest, pinnedByBlock)) {
        errors.push(`Unable to place block ${blockNumber} without stranding a future slot.`);
        break;
      }
      blocks.push(retry);
    } else {
      blocks.push(first);
    }
  }
  return {
    blocks,
    complete: errors.length === 0 && blocks.length === game.totalBlocks,
    audit: {
      restPins,
      softRestFallback: softRest,
      outOfPositionBlocks: Object.fromEntries(state.outOfPosition),
      errors,
    },
  };
}
