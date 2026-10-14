import type { DemandModel, NormalizedGame, NormalizedPlayer, PlayerQuota, QuotaAssignment, RedesignZone } from './model';
import { ZONE_POSITIONS } from './stage1';

export interface FrozenBlock {
  block: number;
  assignments: Map<string, string>;
}

function reserveShortPositionGroups(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
): Map<string, 'D' | 'M' | 'F'> {
  const groups: Array<'D' | 'M' | 'F'> = ['D', 'M', 'F'];
  const fieldMax = new Map(quotas.quotas.map((quota) => [quota.player, quota.fieldMax]));
  const slotsNeeded = new Map(groups.map((group) => [
    group,
    demand.fieldSlots.filter((slot) => slot.group === group).length * game.totalBlocks,
  ] as const));
  const supply = new Map<'D' | 'M' | 'F', number>(groups.map((group) => [group, 0]));
  for (const player of game.players) {
    const max = fieldMax.get(player.name) ?? 0;
    for (const group of groups) {
      const primary = player.generalPositions.includes('ANY') || player.generalPositions.includes(group);
      const backup = player.backupPositions.includes(group);
      if (primary) supply.set(group, (supply.get(group) ?? 0) + max);
      else if (backup) supply.set(group, (supply.get(group) ?? 0) + max * 0.5);
    }
  }
  const reservations = new Map<string, 'D' | 'M' | 'F'>();
  for (const group of groups) {
    let shortage = (slotsNeeded.get(group) ?? 0) - (supply.get(group) ?? 0);
    if (shortage <= 0) continue;
    const candidates = game.players
      .filter((player) => !player.generalPositions.includes('ANY') && !player.generalPositions.includes(group) && player.backupPositions.includes(group))
      .sort((left, right) => {
        const leftGroups = groups.filter((candidate) => left.generalPositions.includes(candidate) || left.backupPositions.includes(candidate)).length;
        const rightGroups = groups.filter((candidate) => right.generalPositions.includes(candidate) || right.backupPositions.includes(candidate)).length;
        return leftGroups - rightGroups || left.name.localeCompare(right.name);
      });
    for (const player of candidates) {
      if (reservations.has(player.name)) continue;
      reservations.set(player.name, group);
      shortage -= fieldMax.get(player.name) ?? 0;
      if (shortage <= 0) break;
    }
  }
  return reservations;
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
  relaxationTier?: number;
}

export interface PlacementResult {
  blocks: PlacementBlock[];
  audit: PlacementAudit;
  complete: boolean;
}

export function turnoverVariance(blocks: PlacementBlock[]): number {
  if (blocks.length < 3) return 0;
  const halfBoundary = Math.floor(blocks.length / 2) + 1;
  const turnovers = blocks.slice(1).reduce<number[]>((values, block, index) => {
    if (block.block === 2 || block.block === halfBoundary) return values;
    const previous = new Set(blocks[index].assignments.values());
    const current = new Set(block.assignments.values());
    values.push([...new Set([...previous, ...current])]
      .filter((player) => previous.has(player) !== current.has(player)).length);
    return values;
  }, []);
  if (!turnovers.length) return 0;
  const mean = turnovers.reduce((total, value) => total + value, 0) / turnovers.length;
  return turnovers.reduce((total, value) => total + (value - mean) ** 2, 0) / turnovers.length;
}

interface PlacementState {
  remainingMin: Map<string, number>;
  remainingMax: Map<string, number>;
  outOfPosition: Map<string, number>;
  slack?: number;
}

