import type { DemandModel, NormalizedGame, NormalizedPlayer, PlayerQuota, QuotaAssignment, RedesignZone } from './model';
import { ZONE_POSITIONS } from './stage1';
import { isDedicatedKeeper } from '@/position-groups';

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
  plannedVsPlaced?: Array<{
    player: string;
    group: 'D' | 'M' | 'F';
    planned: number;
    placed: number;
    difference: number;
  }>;
  unplannedBackupUses?: Array<{ player: string; group: 'D' | 'M' | 'F'; blocks: number }>;
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

export function groupForSlot(slot: string): 'D' | 'M' | 'F' {
  if (slot.startsWith('D')) return 'D';
  if (slot.startsWith('M')) return 'M';
  if (slot.startsWith('F') || slot === 'ST') return 'F';
  if (['LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(slot)) return 'D';
  if (['LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM', 'LDM', 'RDM'].includes(slot)) return 'M';
  return 'F';
}

function zoneForSlot(slot: string): RedesignZone {
  return (Object.entries(ZONE_POSITIONS).find(([, positions]) => positions.has(slot))?.[0] ?? 'WIDE') as RedesignZone;
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
  return isDedicatedKeeper(player.keeper, player.generalPositions)
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
  if (isDedicatedKeeper(player.keeper, player.generalPositions)
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
  const restPinBlocks = new Map(restPins.map((pin) => [pin.player, new Set(pin.blocks)]));
  const selectedRestBlocks = new Map<string, Set<number>>();
  const state: PlacementState = {
    remainingMin: new Map(quotas.quotas.map((quota) => [quota.player, quota.fieldMin])),
    remainingTarget: new Map(quotas.quotas.map((quota) => [quota.player, Math.max(quota.fieldTarget, quota.fieldMin)])),
    remainingMax: new Map(quotas.quotas.map((quota) => [quota.player, quota.fieldMax])),
    placed: new Map(),
  };
  const remainingGroupTarget = new Map(quotas.quotas
    .filter((quota) => quota.groupTargets)
    .map((quota) => [quota.player, new Map(Object.entries(quota.groupTargets!) as Array<['D' | 'M' | 'F', number]>)]));
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
      const groupTarget = remainingGroupTarget.get(player);
      const group = groupForSlot(slot);
      if (groupTarget?.has(group)) groupTarget.set(group, Math.max(0, (groupTarget.get(group) ?? 0) - 1));
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
  const canPlace = (
    player: NormalizedPlayer,
    block: number,
    slot: string,
    options: { ignoreMaximum?: boolean; ignoreSelectedRest?: boolean } = {},
  ): boolean => {
    const assignments = blocks[block - 1].assignments;
    const selectedKeeper = player.name === game.firstHalfKeeper || player.name === game.secondHalfKeeper;
    const ignoresMaximum = options.ignoreMaximum && !selectedKeeper;
    const hasRestPin = restPinBlocks.get(player.name)?.has(block) ?? false;
    const hasSelectedRest = selectedRestBlocks.get(player.name)?.has(block) ?? false;
    return player.available
      && (!isDedicatedKeeper(player.keeper, player.generalPositions)
        || player.name === game.firstHalfKeeper
        || player.name === game.secondHalfKeeper)
      && !isKeeperHalf(game, player, block)
      && !assignmentsHasPlayer(assignments, player.name)
      && (ignoresMaximum || (state.remainingMax.get(player.name) ?? 0) > 0)
      && (softRest || !rest.get(player.name)?.has(block)
        || (state.remainingMin.get(player.name) ?? 0) > 0
        || (hasSelectedRest && !hasRestPin
          && (remainingGroupTarget.get(player.name)?.get(groupForSlot(slot)) ?? 0) > 0)
        || (options.ignoreSelectedRest === true && hasSelectedRest && !hasRestPin))
      && isFieldEligible(game, player, block, slot);
  };
  const assign = (
    player: NormalizedPlayer,
    block: number,
    slot: string,
    options: { ignoreMaximum?: boolean; ignoreSelectedRest?: boolean } = {},
  ): boolean => {
    if (!canPlace(player, block, slot, options)) return false;
    blocks[block - 1].assignments.set(slot, player.name);
    state.remainingMax.set(player.name, (state.remainingMax.get(player.name) ?? 0) - 1);
    state.remainingMin.set(player.name, Math.max(0, (state.remainingMin.get(player.name) ?? 0) - 1));
    state.remainingTarget.set(player.name, Math.max(0, (state.remainingTarget.get(player.name) ?? 0) - 1));
    state.placed!.set(player.name, (state.placed!.get(player.name) ?? 0) + 1);
    const groupTarget = remainingGroupTarget.get(player.name);
    const group = groupForSlot(slot);
    if ((groupTarget?.get(group) ?? 0) > 0) groupTarget!.set(group, groupTarget!.get(group)! - 1);
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
  const restSelectionDone = new Set<string>();
  for (const player of game.players) {
    const coveredGroups = (['D', 'M', 'F'] as const).filter((group) => player.generalPositions.includes(group));
    for (const block of rest.get(player.name) ?? []) {
      for (const coveredGroup of coveredGroups) {
        const key = `${coveredGroup}:${block}`;
        groupRestsPerBlock.set(key, (groupRestsPerBlock.get(key) ?? 0) + 1);
      }
    }
  }
  const selectedRestCount = (playerName: string, firstHalf: boolean): number => [...(rest.get(playerName) ?? [])]
    .filter((block) => (block <= game.totalBlocks / 2) === firstHalf).length;
  const coreBenchesIfRested = (player: NormalizedPlayer, blockNumber: number): number => {
    const coreRests = game.players.filter((candidate) => candidate.group === 'core'
      && !isKeeperHalf(game, candidate, blockNumber)
      && rest.get(candidate.name)?.has(blockNumber)).length;
    return coreRests + (player.group === 'core'
      && !isKeeperHalf(game, player, blockNumber)
      && !rest.get(player.name)?.has(blockNumber) ? 1 : 0);
  };
  const groupRestPressure = (player: NormalizedPlayer, group: 'D' | 'M' | 'F', blockNumber: number): number => {
    const current = groupRestsPerBlock.get(`${group}:${blockNumber}`) ?? 0;
    const additional = player.generalPositions.includes(group)
      && !rest.get(player.name)?.has(blockNumber) ? 1 : 0;
    const available = game.players.filter((candidate) => candidate.available
      && candidate.generalPositions.includes(group)
      && !isKeeperHalf(game, candidate, blockNumber)
      && demand.fieldSlots.some((slot) => slot.group === group && isFieldEligible(game, candidate, blockNumber, slot.slot))).length;
    const capacity = Math.max(0, available - demand.fieldSlots.filter((slot) => slot.group === group).length);
    return Math.max(0, current + additional - capacity) * 100 + current + additional;
  };
  const selectSpacedBlocks = (player: NormalizedPlayer, group: 'D' | 'M' | 'F', useTarget: boolean): number[] => {
    const frozenBlocks = new Set(frozen.map((block) => block.block));
    if (!restSelectionDone.has(player.name)) {
      restSelectionDone.add(player.name);
      const needed = state.remainingTarget.get(player.name) ?? state.remainingMin.get(player.name) ?? 0;
      const eligible = blocks
        .filter((block) => !frozenBlocks.has(block.block)
          && !pinned.get(block.block)?.has(player.name)
          && !isKeeperHalf(game, player, block.block)
          && player.available
          && !assignmentsHasPlayer(block.assignments, player.name)
          && !rest.get(player.name)?.has(block.block)
          && demand.fieldSlots.some((slot) => !block.assignments.has(slot.slot)
            && isFieldEligible(game, player, block.block, slot.slot)))
        .map((block) => block.block);
      const restCount = Math.max(0, eligible.length - needed);
      const selected = new Set<number>();
      const halfRestOrder = (blockNumber: number): number =>
        selectedRestCount(player.name, blockNumber <= game.totalBlocks / 2);
      const sortRestCandidates = (
        candidates: Array<{ block: number; candidateIndex: number }>,
        ideal: number,
      ): Array<{ block: number; candidateIndex: number }> => candidates.sort((left, right) =>
        halfRestOrder(left.block) - halfRestOrder(right.block)
        || coreBenchesIfRested(player, left.block) - coreBenchesIfRested(player, right.block)
        || groupRestPressure(player, group, left.block) - groupRestPressure(player, group, right.block)
        || Math.abs(left.candidateIndex - ideal) - Math.abs(right.candidateIndex - ideal)
        || left.block - right.block);
      for (let index = 1; index <= restCount; index += 1) {
        const ideal = Math.round(index * (eligible.length + 1) / (restCount + 1)) - 1;
        const candidates = sortRestCandidates(eligible
          .map((block, candidateIndex) => ({ block, candidateIndex }))
          .filter(({ block }) => !selected.has(block) && !sequentialRestBlocks.get(group)!.has(block)), ideal);
        const fallback = candidates[0] ?? sortRestCandidates(eligible
          .map((block, candidateIndex) => ({ block, candidateIndex }))
          .filter(({ block }) => !selected.has(block)), ideal)[0];
        const choice = fallback?.block;
        if (choice === undefined) continue;
        selected.add(choice);
        for (const coveredGroup of (['D', 'M', 'F'] as const).filter((candidate) => player.generalPositions.includes(candidate))) {
          sequentialRestBlocks.get(coveredGroup)!.add(choice);
          const key = `${coveredGroup}:${choice}`;
          groupRestsPerBlock.set(key, (groupRestsPerBlock.get(key) ?? 0) + 1);
        }
        const playerRest = rest.get(player.name) ?? new Set<number>();
        const selectedRests = selectedRestBlocks.get(player.name) ?? new Set<number>();
        playerRest.add(choice);
        selectedRests.add(choice);
        rest.set(player.name, playerRest);
        selectedRestBlocks.set(player.name, selectedRests);
      }
    }
    const totalRemaining = (useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0;
    const groupRemaining = remainingGroupTarget.get(player.name)?.get(group);
    if (groupRemaining === 0 || totalRemaining === 0) return [];
    return blocks
      .filter((block) => !frozenBlocks.has(block.block)
        && !pinned.get(block.block)?.has(player.name)
        && !isKeeperHalf(game, player, block.block)
        && player.available
        && !assignmentsHasPlayer(block.assignments, player.name)
        && (softRest || !rest.get(player.name)?.has(block.block))
        && demand.fieldSlots.some((slot) => slot.group === group
          && !block.assignments.has(slot.slot)
          && isFieldEligible(game, player, block.block, slot.slot)))
      .map((block) => block.block);
  };
  for (const quota of quotas.quotas) {
    const player = players.get(quota.player);
    if (!player) continue;
    for (const group of ['D', 'M', 'F'] as const) {
      if (player.generalPositions.includes(group) || !hasBackupForGroup(player, group)) continue;
      const frozenBlocks = new Set(frozen.map((block) => block.block));
      const selectedBlocks = new Set<number>();
      const currentBlocks = () => blocks
        .filter((block) => assignmentsHasPlayer(block.assignments, player.name))
        .map((block) => block.block);
      while ((remainingGroupTarget.get(player.name)?.get(group) ?? 0) > 0) {
        const occupiedBlocks = [...currentBlocks(), ...selectedBlocks];
        const candidates = blocks.filter((block) => !frozenBlocks.has(block.block)
          && !selectedBlocks.has(block.block)
          && !pinned.get(block.block)?.has(player.name)
          && !isKeeperHalf(game, player, block.block)
          && !rest.get(player.name)?.has(block.block)
          && player.available
          && !assignmentsHasPlayer(block.assignments, player.name)
          && demand.fieldSlots.some((slot) => slot.group === group
            && !block.assignments.has(slot.slot)
            && canPlace(player, block.block, slot.slot)))
          .sort((left, right) => {
            const distance = (block: number) => occupiedBlocks.length
              ? Math.min(...occupiedBlocks.map((occupied) => Math.abs(block - occupied)))
              : 0;
            return distance(right.block) - distance(left.block)
              || Math.abs(left.block - (game.totalBlocks + 1) / 2) - Math.abs(right.block - (game.totalBlocks + 1) / 2)
              || left.block - right.block;
          });
        const next = candidates[0];
        if (!next) break;
        const blockNumber = next.block;
        if ((remainingGroupTarget.get(player.name)?.get(group) ?? 0) <= 0) break;
        const slots = demand.fieldSlots
          .filter((slot) => slot.group === group && !blocks[blockNumber - 1].assignments.has(slot.slot))
          .sort((left, right) => slotPriority(player, right.slot) - slotPriority(player, left.slot));
        const slot = slots.find((candidate) => canPlace(player, blockNumber, candidate.slot));
        if (!slot || !assign(player, blockNumber, slot.slot)) break;
        selectedBlocks.add(blockNumber);
      }
    }
  }
  for (const useTarget of [false, true]) {
    for (const group of order) {
      const candidates = game.players
        .filter((player) => ((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) > 0
          && ((remainingGroupTarget.get(player.name)?.get(group) ?? 1) > 0)
          && (player.generalPositions.includes(group)
            || hasBackupForGroup(player, group)
            || (group === 'D' && (player.name === game.firstHalfKeeper || player.name === game.secondHalfKeeper))))
        .sort((left, right) => Number(right.name === game.firstHalfKeeper || right.name === game.secondHalfKeeper)
          - Number(left.name === game.firstHalfKeeper || left.name === game.secondHalfKeeper)
          || placementPriority(left, group) - placementPriority(right, group)
          || left.name.localeCompare(right.name));
      for (const player of candidates) {
        const playBlocks = selectSpacedBlocks(player, group, useTarget);
        for (const blockNumber of playBlocks) {
          if (((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) <= 0
            || (remainingGroupTarget.get(player.name)?.get(group) ?? 1) <= 0) break;
          const slots = demand.fieldSlots.filter((slot) => slot.group === group && !blocks[blockNumber - 1].assignments.has(slot.slot))
            .sort((left, right) => slotPriority(player, right.slot) - slotPriority(player, left.slot));
          const slot = slots.find((candidate) => canPlace(player, blockNumber, candidate.slot));
          if (slot) assign(player, blockNumber, slot.slot);
        }
        if (((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) > 0
          && (remainingGroupTarget.get(player.name)?.get(group) ?? 1) > 0) {
          for (const block of blocks) {
            if (((useTarget ? state.remainingTarget : state.remainingMin).get(player.name) ?? 0) <= 0
              || (remainingGroupTarget.get(player.name)?.get(group) ?? 1) <= 0) break;
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
        .filter((player) => (player.generalPositions.includes(groupForSlot(slot.slot))
          || hasBackupForGroup(player, groupForSlot(slot.slot)))
          && (remainingGroupTarget.get(player.name)?.get(groupForSlot(slot.slot)) ?? 0) > 0
          && canPlace(player, block.block, slot.slot, { ignoreMaximum: true }))
        .sort((left, right) => (state.remainingMin.get(right.name) ?? 0) - (state.remainingMin.get(left.name) ?? 0)
          || (state.placed!.get(left.name) ?? 0) - (state.placed!.get(right.name) ?? 0)
          || groupAffinity(right, slot.slot) - groupAffinity(left, slot.slot)
          || slotPriority(right, slot.slot) - slotPriority(left, slot.slot)
          || left.name.localeCompare(right.name))[0];
      if (relaxedCandidate) {
        assign(relaxedCandidate, block.block, slot.slot, { ignoreMaximum: true });
        continue;
      }
      const lastResortCandidates = game.players
        .filter((player) => (player.generalPositions.includes(groupForSlot(slot.slot))
          || hasBackupForGroup(player, groupForSlot(slot.slot)))
          && canPlace(player, block.block, slot.slot, { ignoreMaximum: true, ignoreSelectedRest: true }));
      const group = groupForSlot(slot.slot);
      const primaryCandidates = lastResortCandidates.filter((player) => player.generalPositions.includes(group));
      const lastResortCandidate = (primaryCandidates.length ? primaryCandidates : lastResortCandidates
        .filter((player) => hasBackupForGroup(player, group) && !player.generalPositions.includes(group)))
        .sort((left, right) => Number((state.remainingMax.get(right.name) ?? 0) > 0) - Number((state.remainingMax.get(left.name) ?? 0) > 0)
          || (state.remainingMin.get(right.name) ?? 0) - (state.remainingMin.get(left.name) ?? 0)
          || (state.placed!.get(left.name) ?? 0) - (state.placed!.get(right.name) ?? 0)
          || groupAffinity(right, slot.slot) - groupAffinity(left, slot.slot)
          || slotPriority(right, slot.slot) - slotPriority(left, slot.slot)
          || left.name.localeCompare(right.name))[0];
      if (lastResortCandidate) {
        assign(lastResortCandidate, block.block, slot.slot, { ignoreMaximum: true, ignoreSelectedRest: true });
        continue;
      }
    }
  }
  const plannedPinCount = (playerName: string, group: 'D' | 'M' | 'F'): number => {
    const quota = quotas.quotas.find((candidate) => candidate.player === playerName);
    const player = players.get(playerName);
    if (!quota) return 0;
    const pinnedBlocks = new Set(quota.pinnedBlocks);
    for (const pin of game.pins.filter((candidate) => candidate.player === playerName && candidate.slot !== 'GK')) {
      pinnedBlocks.add(pin.block);
    }
    return [...pinnedBlocks].filter((block) => {
      const explicitPin = game.pins.find((pin) => pin.player === playerName && pin.block === block);
      const pinGroup = explicitPin
        ? groupForSlot(explicitPin.slot)
        : player?.generalPositions.find((position) => ['D', 'M', 'F'].includes(position));
      return pinGroup === group;
    }).length;
  };
  if (quotas.audit.relaxedMaximums?.length) {
    const quotaByPlayer = new Map(quotas.quotas.map((quota) => [quota.player, quota]));
    const frozenBlocks = new Set(frozen.map((block) => block.block));
    const nonKeeperLimit = game.totalBlocks - 1;
    const seenAssignmentStates = new Set<string>();
    let moved = true;
    while (moved) {
      const assignmentState = JSON.stringify(blocks.map((block) => [
        block.block,
        [...block.assignments].sort(([left], [right]) => left.localeCompare(right)),
      ]));
      if (seenAssignmentStates.has(assignmentState)) break;
      seenAssignmentStates.add(assignmentState);
      moved = false;
      const nonKeepers = game.players
        .filter((player) => player.available && (quotaByPlayer.get(player.name)?.keeperBlocks ?? 0) === 0)
        .map((player) => ({ player, count: state.placed!.get(player.name) ?? 0 }))
        .sort((left, right) => right.count - left.count || left.player.name.localeCompare(right.player.name));
      const lowestCount = nonKeepers[nonKeepers.length - 1]?.count ?? 0;
      for (const source of nonKeepers) {
        const sourceQuota = quotaByPlayer.get(source.player.name);
        const needsBalancing = source.count > nonKeeperLimit || source.count - lowestCount > 2;
        if (!sourceQuota || !needsBalancing
          || source.count <= sourceQuota.fieldMin + sourceQuota.pinnedBlocks.length) continue;
        const recipients = [...nonKeepers]
          .filter((candidate) => candidate.player.name !== source.player.name
            && candidate.count < nonKeeperLimit)
          .sort((left, right) => left.count - right.count || left.player.name.localeCompare(right.player.name));
        for (const recipient of recipients) {
          for (const block of blocks) {
            if (frozenBlocks.has(block.block)
              || pinned.get(block.block)?.has(source.player.name)
              || pinned.get(block.block)?.has(recipient.player.name)
              || (!softRest && rest.get(recipient.player.name)?.has(block.block))
              || assignmentsHasPlayer(block.assignments, recipient.player.name)
              || isKeeperHalf(game, recipient.player, block.block)) continue;
            const slot = [...block.assignments].find(([, player]) => player === source.player.name)?.[0];
            if (!slot || !isFieldEligible(game, recipient.player, block.block, slot)) continue;
            const group = groupForSlot(slot);
            const sourcePlan = (quotaByPlayer.get(source.player.name)?.groupTargets?.[group] ?? 0)
              + plannedPinCount(source.player.name, group);
            const recipientPlan = (quotaByPlayer.get(recipient.player.name)?.groupTargets?.[group] ?? 0)
              + plannedPinCount(recipient.player.name, group);
            const sourceGroupCount = blocks.filter((candidateBlock) => [...candidateBlock.assignments]
              .some(([candidateSlot, player]) => player === source.player.name && groupForSlot(candidateSlot) === group)).length;
            const recipientGroupCount = blocks.filter((candidateBlock) => [...candidateBlock.assignments]
              .some(([candidateSlot, player]) => player === recipient.player.name && groupForSlot(candidateSlot) === group)).length;
            if (sourceGroupCount <= sourcePlan || recipientGroupCount >= recipientPlan) continue;
            block.assignments.set(slot, recipient.player.name);
            state.placed!.set(source.player.name, source.count - 1);
            state.placed!.set(recipient.player.name, recipient.count + 1);
            moved = true;
            break;
          }
          if (moved) break;
        }
        if (moved) break;
      }
    }
  }
  const relocateWithinGroup = (player: NormalizedPlayer, occupiedBlock: number): boolean => {
    const occupiedAssignments = blocks[occupiedBlock - 1].assignments;
    const occupiedEntry = [...occupiedAssignments].find(([, name]) => name === player.name);
    if (!occupiedEntry || pinned.get(occupiedBlock)?.has(player.name)) return !occupiedEntry;
    const [occupiedSlot] = occupiedEntry;
    const group = groupForSlot(occupiedSlot);
    for (const destinationBlock of blocks) {
      if (destinationBlock.block === occupiedBlock
        || frozen.some((frozenBlock) => frozenBlock.block === destinationBlock.block)
        || assignmentsHasPlayer(destinationBlock.assignments, player.name)
        || restPinBlocks.get(player.name)?.has(destinationBlock.block)
        || (!softRest && rest.get(player.name)?.has(destinationBlock.block))) continue;
      for (const [destinationSlot, displacedName] of destinationBlock.assignments) {
        if (groupForSlot(destinationSlot) !== group
          || pinned.get(destinationBlock.block)?.has(displacedName)) continue;
        const displaced = players.get(displacedName);
        if (!displaced
          || assignmentsHasPlayer(occupiedAssignments, displacedName)
          || !isFieldEligible(game, player, destinationBlock.block, destinationSlot)
          || !isFieldEligible(game, displaced, occupiedBlock, occupiedSlot)
          || isKeeperHalf(game, player, destinationBlock.block)
          || isKeeperHalf(game, displaced, occupiedBlock)) continue;
        occupiedAssignments.set(occupiedSlot, displacedName);
        destinationBlock.assignments.set(destinationSlot, player.name);
        return true;
      }
    }
    return false;
  };
  for (const group of ['D', 'M', 'F'] as const) {
    let changed = true;
    while (changed) {
      changed = false;
      const countInGroup = (playerName: string) => blocks.reduce((total, block) => total
        + [...block.assignments].filter(([slot, name]) => name === playerName && groupForSlot(slot) === group).length, 0);
      const plannedInGroup = (playerName: string) =>
        (quotas.quotas.find((quota) => quota.player === playerName)?.groupTargets?.[group] ?? 0)
        + plannedPinCount(playerName, group);
      const overTargetPlayers = game.players
        .filter((player) => countInGroup(player.name) > plannedInGroup(player.name))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const source of overTargetPlayers) {
        for (const block of blocks) {
          if (frozen.some((frozenBlock) => frozenBlock.block === block.block)
            || pinned.get(block.block)?.has(source.name)) continue;
          const slot = [...block.assignments].find(([position, name]) =>
            name === source.name && groupForSlot(position) === group)?.[0];
          if (!slot) continue;
          const recipients = game.players
            .filter((player) => countInGroup(player.name) < plannedInGroup(player.name)
              && !pinned.get(block.block)?.has(player.name)
              && !restPinBlocks.get(player.name)?.has(block.block))
            .sort((left, right) => (remainingGroupTarget.get(right.name)?.get(group) ?? 0)
              - (remainingGroupTarget.get(left.name)?.get(group) ?? 0)
              || left.name.localeCompare(right.name));
          const recipient = recipients.find((candidate) =>
            relocateWithinGroup(candidate, block.block)
            && canPlace(candidate, block.block, slot, { ignoreMaximum: true, ignoreSelectedRest: true }));
          if (!recipient) continue;
          block.assignments.set(slot, recipient.name);
          state.placed!.set(source.name, (state.placed!.get(source.name) ?? 0) - 1);
          state.placed!.set(recipient.name, (state.placed!.get(recipient.name) ?? 0) + 1);
          state.remainingMin.set(source.name, (state.remainingMin.get(source.name) ?? 0) + 1);
          state.remainingMin.set(recipient.name, Math.max(0, (state.remainingMin.get(recipient.name) ?? 0) - 1));
          state.remainingTarget.set(source.name, (state.remainingTarget.get(source.name) ?? 0) + 1);
          state.remainingTarget.set(recipient.name, Math.max(0, (state.remainingTarget.get(recipient.name) ?? 0) - 1));
          state.remainingMax.set(source.name, (state.remainingMax.get(source.name) ?? 0) + 1);
          state.remainingMax.set(recipient.name, (state.remainingMax.get(recipient.name) ?? 0) - 1);
          remainingGroupTarget.get(source.name)?.set(group, (remainingGroupTarget.get(source.name)?.get(group) ?? 0) + 1);
          remainingGroupTarget.get(recipient.name)?.set(group, Math.max(0, (remainingGroupTarget.get(recipient.name)?.get(group) ?? 0) - 1));
          changed = true;
          break;
        }
        if (changed) break;
      }
    }
  }
  const unfilledSlots = blocks.flatMap((block) => demand.fieldSlots
    .filter((slot) => !block.assignments.has(slot.slot))
    .map((slot) => ({ block: block.block, slot: slot.slot })));
  const minimumErrors = [...state.remainingMin.entries()]
    .filter(([, remaining]) => remaining > 0)
    .map(([player, remaining]) => `Cannot place minimum for ${player}: ${remaining} block(s) remain.`);
  const slotErrors = unfilledSlots.map(({ block, slot }) => `Unfilled slot: Block ${block}, slot ${slot}.`);
  const errors = [...minimumErrors, ...slotErrors];
  const plannedVsPlaced = quotas.quotas.flatMap((quota) => {
    return (['D', 'M', 'F'] as const).map((group) => {
      const planned = (quota.groupTargets?.[group] ?? 0) + plannedPinCount(quota.player, group);
      const placed = blocks.reduce((total, block) => total
        + [...block.assignments].filter(([slot, assignedPlayer]) =>
          assignedPlayer === quota.player && groupForSlot(slot) === group).length, 0);
      return { player: quota.player, group, planned, placed, difference: placed - planned };
    });
  });
  const unplannedBackupUses = plannedVsPlaced.flatMap(({ player, group, planned, placed }) => {
    const candidate = players.get(player);
    return candidate && !candidate.generalPositions.includes(group) && hasBackupForGroup(candidate, group) && placed > planned
      ? [{ player, group, blocks: placed - planned }]
      : [];
  });
  return {
    blocks,
    complete: unfilledSlots.length === 0,
    audit: {
      restPins,
      softRestFallback: softRest,
      outOfPositionBlocks: {},
      errors,
      plannedVsPlaced,
      unplannedBackupUses,
      failureReason: unfilledSlots.length
        ? 'no-eligible-player'
        : minimumErrors.length
          ? 'minimum-window-exhausted'
          : undefined,
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
): PlacementResult {
  return placeDeterministically(game, demand, quotas, frozen, softRest);
}
