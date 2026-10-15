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
  relaxationTier?: number;
  relaxedLookaheadFallback?: boolean;
  failureReason?: 'no-eligible-player' | 'minimum-window-exhausted' | 'maximum-capacity-exhausted' | 'search-budget-exhausted';
}

export interface PlacementResult {
  blocks: PlacementBlock[];
  audit: PlacementAudit;
  complete: boolean;
}

interface PlacementState {
  remainingMin: Map<string, number>;
  remainingTarget: Map<string, number>;
  remainingMax: Map<string, number>;
  placed?: Map<string, number>;
  outOfPosition?: Map<string, number>;
}

function groupForSlot(slot: string): 'D' | 'M' | 'F' {
  if (slot.startsWith('D')) return 'D';
  if (slot.startsWith('M')) return 'M';
  if (slot.startsWith('F') || slot === 'ST') return 'F';
  if (['LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(slot)) return 'D';
  if (['LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM'].includes(slot)) return 'M';
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

function isKeeperHalf(game: NormalizedGame, player: NormalizedPlayer, block: number): boolean {
  const half = game.totalBlocks / 2;
  return (player.name === game.firstHalfKeeper && block <= half)
    || (player.name === game.secondHalfKeeper && block > half);
}

function isFieldEligible(game: NormalizedGame, player: NormalizedPlayer, block: number, slot: string): boolean {
  if (isEligible(player, slot)) return true;
  return isDedicatedKeeper(player)
    && isOppositeHalfKeeper(game, player, block)
    && !excludedFromSlot(player, slot);
}

export function positionTier(player: NormalizedPlayer, slot: string): 2 | 1 | 0 {
  const group = groupForSlot(slot);
  const general = player.generalPositions.includes(group);
  if (player.primaryPositions.some((position) => position === 'ANY' ? general : position === slot || position === group)) return 2;
  if (general || player.backupPositions.some((position) => position === slot || position === group)) return 1;
  return 0;
}

function slotPriority(player: NormalizedPlayer, slot: string): number {
  const group = groupForSlot(slot);
  if (player.primaryPositions.some((position) => position !== 'ANY' && position === slot)) return 3;
  if (positionTier(player, slot) === 2) return 2;
  if (player.backupPositions.some((position) => position === slot)) return 1;
  return player.generalPositions.includes(group) ? 1 : 0;
}

function groupAffinity(player: NormalizedPlayer, slot: string): number {
  const group = groupForSlot(slot);
  if (player.generalPositions.includes(group)) return 2;
  return 0;
}

function isSpecificForGroup(player: NormalizedPlayer, group: 'D' | 'M' | 'F'): boolean {
  return player.primaryPositions.some((position) => position !== 'ANY'
    && (position === group || groupForSlot(position) === group));
}

function hasBackupForGroup(player: NormalizedPlayer, group: 'D' | 'M' | 'F'): boolean {
  return player.backupPositions.some((position) => position === group || groupForSlot(position) === group);
}

function placementPriority(player: NormalizedPlayer, group: 'D' | 'M' | 'F'): number {
  const inGeneralGroup = player.generalPositions.includes(group);
  if (inGeneralGroup && player.group === 'core' && isSpecificForGroup(player, group)) return 1;
  if (inGeneralGroup && player.group === 'core' && player.primaryPositions.includes('ANY')) return 2;
  if (inGeneralGroup && player.group !== 'core' && isSpecificForGroup(player, group)) return 3;
  if (inGeneralGroup && player.group !== 'core' && player.primaryPositions.includes('ANY')) return 4;
  if (inGeneralGroup) return 5;
  if (hasBackupForGroup(player, group)) return 6;
  return 7;
}

export function excludedFromSlot(player: NormalizedPlayer, slot: string): boolean {
  const zone = zoneForSlot(slot);
  const group = groupForSlot(slot);
  return player.excludedPositions.some((position) => position === slot || position === zone || position === group || ZONE_POSITIONS[zone].has(position));
}

export function isEligible(player: NormalizedPlayer, slot: string): boolean {
  return positionTier(player, slot) > 0 && !excludedFromSlot(player, slot);
}

function restBlocks(game: NormalizedGame, quota: PlayerQuota, player: NormalizedPlayer): number[] {
  if (player.group !== 'core' || player.restPreset === 'none') return [];
  const restCount = Math.max(0, game.totalBlocks - quota.totalMax);
  if (!restCount) return [];
  const arrival = game.lateArrival?.player === player.name ? game.lateArrival.arrivalBlock : 1;
  if (player.restPreset === 'B') {
    const start = game.totalBlocks / 2 - Math.floor((restCount - 1) / 2);
    return Array.from({ length: restCount }, (_, index) => start + index)
      .filter((block) => block >= arrival);
  }
  if (restCount === 1) return [Math.round(game.totalBlocks / 2)].filter((block) => block >= arrival);
  const first = Math.round(game.totalBlocks / (restCount + 1));
  const last = game.totalBlocks - first + 1;
  return Array.from({ length: restCount }, (_, index) => Math.round(first + index * (last - first) / (restCount - 1)))
    .map((block) => Math.max(2, Math.min(game.totalBlocks - 1, block)))
    .filter((block) => block >= arrival);
}

export function deriveRestPins(game: NormalizedGame, quotas: QuotaAssignment): RestPin[] {
  return quotas.quotas.flatMap((quota) => {
    const player = game.players.find((candidate) => candidate.name === quota.player);
    const blocks = player ? restBlocks(game, quota, player) : [];
    return blocks.length ? [{ player: quota.player, blocks }] : [];
  });
}

export function turnoverVariance(blocks: PlacementBlock[]): number {
  if (blocks.length < 3) return 0;
  const values = blocks.slice(1).map((block, index) => {
    const previous = new Set(blocks[index].assignments.values());
    const current = new Set(block.assignments.values());
    return [...new Set([...previous, ...current])].filter((player) => previous.has(player) !== current.has(player)).length;
  });
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
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
  demand?: DemandModel,
): number {
  const leftMin = state.remainingMin.get(left.name) ?? 0;
  const rightMin = state.remainingMin.get(right.name) ?? 0;
  const leftSlack = eligibleBlocks(left, block, game, demand, rest, softRest) - leftMin;
  const rightSlack = eligibleBlocks(right, block, game, demand, rest, softRest) - rightMin;
  return leftSlack - rightSlack
    || rightMin - leftMin
    || Number(previousPlayers.has(right.name)) - Number(previousPlayers.has(left.name))
    || Number(previousSlots.get(right.name) === slot) - Number(previousSlots.get(left.name) === slot)
    || left.name.localeCompare(right.name);
}

function eligibleBlocks(
  player: NormalizedPlayer,
  fromBlock: number,
  game: NormalizedGame,
  demand: DemandModel | undefined,
  rest: Map<string, Set<number>>,
  softRest: boolean,
): number {
  if (isDedicatedKeeper(player)
    && player.name !== game.firstHalfKeeper
    && player.name !== game.secondHalfKeeper) return 0;
  const slots = demand?.fieldSlots.map((candidate) => candidate.slot) ?? ['D', 'M', 'F'];
  return Array.from({ length: game.totalBlocks - fromBlock + 1 }, (_, index) => fromBlock + index)
    .filter((block) => !isKeeperHalf(game, player, block)
      && (softRest || !rest.get(player.name)?.has(block))
      && slots.some((slot) => isFieldEligible(game, player, block, slot))).length;
}

function groupOrder(game: NormalizedGame, demand: DemandModel): Array<'D' | 'M' | 'F'> {
  return (['D', 'M', 'F'] as const)
    .map((group, index) => ({
      group,
      ratio: game.players.filter((player) => player.generalPositions.includes(group)).length
        / Math.max(1, demand.fieldSlots.filter((slot) => slot.group === group).length),
      index,
    }))
    .sort((left, right) => left.ratio - right.ratio || left.index - right.index)
    .map(({ group }) => group);
}

function placeDeterministically(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
  frozen: FrozenBlock[],
  softRest: boolean,
): PlacementResult {
  const restPins = deriveRestPins(game, quotas);
  const rest = new Map(restPins.map((pin) => [pin.player, new Set(pin.blocks)]));
  const state: PlacementState = {
    remainingMin: new Map(quotas.quotas.map((quota) => [quota.player, quota.fieldMin])),
    remainingTarget: new Map(quotas.quotas.map((quota) => [quota.player, Math.max(quota.fieldTarget, quota.fieldMin)])),
    remainingMax: new Map(quotas.quotas.map((quota) => [quota.player, quota.fieldMax])),
    placed: new Map(),
  };
  const blocks = Array.from({ length: game.totalBlocks }, (_, index) => ({
    block: index + 1,
    assignments: new Map<string, string>(),
  }));
  for (const frozenBlock of frozen) {
    const target = blocks[frozenBlock.block - 1];
    if (!target) continue;
    for (const [slot, player] of frozenBlock.assignments) {
      target.assignments.set(slot, player);
      state.placed!.set(player, (state.placed!.get(player) ?? 0) + 1);
      state.remainingMax.set(player, (state.remainingMax.get(player) ?? 0) - 1);
      state.remainingMin.set(player, Math.max(0, (state.remainingMin.get(player) ?? 0) - 1));
      state.remainingTarget.set(player, Math.max(0, (state.remainingTarget.get(player) ?? 0) - 1));
    }
  }
  const pinned = new Map<number, Set<string>>();
  for (const quota of quotas.quotas) {
    for (const block of quota.pinnedBlocks) {
      const names = pinned.get(block) ?? new Set<string>();
      names.add(quota.player);
      pinned.set(block, names);
    }
  }
  const players = new Map(game.players.map((player) => [player.name, player]));
  const canPlace = (player: NormalizedPlayer, block: number, slot: string, ignoreMaximum = false): boolean => {
    const assignments = blocks[block - 1].assignments;
    return player.available
      && (!isDedicatedKeeper(player)
        || player.name === game.firstHalfKeeper
        || player.name === game.secondHalfKeeper)
      && !isKeeperHalf(game, player, block)
      && !assignmentsHasPlayer(assignments, player.name)
      && !isKeeperHalf(game, player, block)
      && (ignoreMaximum || (state.remainingMax.get(player.name) ?? 0) > 0)
      && (softRest || !rest.get(player.name)?.has(block)
        || (state.remainingMin.get(player.name) ?? 0) > 0)
      && isFieldEligible(game, player, block, slot);
  };
  const assign = (player: NormalizedPlayer, block: number, slot: string): boolean => {
    if (!canPlace(player, block, slot)) return false;
    blocks[block - 1].assignments.set(slot, player.name);
    state.remainingMax.set(player.name, (state.remainingMax.get(player.name) ?? 0) - 1);
    state.remainingMin.set(player.name, Math.max(0, (state.remainingMin.get(player.name) ?? 0) - 1));
    state.remainingTarget.set(player.name, Math.max(0, (state.remainingTarget.get(player.name) ?? 0) - 1));
    state.placed!.set(player.name, (state.placed!.get(player.name) ?? 0) + 1);
    return true;
  };
  for (const [blockNumber, names] of pinned) {
    const block = blocks[blockNumber - 1];
    if (!block) continue;
    for (const name of names) {
      const player = players.get(name);
      if (!player || assignmentsHasPlayer(block.assignments, name) || isKeeperHalf(game, player, blockNumber)) continue;
      const slot = demand.fieldSlots
        .filter((candidate) => candidate.group === groupForSlot(candidate.slot) && !block.assignments.has(candidate.slot))
        .sort((left, right) => slotPriority(player, right.slot) - slotPriority(player, left.slot))
        .find((candidate) => isEligible(player, candidate.slot));
      if (!slot) continue;
      block.assignments.set(slot.slot, player.name);
      state.remainingMax.set(player.name, (state.remainingMax.get(player.name) ?? 0) - 1);
      state.remainingMin.set(player.name, Math.max(0, (state.remainingMin.get(player.name) ?? 0) - 1));
      state.remainingTarget.set(player.name, Math.max(0, (state.remainingTarget.get(player.name) ?? 0) - 1));
      state.placed!.set(player.name, (state.placed!.get(player.name) ?? 0) + 1);
    }
  }
  const order = groupOrder(game, demand);
  const groupRestsPerBlock = new Map<string, number>();
  const sequentialRestBlocks = new Map<'D' | 'M' | 'F', Set<number>>([
    ['D', new Set<number>()],
    ['M', new Set<number>()],
    ['F', new Set<number>()],
  ]);
  for (const player of game.players) {
    const coveredGroups = (['D', 'M', 'F'] as const).filter((group) => player.generalPositions.includes(group));
    for (const block of rest.get(player.name) ?? []) {
      for (const coveredGroup of coveredGroups) {
        const key = `${coveredGroup}:${block}`;
        groupRestsPerBlock.set(key, (groupRestsPerBlock.get(key) ?? 0) + 1);
      }
    }
  }
  const selectSpacedBlocks = (player: NormalizedPlayer, group: 'D' | 'M' | 'F', useTarget: boolean): number[] => {
    const needed = (useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0;
    const frozenBlocks = new Set(frozen.map((block) => block.block));
    const eligible = blocks
      .filter((block) => !frozenBlocks.has(block.block)
        && !pinned.get(block.block)?.has(player.name)
        && !isKeeperHalf(game, player, block.block)
        && player.available
        && (softRest || !rest.get(player.name)?.has(block.block))
        && demand.fieldSlots.some((slot) => slot.group === group && isFieldEligible(game, player, block.block, slot.slot)))
      .map((block) => block.block);
    const restCount = eligible.length - needed;
    if (restCount <= 0) return eligible;
    const selected = new Set<number>();
    for (let index = 1; index <= restCount; index += 1) {
      const ideal = Math.round(index * (eligible.length + 1) / (restCount + 1)) - 1;
      const candidates = eligible
        .map((block, candidateIndex) => ({ block, candidateIndex }))
        .filter(({ block }) => !selected.has(block) && !sequentialRestBlocks.get(group)!.has(block))
        .sort((left, right) => {
          const leftLoad = groupRestsPerBlock.get(`${group}:${left.block}`) ?? 0;
          const rightLoad = groupRestsPerBlock.get(`${group}:${right.block}`) ?? 0;
          return leftLoad - rightLoad
            || Math.abs(left.candidateIndex - ideal) - Math.abs(right.candidateIndex - ideal)
            || left.block - right.block;
        });
      const choice = candidates[0]?.block;
      if (choice === undefined) {
        const fallback = eligible
          .map((block, candidateIndex) => ({ block, candidateIndex }))
          .filter(({ block }) => !selected.has(block))
          .sort((left, right) => {
            const leftLoad = groupRestsPerBlock.get(`${group}:${left.block}`) ?? 0;
            const rightLoad = groupRestsPerBlock.get(`${group}:${right.block}`) ?? 0;
            return leftLoad - rightLoad
              || Math.abs(left.candidateIndex - ideal) - Math.abs(right.candidateIndex - ideal)
              || left.block - right.block;
          })[0]?.block;
        if (fallback === undefined) continue;
        selected.add(fallback);
        sequentialRestBlocks.get(group)!.add(fallback);
        const key = `${group}:${fallback}`;
        groupRestsPerBlock.set(key, (groupRestsPerBlock.get(key) ?? 0) + 1);
        continue;
      }
      selected.add(choice);
      sequentialRestBlocks.get(group)!.add(choice);
      const key = `${group}:${choice}`;
      groupRestsPerBlock.set(key, (groupRestsPerBlock.get(key) ?? 0) + 1);
    }
    if (restCount <= 2) {
      const playerRest = rest.get(player.name) ?? new Set<number>();
      for (const block of selected) playerRest.add(block);
      rest.set(player.name, playerRest);
    }
    return eligible.filter((block) => !selected.has(block));
  };
  for (const useTarget of [false, true]) {
    for (const group of order) {
      const candidates = game.players
        .filter((player) => ((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) > 0
          && (player.generalPositions.includes(group)
            || hasBackupForGroup(player, group)
            || (group === 'D' && (player.name === game.firstHalfKeeper || player.name === game.secondHalfKeeper))))
        .sort((left, right) => placementPriority(left, group) - placementPriority(right, group)
          || left.name.localeCompare(right.name));
      for (const player of candidates) {
        const playBlocks = selectSpacedBlocks(player, group, useTarget);
        for (const blockNumber of playBlocks) {
          if (((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) <= 0) break;
          const slots = demand.fieldSlots.filter((slot) => slot.group === group && !blocks[blockNumber - 1].assignments.has(slot.slot))
            .sort((left, right) => slotPriority(player, right.slot) - slotPriority(player, left.slot));
          const slot = slots.find((candidate) => canPlace(player, blockNumber, candidate.slot));
          if (slot) assign(player, blockNumber, slot.slot);
        }
        if (((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) > 0) {
          for (const block of blocks) {
            if (((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) <= 0) break;
            const slots = demand.fieldSlots.filter((slot) => slot.group === group && !block.assignments.has(slot.slot))
              .sort((left, right) => slotPriority(player, right.slot) - slotPriority(player, left.slot));
            const slot = slots.find((candidate) => canPlace(player, block.block, candidate.slot));
            if (slot) assign(player, block.block, slot.slot);
          }
        }
      }
    }
  }
  for (const block of blocks) {
    for (const slot of demand.fieldSlots.filter((candidate) => !block.assignments.has(candidate.slot))) {
      const candidates = game.players
        .filter((player) => canPlace(player, block.block, slot.slot))
        .sort((left, right) => (state.remainingMin.get(right.name) ?? 0) - (state.remainingMin.get(left.name) ?? 0)
          || (state.placed!.get(left.name) ?? 0) - (state.placed!.get(right.name) ?? 0)
          || groupAffinity(right, slot.slot) - groupAffinity(left, slot.slot)
          || (state.remainingMax.get(right.name) ?? 0) - (state.remainingMax.get(left.name) ?? 0)
          || slotPriority(right, slot.slot) - slotPriority(left, slot.slot)
          || left.name.localeCompare(right.name));
      if (candidates[0]) {
        assign(candidates[0], block.block, slot.slot);
        continue;
      }
      const relaxedCandidate = game.players
        .filter((player) => player.generalPositions.includes(groupForSlot(slot.slot))
          && canPlace(player, block.block, slot.slot, true))
        .sort((left, right) => (state.remainingMin.get(right.name) ?? 0) - (state.remainingMin.get(left.name) ?? 0)
          || (state.placed!.get(left.name) ?? 0) - (state.placed!.get(right.name) ?? 0)
          || groupAffinity(right, slot.slot) - groupAffinity(left, slot.slot)
          || slotPriority(right, slot.slot) - slotPriority(left, slot.slot)
          || left.name.localeCompare(right.name))[0];
      if (relaxedCandidate) assign(relaxedCandidate, block.block, slot.slot);
      else console.log(`[placement] Unfilled: Block ${block.block}, slot ${slot.slot}. No eligible player with remaining capacity.`);
    }
  }
  const errors = [...state.remainingMin.entries()]
    .filter(([, remaining]) => remaining > 0)
    .map(([player, remaining]) => `Cannot place minimum for ${player}: ${remaining} block(s) remain.`);
  return {
    blocks,
    complete: true,
    audit: {
      restPins,
      softRestFallback: softRest,
      outOfPositionBlocks: {},
      errors,
      failureReason: errors.length ? 'minimum-window-exhausted' : undefined,
    },
  };
}

function assignmentsHasPlayer(assignments: Map<string, string>, player: string): boolean {
  return [...assignments.values()].includes(player);
}

export function placeStage3(
  game: NormalizedGame,
  demand: DemandModel,
  quotas: QuotaAssignment,
  frozen: FrozenBlock[] = [],
  softRest = false,
  _allowRelaxedMinimums = false,
): PlacementResult {
  return placeDeterministically(game, demand, quotas, frozen, softRest);
}