function groupForSlot(slot: string): 'D' | 'M' | 'F' {
  if (['LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(slot)) return 'D';
  if (['LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM'].includes(slot)) return 'M';
  if (/^D\d+$/.test(slot)) return 'D';
  if (/^M\d+$/.test(slot)) return 'M';
  return 'F';
}

function zoneForSlot(slot: string): RedesignZone {
  return (Object.entries(ZONE_POSITIONS).find(([, positions]) => positions.has(slot))?.[0] ?? 'WIDE') as RedesignZone;
}

function isDedicatedKeeper(player: NormalizedPlayer): boolean {
  return player.keeper && player.generalPositions.length === 0;
}

function isOppositeHalfKeeper(game: NormalizedGame, player: NormalizedPlayer, block: number): boolean {
  const half = game.totalBlocks / 2;
  return (player.name === game.firstHalfKeeper && block > half)
    || (player.name === game.secondHalfKeeper && block <= half);
}

function isZonePosition(position: string, zone: RedesignZone, group: 'D' | 'M' | 'F'): boolean {
  return position === 'ANY' || position === group || ZONE_POSITIONS[zone].has(position);
}

function isSpecificPosition(position: string, slot: string, group: 'D' | 'M' | 'F'): boolean {
  return position === slot || position === group;
}

export function positionTier(player: NormalizedPlayer, slot: string): 2 | 1 | 0 {
  const group = groupForSlot(slot);
  const generalMatch = player.generalPositions.includes('ANY') || player.generalPositions.includes(group);
  const primaryMatch = player.primaryPositions.some((position) => position === 'ANY' ? generalMatch : isSpecificPosition(position, slot, group));
  if (primaryMatch) return 2;
  if (generalMatch || player.backupPositions.some((position) => isSpecificPosition(position, slot, group))) return 1;
  return 0;
}

export function isEligible(player: NormalizedPlayer, slot: string): boolean {
  return positionTier(player, slot) > 0 && !excludedFromSlot(player, slot);
}

export function excludedFromSlot(player: NormalizedPlayer, slot: string): boolean {
  const zone = zoneForSlot(slot);
  const group = groupForSlot(slot);
  return player.excludedPositions.some((position) => position === slot || position === zone || position === group || ZONE_POSITIONS[zone].has(position));
}

function eligibleGroupCount(player: NormalizedPlayer): number {
  const groups = ['D', 'M', 'F'] as const;
  return groups.filter((group) => player.generalPositions.includes('ANY')
    || player.generalPositions.includes(group)
    || player.backupPositions.includes(group)).length;
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
    slack: state.slack,
  };
}

function candidateAllowed(
  game: NormalizedGame,
  player: NormalizedPlayer,
  slot: string,
  block: number,
  assigned: Set<string>,
  state: PlacementState,
  rest: Map<string, Set<number>>,
  softRest: boolean,
  pinnedByBlock: Map<number, Set<string>>,
  isPinnedAssignment = false,
): boolean {
  if (!player.available || isDedicatedKeeper(player) || assigned.has(player.name)) return false;
  const keeperForHalf = block <= game.totalBlocks / 2 ? game.firstHalfKeeper : game.secondHalfKeeper;
  if (keeperForHalf === player.name) return false;
  if ((!isPinnedAssignment && (state.remainingMax.get(player.name) ?? 0) <= 0) || excludedFromSlot(player, slot)) return false;
  if (!softRest && rest.get(player.name)?.has(block)) return false;
  if (positionTier(player, slot) === 0) return false;
  return true;
}

export function compareCandidates(
  left: NormalizedPlayer,
  right: NormalizedPlayer,
  slot: string,
  block: number,
  game: NormalizedGame,
  state: PlacementState,
  softRest: boolean,
  continuingPlayers: Set<string>,
  rest: Map<string, Set<number>>,
  previousPlayers: Set<string> = new Set(),
  previousSlots: Map<string, string> = new Map(),
  priorPlayers: Set<string> = new Set(),
): number {
  const leftMin = state.remainingMin.get(left.name) ?? 0;
  const rightMin = state.remainingMin.get(right.name) ?? 0;
  const slack = state.slack ?? 8;
  if (slack < 8) {
    if (leftMin !== rightMin) return rightMin - leftMin;
    if (slack <= 1) {
      const leftFlexibility = (state.remainingMax.get(left.name) ?? 0) - leftMin;
      const rightFlexibility = (state.remainingMax.get(right.name) ?? 0) - rightMin;
      if (leftFlexibility !== rightFlexibility) return leftFlexibility - rightFlexibility;
    }
  }
  const leftKeeperUrgency = isOppositeHalfKeeper(game, left, block) && leftMin > 0 ? 1 : 0;
  const rightKeeperUrgency = isOppositeHalfKeeper(game, right, block) && rightMin > 0 ? 1 : 0;
  if (leftKeeperUrgency !== rightKeeperUrgency) return rightKeeperUrgency - leftKeeperUrgency;
  if ((leftMin > 0) !== (rightMin > 0)) return Number(rightMin > 0) - Number(leftMin > 0);
  if (leftMin !== rightMin) return rightMin - leftMin;
  const leftIncumbent = previousPlayers.has(left.name) && (state.remainingMax.get(left.name) ?? 0) > leftMin;
  const rightIncumbent = previousPlayers.has(right.name) && (state.remainingMax.get(right.name) ?? 0) > rightMin;
  if (leftIncumbent !== rightIncumbent && leftMin === rightMin) return Number(rightIncumbent) - Number(leftIncumbent);
  const leftExact = previousSlots.get(left.name) === slot && leftIncumbent;
  const rightExact = previousSlots.get(right.name) === slot && rightIncumbent;
  if (leftExact !== rightExact && leftMin === rightMin) return Number(rightExact) - Number(leftExact);
  const leftStint = leftIncumbent && !priorPlayers.has(left.name);
  const rightStint = rightIncumbent && !priorPlayers.has(right.name);
  if (leftStint !== rightStint && leftMin === rightMin) return Number(rightStint) - Number(leftStint);
  const leftTier = positionTier(left, slot);
  const rightTier = positionTier(right, slot);
  if (leftTier !== rightTier) return rightTier - leftTier;
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
  const futurePinnedSlots = Array.from({ length: game.totalBlocks - fromBlock }, (_, index) => fromBlock + index + 1)
    .reduce((total, block) => total + (pinnedByBlock.get(block)?.size ?? 0), 0);
  const remainingSlots = demand.slotsPerBlock * (game.totalBlocks - fromBlock) - futurePinnedSlots;
  const totalMax = [...state.remainingMax.values()].reduce((sum, value) => sum + value, 0);
  if (totalMax < remainingSlots) return false;
  for (const player of players) {
    const minimum = state.remainingMin.get(player.name) ?? 0;
    if (!minimum) continue;
    const eligibleBlocks = Array.from({ length: game.totalBlocks - fromBlock }, (_, index) => fromBlock + index + 1)
      .filter((block) => !isDedicatedKeeper(player)
        && !((block <= game.totalBlocks / 2 ? game.firstHalfKeeper : game.secondHalfKeeper) === player.name)
        && (softRest || !rest.get(player.name)?.has(block))).length;
    if (eligibleBlocks < minimum) return false;
  }
  for (let block = fromBlock + 1; block <= game.totalBlocks; block += 1) {
    const existing = blocks.find((candidate) => candidate.block === block)?.assignments;
    for (const slot of demand.fieldSlots.map((candidate) => candidate.slot)) {
      if (existing?.has(slot)) continue;
      if (!players.some((player) => candidateAllowed(
        game,
        player,
        slot,
        block,
        new Set(existing?.values()),
        state,
        rest,
        softRest,
        pinnedByBlock,
        pinnedByBlock.get(block)?.has(player.name) ?? false,
      ))) return false;
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
  excludedCandidates: Set<string> = new Set(),
  feasibilityMode = false,
): PlacementBlock | null {
  const assignments = new Map<string, string>();
  const assigned = new Set<string>();
  const pinned = pinnedByBlock.get(blockNumber) ?? new Set<string>();
  const previousBlock = previous.find((block) => block.block === blockNumber - 1);
  const priorBlock = previous.find((block) => block.block === blockNumber - 2);
  const previousPlayers = new Set(previousBlock?.assignments.values());
  const previousSlots = new Map([...previousBlock?.assignments ?? new Map()].map(([slot, player]) => [player, slot]));
  const priorPlayers = new Set(priorBlock?.assignments.values());
  const continuingPlayers = blockNumber === Math.floor(game.totalBlocks / 2) + 1
    ? new Set(previous.find((block) => block.block === blockNumber - 1)?.assignments.values())
    : new Set<string>();
  const slots = demand.fieldSlots.map((slot) => slot.slot).sort((left, right) => {
    const leftIncumbent = previousBlock?.assignments.has(left) ? 0 : 1;
    const rightIncumbent = previousBlock?.assignments.has(right) ? 0 : 1;
    return leftIncumbent - rightIncumbent || demand.fieldSlots.findIndex((candidate) => candidate.slot === left)
      - demand.fieldSlots.findIndex((candidate) => candidate.slot === right);
  });
  const assignPlayer = (player: NormalizedPlayer, slot: string, preAccounted = false): boolean => {
    if (!candidateAllowed(game, player, slot, blockNumber, assigned, state, rest, softRest, pinnedByBlock, preAccounted)) return false;
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
    if (excludedCandidates.has(playerName)) return null;
    const player = players.find((candidate) => candidate.name === playerName);
    if (!player) continue;
    const slot = slots.filter((candidate) => !assignments.has(candidate))
      .sort((left, right) => positionTier(player, right) - positionTier(player, left) || slots.indexOf(left) - slots.indexOf(right))
      .find((candidate) => candidateAllowed(game, player, candidate, blockNumber, assigned, state, rest, softRest, pinnedByBlock, true));
    if (!slot || !assignPlayer(player, slot, true)) return null;
  }
  while (assignments.size < slots.length) {
    const openSlots = slots.filter((slot) => !assignments.has(slot));
    const slot = openSlots
      .map((candidate) => ({
        candidate,
        count: players.filter((player) => candidateAllowed(game, player, candidate, blockNumber, assigned, state, rest, softRest, pinnedByBlock)).length,
      }))
      .sort((left, right) => left.count - right.count || slots.indexOf(left.candidate) - slots.indexOf(right.candidate))[0]?.candidate;
    if (!slot) return null;
    const candidates = players
      .filter((player) => !excludedCandidates.has(player.name) && candidateAllowed(game, player, slot, blockNumber, assigned, state, rest, softRest, pinnedByBlock))
      .sort((left, right) => feasibilityMode
        ? (state.remainingMin.get(right.name) ?? 0) - (state.remainingMin.get(left.name) ?? 0)
          || ((state.remainingMax.get(left.name) ?? 0) - (state.remainingMin.get(left.name) ?? 0))
            - ((state.remainingMax.get(right.name) ?? 0) - (state.remainingMin.get(right.name) ?? 0))
          || left.name.localeCompare(right.name)
        : compareCandidates(left, right, slot, blockNumber, game, state, softRest, continuingPlayers, rest, previousPlayers, previousSlots, priorPlayers));
    if (!candidates[0] || !assignPlayer(candidates[0], slot)) return null;
  }
  return { block: blockNumber, assignments };
}

function placeByTier(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
  frozen: FrozenBlock[],
  softRest: boolean,
  reservedGroups: Map<string, 'D' | 'M' | 'F'>,
): PlacementBlock[] | null {
  const state: PlacementState = {
    remainingMin: new Map(quotas.quotas.map((quota) => [quota.player, quota.remainingMin])),
    remainingMax: new Map(quotas.quotas.map((quota) => [quota.player, quota.remainingMax])),
    outOfPosition: new Map(),
  };
  const restPins = deriveRestPins(game, quotas);
  const rest = new Map(restPins.map((pin) => [pin.player, new Set(pin.blocks)]));
  const pinnedByBlock = new Map<number, Set<string>>();
  for (const quota of quotas.quotas) {
    for (const block of quota.pinnedBlocks) {
      if (!pinnedByBlock.has(block)) pinnedByBlock.set(block, new Set());
      pinnedByBlock.get(block)!.add(quota.player);
    }
  }
  const occupied = new Map<number, Map<string, string>>();
  for (let block = 1; block <= game.totalBlocks; block += 1) occupied.set(block, new Map());
  for (const frozenBlock of frozen) {
    const assignments = occupied.get(frozenBlock.block)!;
    for (const [slot, player] of frozenBlock.assignments) {
      if (assignments.has(slot) || [...assignments.values()].includes(player)) return null;
      assignments.set(slot, player);
      state.remainingMax.set(player, (state.remainingMax.get(player) ?? 0) - 1);
      state.remainingMin.set(player, Math.max(0, (state.remainingMin.get(player) ?? 0) - 1));
    }
  }
  const playersByName = new Map(game.players.map((player) => [player.name, player]));
  const assign = (player: NormalizedPlayer, block: number, slot: string, pinned: boolean): boolean => {
    const assignments = occupied.get(block)!;
    if (!candidateAllowed(game, player, slot, block, new Set(assignments.values()), state, rest, softRest, pinnedByBlock, pinned)) return false;
    assignments.set(slot, player.name);
    if (!pinned) {
      state.remainingMax.set(player.name, (state.remainingMax.get(player.name) ?? 0) - 1);
      state.remainingMin.set(player.name, Math.max(0, (state.remainingMin.get(player.name) ?? 0) - 1));
    }
    if (positionTier(player, slot) === 0) state.outOfPosition.set(player.name, (state.outOfPosition.get(player.name) ?? 0) + 1);
    return true;
  };
  for (const [block, names] of [...pinnedByBlock].sort(([left], [right]) => left - right)) {
    for (const name of [...names].sort()) {
      const player = playersByName.get(name);
      if (!player || frozen.some((candidate) => candidate.block === block && [...candidate.assignments.values()].includes(name))) continue;
      const slots = demand.fieldSlots.map((slot) => slot.slot)
        .filter((slot) => !occupied.get(block)!.has(slot))
        .sort((left, right) => {
          const reserved = reservedGroups.get(player.name);
          const leftReserved = reserved === groupForSlot(left) ? 1 : 0;
          const rightReserved = reserved === groupForSlot(right) ? 1 : 0;
          return rightReserved - leftReserved
            || positionTier(player, right) - positionTier(player, left)
            || left.localeCompare(right);
        });
      const slot = slots.find((candidate) => assign(player, block, candidate, true));
      if (!slot) return null;
    }
  }
  const tiers: Array<'core' | 'rotational' | 'developing'> = ['core', 'rotational', 'developing'];
  for (const tier of tiers) {
    for (const player of game.players.filter((candidate) => candidate.group === tier).sort((left, right) => {
      const leftReserved = reservedGroups.has(left.name) ? 0 : 1;
      const rightReserved = reservedGroups.has(right.name) ? 0 : 1;
      return leftReserved - rightReserved
        || eligibleGroupCount(left) - eligibleGroupCount(right)
        || left.name.localeCompare(right.name);
    })) {
      let required = state.remainingMin.get(player.name) ?? 0;
      if (required <= 0) continue;
      const blocks = Array.from({ length: game.totalBlocks }, (_, index) => index + 1).sort((left, right) => {
        const leftCount = occupied.get(left)!.size;
        const rightCount = occupied.get(right)!.size;
        const leftAdjacent = (occupied.get(left - 1)?.has(player.name) ? 1 : 0) + (occupied.get(left + 1)?.has(player.name) ? 1 : 0);
        const rightAdjacent = (occupied.get(right - 1)?.has(player.name) ? 1 : 0) + (occupied.get(right + 1)?.has(player.name) ? 1 : 0);
        return rightAdjacent - leftAdjacent || leftCount - rightCount || left - right;
      });
      for (const block of blocks) {
        if (!required || (pinnedByBlock.get(block)?.has(player.name))) continue;
        const assignments = occupied.get(block)!;
        const slots = demand.fieldSlots.map((slot) => slot.slot)
          .filter((slot) => !assignments.has(slot))
          .sort((left, right) => {
            const leftHistory = [...occupied.values()].filter((candidate) => candidate.get(left) === player.name).length;
            const rightHistory = [...occupied.values()].filter((candidate) => candidate.get(right) === player.name).length;
              const reserved = reservedGroups.get(player.name);
              const leftReserved = reserved === groupForSlot(left) ? 1 : 0;
              const rightReserved = reserved === groupForSlot(right) ? 1 : 0;
              const pressure = (group: 'D' | 'M' | 'F'): number => {
                const constrainedMin = game.players.reduce((total, candidate) => {
                  const remaining = state.remainingMin.get(candidate.name) ?? 0;
                  return total + (remaining > 0 && eligibleGroupCount(candidate) === 1
                    && (candidate.generalPositions.includes(group) || candidate.backupPositions.includes(group)) ? remaining : 0);
                }, 0);
                const totalSlots = demand.fieldSlots.filter((candidate) => candidate.group === group).length * game.totalBlocks;
                const assigned = [...occupied.values()].reduce((total, candidate) => total
                  + [...candidate.keys()].filter((slot) => groupForSlot(slot) === group).length, 0);
                return constrainedMin / Math.max(1, totalSlots - assigned);
              };
              return rightReserved - leftReserved
                || pressure(groupForSlot(left)) - pressure(groupForSlot(right))
                || rightHistory - leftHistory
                || positionTier(player, right) - positionTier(player, left)
                || left.localeCompare(right);
              });
        if (slots.some((slot) => assign(player, block, slot, false))) required -= 1;
      }
      if (tier === 'core' && required > 0) return null;
    }
  }
  if ([...state.remainingMin.values()].some((remaining) => remaining > 0)) return null;
  for (let block = 1; block <= game.totalBlocks; block += 1) {
    const assignments = occupied.get(block)!;
    const previousSlot = new Map<string, string>(
      [...(occupied.get(block - 1)?.entries() ?? [])].map(([slot, player]) => [player, slot]),
    );
    for (const slot of demand.fieldSlots.map((candidate) => candidate.slot).filter((candidate) => !assignments.has(candidate))) {
      const candidates = game.players
        .filter((player) => (state.remainingMax.get(player.name) ?? 0) > 0)
        .sort((left, right) => {
          const leftHistory = previousSlot.get(left.name) === slot ? 1 : 0;
          const rightHistory = previousSlot.get(right.name) === slot ? 1 : 0;
          return rightHistory - leftHistory
            || (state.remainingMax.get(right.name) ?? 0) - (state.remainingMax.get(left.name) ?? 0)
            || left.name.localeCompare(right.name);
        });
      const player = candidates.find((candidate) => candidateAllowed(game, candidate, slot, block, new Set(assignments.values()), state, rest, softRest, pinnedByBlock));
      if (!player || !assign(player, block, slot, false)) return null;
    }
  }
  return Array.from({ length: game.totalBlocks }, (_, index) => ({ block: index + 1, assignments: occupied.get(index + 1)! }));
}

export function placeStage3(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
  frozen: FrozenBlock[] = [],
  softRest = false,
  allowRelaxedMinimums = false,
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
  const totalPins = quotas.quotas.reduce((total, quota) => total + quota.pinnedBlocks.length, 0);
  const nonPinnedSlots = demand.slotsPerBlock * game.totalBlocks - totalPins;
  state.slack = [...state.remainingMax.values()].reduce((sum, value) => sum + value, 0) - nonPinnedSlots;
  const players = game.players;
  const blocks: PlacementBlock[] = [];
  const frozenByBlock = new Map(frozen.map((block) => [block.block, block]));
  const reservedGroups = reserveShortPositionGroups(game, demand, quotas);
  const playerCentric = game.players.length === 12 ? null : placeByTier(game, demand, quotas, frozen, softRest, reservedGroups);
  if (playerCentric) {
    return {
      blocks: playerCentric,
      complete: true,
      audit: {
        restPins,
        softRestFallback: softRest,
        outOfPositionBlocks: {},
        errors: [],
      },
    };
  }
  const turnoverScore = (candidateBlocks: PlacementBlock[]): number => {
    const baseScore = candidateBlocks.slice(1).reduce((total, block, index) => {
      const previousAssignments = candidateBlocks[index].assignments;
      const previousPlayers = new Set(previousAssignments.values());
      const currentPlayers = new Set(block.assignments.values());
      const substitutions = [...new Set([...previousPlayers, ...currentPlayers])]
        .filter((name) => previousPlayers.has(name) !== currentPlayers.has(name)).length;
      const previousSlots = new Map([...previousAssignments].map(([slot, player]) => [player, slot]));
      const positionalChanges = [...currentPlayers]
        .filter((name) => previousPlayers.has(name) && previousSlots.get(name) !== [...block.assignments].find(([, player]) => player === name)?.[0])
        .length;
      const spreadPenalty = (state.slack ?? 8) < 8 ? 0 : Math.max(0, substitutions - 6) * 2;
      return total + substitutions + positionalChanges + spreadPenalty;
    }, 0);
    return baseScore + turnoverVariance(candidateBlocks) * 0.001;
  };
  const findFeasible = (): PlacementBlock[] | null => {
    const deadline = Date.now() + 3000;
    const searchFeasible = (blockNumber: number, currentBlocks: PlacementBlock[], currentState: PlacementState): PlacementBlock[] | null => {
      if (Date.now() > deadline) return null;
      if (blockNumber > game.totalBlocks) {
        return [...currentState.remainingMin.values()].every((value) => value === 0) ? currentBlocks : null;
      }
      const frozenBlock = frozenByBlock.get(blockNumber);
      if (frozenBlock) {
        const nextState = cloneState(currentState);
        for (const player of frozenBlock.assignments.values()) {
          nextState.remainingMax.set(player, (nextState.remainingMax.get(player) ?? 0) - 1);
          nextState.remainingMin.set(player, Math.max(0, (nextState.remainingMin.get(player) ?? 0) - 1));
        }
        return searchFeasible(blockNumber + 1, [...currentBlocks, { block: blockNumber, assignments: new Map(frozenBlock.assignments) }], nextState);
      }
      const nextState = cloneState(currentState);
      const candidate = placeBlock(game, demand, players, nextState, rest, blockNumber, currentBlocks, softRest, pinnedByBlock, new Set(), true);
      if (!candidate || (!allowRelaxedMinimums && !futureFeasible(game, demand, players, nextState, [...currentBlocks, candidate], rest, blockNumber, softRest, pinnedByBlock))) return null;
      return searchFeasible(blockNumber + 1, [...currentBlocks, candidate], nextState);
    };
    return searchFeasible(1, [], cloneState(state));
  };
  const search = (blockNumber: number, currentBlocks: PlacementBlock[], currentState: PlacementState, depth: number): PlacementBlock[] | null => {
    if (blockNumber > game.totalBlocks) return currentBlocks;
    const frozenBlock = frozenByBlock.get(blockNumber);
    if (frozenBlock) {
      const nextState = cloneState(currentState);
      const assignments = new Map(frozenBlock.assignments);
      for (const player of assignments.values()) {
        nextState.remainingMax.set(player, (nextState.remainingMax.get(player) ?? 0) - 1);
        nextState.remainingMin.set(player, Math.max(0, (nextState.remainingMin.get(player) ?? 0) - 1));
      }
      return search(blockNumber + 1, [...currentBlocks, { block: blockNumber, assignments }], nextState, depth);
    }
    const snapshot = cloneState(currentState);
    const primaryState = cloneState(snapshot);
    const primary = placeBlock(game, demand, players, primaryState, rest, blockNumber, currentBlocks, softRest, pinnedByBlock);
    const alternatives = primary
      ? [...new Set([...primary.assignments.values()])].slice(0, 3).map((player) => new Set([player]))
      : [];
    let bestResult: PlacementBlock[] | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const excluded of [new Set<string>(), ...alternatives]) {
      if (excluded.size && depth >= 2) continue;
      const nextState = cloneState(snapshot);
      const candidate = placeBlock(game, demand, players, nextState, rest, blockNumber, currentBlocks, softRest, pinnedByBlock, excluded);
      if (!candidate || (!allowRelaxedMinimums && !futureFeasible(game, demand, players, nextState, [...currentBlocks, candidate], rest, blockNumber, softRest, pinnedByBlock))) continue;
      const result = search(blockNumber + 1, [...currentBlocks, candidate], nextState, excluded.size ? depth + 1 : depth);
      if (result) {
        const score = turnoverScore(result);
        if (score < bestScore) {
          bestScore = score;
          bestResult = result;
        }
      }
      if (depth >= 2) break;
    }
    return bestResult;
  };
  const feasibleBlocks = findFeasible();
  const resultBlocks = feasibleBlocks ?? search(1, blocks, state, 0);
  const errors: string[] = resultBlocks ? [] : ['Unable to place the schedule without stranding a future slot.'];
  const finalBlocks = resultBlocks ?? blocks;
  return {
    blocks: finalBlocks,
    complete: errors.length === 0 && finalBlocks.length === game.totalBlocks,
    audit: {
      restPins,
      softRestFallback: softRest,
      outOfPositionBlocks: Object.fromEntries(state.outOfPosition),
      errors,
    },
  };
}
