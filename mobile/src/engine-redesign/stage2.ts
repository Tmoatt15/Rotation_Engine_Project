import type {
  DemandModel,
  FieldGroup,
  NormalizedGame,
  NormalizedPlayer,
  PlayerQuota,
  QuotaAssignment,
  RedesignGroup,
  WaterfillRotationState,
} from './model';
import { isDedicatedKeeper } from '@/position-groups';

const BANDS: Record<RedesignGroup, { min: number; max: number; midpoint: number }> = {
  core: { min: 0.7, max: 0.8, midpoint: 0.75 },
  rotational: { min: 0.6, max: 0.7, midpoint: 0.65 },
  developing: { min: 0.5, max: 0.6, midpoint: 0.55 },
};

function percentageBlocks(totalBlocks: number, percentage: number, minimum: number): number {
  return Math.max(minimum, Math.min(totalBlocks, Math.round(totalBlocks * percentage)));
}

function maximumBlocks(totalBlocks: number, percentage: number): number {
  return Math.max(1, Math.min(totalBlocks, Math.round(totalBlocks * percentage)));
}

function keeperFieldTarget(totalBlocks: number): number {
  return Math.max(0, totalBlocks / 2 - 1);
}

function keeperFieldFloor(totalBlocks: number): number {
  return Math.min(keeperFieldTarget(totalBlocks), Math.ceil(totalBlocks * 0.3));
}

function nonKeeperFieldFloor(totalBlocks: number): number {
  return Math.ceil(totalBlocks * 0.4);
}

function keeperBlocks(game: NormalizedGame, player: NormalizedPlayer, demand: DemandModel): number {
  return demand.goalkeeperRequired && (player.name === game.firstHalfKeeper || player.name === game.secondHalfKeeper)
    ? demand.goalkeeperBlocks.filter((blocks, half) => (half === 0 ? game.firstHalfKeeper : game.secondHalfKeeper) === player.name).reduce((sum, blocks) => sum + blocks, 0)
    : 0;
}

function isHalfKeeper(game: NormalizedGame, player: NormalizedPlayer, demand: DemandModel): boolean {
  const blocks = keeperBlocks(game, player, demand);
  return blocks > 0 && blocks < game.totalBlocks;
}

function maximumFieldBlocks(game: NormalizedGame, player: NormalizedPlayer, demand: DemandModel): number {
  const available = game.totalBlocks - keeperBlocks(game, player, demand);
  return isHalfKeeper(game, player, demand)
    ? Math.min(available, keeperFieldTarget(game.totalBlocks))
    : available;
}

function endpointPins(game: NormalizedGame, player: NormalizedPlayer): number[] {
  if (player.group !== 'core' || !player.available) return [];
  const blockOnePin = game.pins.some((pin) => pin.block === 1 && pin.player === player.name);
  const late = game.lateArrival?.player === player.name;
  const pins = late || (!blockOnePin && game.pins.length > 0) ? [game.totalBlocks] : [1, game.totalBlocks];
  const half = game.totalBlocks / 2;
  return pins.filter((block) => !((player.name === game.firstHalfKeeper && block <= half)
    || (player.name === game.secondHalfKeeper && block > half)));
}

type FieldAllocation = Map<string, Map<FieldGroup, number>>;
type RotationAction = 'lastShed' | 'lastGained';

interface WaterfillPlayer {
  player: NormalizedPlayer;
  primaryGroup: FieldGroup | null;
  keeperBlocks: number;
  selectedKeeper: boolean;
  hardFloor: number;
  floor: number;
  bandFloor: number;
  bandMaximum: number;
  maximum: number;
  pinnedBlocks: number[];
  pinnedByGroup: Record<FieldGroup, number>;
}

const FIELD_GROUPS: FieldGroup[] = ['D', 'M', 'F'];
const SHED_TIERS: RedesignGroup[] = ['developing', 'rotational'];
const HIT_TIERS: RedesignGroup[] = ['developing', 'rotational', 'core'];
const SURPLUS_TIERS: RedesignGroup[] = ['core', 'rotational', 'developing'];
const FLEX_OUT_TIERS: RedesignGroup[] = ['rotational', 'developing', 'core'];
const FLEX_IN_TIERS: RedesignGroup[] = ['core', 'rotational', 'developing'];
const RELAXED_EQUALIZATION_ITERATION_CAP = 10_000;

function groupForPosition(position: string): FieldGroup | null {
  const normalized = position.toUpperCase();
  if (['D', 'LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(normalized)) return 'D';
  if (['M', 'LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM', 'LDM', 'RDM'].includes(normalized)) return 'M';
  if (['F', 'LF', 'CF', 'RF', 'LW', 'RW', 'ST'].includes(normalized)) return 'F';
  return null;
}

function primaryGroup(player: NormalizedPlayer): FieldGroup | null {
  const groups = [...new Set(player.generalPositions.map(groupForPosition).filter((group): group is FieldGroup => group !== null))];
  return groups.length === 1 ? groups[0] : null;
}

function backupGroups(player: NormalizedPlayer): FieldGroup[] {
  return [...new Set(player.backupPositions.map(groupForPosition).filter((group): group is FieldGroup => group !== null))];
}

function rotationKey(group: FieldGroup, tier: RedesignGroup): `${FieldGroup}:${RedesignGroup}` {
  return `${group}:${tier}`;
}

function rotatedPlayers(
  candidates: WaterfillPlayer[],
  rotation: WaterfillRotationState,
  group: FieldGroup,
  tier: RedesignGroup,
  action: RotationAction,
): WaterfillPlayer[] {
  const sorted = [...candidates].sort((left, right) => left.player.name.localeCompare(right.player.name));
  const last = rotation[rotationKey(group, tier)]?.[action];
  const index = sorted.findIndex((candidate) => candidate.player.name === last);
  return index < 0 ? sorted : [...sorted.slice(index + 1), ...sorted.slice(0, index + 1)];
}

function writeRotation(
  rotation: WaterfillRotationState,
  group: FieldGroup,
  tier: RedesignGroup,
  action: RotationAction,
  player: string,
): void {
  const key = rotationKey(group, tier);
  rotation[key] = { ...rotation[key], [action]: player };
}

function allocationTotal(allocation: Map<FieldGroup, number> | undefined): number {
  return allocation ? [...allocation.values()].reduce((sum, value) => sum + value, 0) : 0;
}

function cloneRotation(source: WaterfillRotationState): WaterfillRotationState {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, { ...value }]));
}

function groupPositionNames(demand: DemandModel, group: FieldGroup): string[] {
  return [...new Set(demand.fieldSlots.filter((slot) => slot.group === group).map((slot) => slot.slot))];
}

function pinnedBlocksByGroup(
  game: NormalizedGame,
  player: NormalizedPlayer,
  primary: FieldGroup | null,
): { blocks: number[]; counts: Record<FieldGroup, number> } {
  const pins = new Map<number, FieldGroup>();
  for (const block of endpointPins(game, player)) {
    if (primary) pins.set(block, primary);
  }
  for (const pin of game.pins.filter((entry) => entry.player === player.name)) {
    const group = groupForPosition(pin.slot);
    if (group) pins.set(pin.block, group);
  }
  const counts: Record<FieldGroup, number> = { D: 0, M: 0, F: 0 };
  for (const group of pins.values()) counts[group] += 1;
  return { blocks: [...pins.keys()].sort((left, right) => left - right), counts };
}

function buildWaterfillQuotaAttempt(
  game: NormalizedGame,
  demand: DemandModel,
  floorOverrides: ReadonlyMap<string, number>,
  allowRelaxedMaximums: boolean,
): QuotaAssignment {
  const available = game.players.filter((player) => player.available);
  const fieldPlayers = available.filter((player) => !isDedicatedKeeper(player.keeper, player.generalPositions));
  const info = new Map<string, WaterfillPlayer>();
  const allocations: FieldAllocation = new Map();
  let rotationState = cloneRotation(game.seasonRotation ?? {});
  const relaxedPlayers: { player: string; group: RedesignGroup; before: number; after: number; belowHardFloor: boolean }[] = [];
  const surplusAssignments: QuotaAssignment['audit']['surplusAssignments'] = [];
  const underfill: QuotaAssignment['audit']['underfill'] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const overages: QuotaAssignment['audit']['overage'] = [];
  let relaxedEqualization: QuotaAssignment['audit']['relaxedEqualization'];
  let rosterTooLarge: QuotaAssignment['audit']['rosterTooLarge'];

  for (const player of fieldPlayers) {
    const group = primaryGroup(player);
    const keeper = keeperBlocks(game, player, demand);
    const keeperFieldMax = maximumFieldBlocks(game, player, demand);
    const keeperFloor = Math.min(keeperFieldMax, keeperFieldFloor(game.totalBlocks));
    const isSelectedKeeper = keeper > 0;
    const lateArrival = game.lateArrival?.player === player.name ? game.lateArrival : undefined;
    const lateTarget = lateArrival
      ? lateArrival.targetBlocks ?? Math.round(BANDS[player.group].midpoint * (game.totalBlocks - lateArrival.arrivalBlock + 1))
      : undefined;
    const pinData = pinnedBlocksByGroup(game, player, group);
    const bandFloor = lateTarget ?? (isSelectedKeeper
      ? player.group === 'rotational' ? keeperFloor : keeperFieldMax
      : percentageBlocks(game.totalBlocks, BANDS[player.group].min, 0));
    const hardFloor = Math.max(pinData.blocks.length, lateTarget
      ?? (isSelectedKeeper ? keeperFloor : nonKeeperFieldFloor(game.totalBlocks)));
    const floor = Math.max(pinData.blocks.length, Math.min(hardFloor, floorOverrides.get(player.name) ?? hardFloor));
    const start = Math.max(pinData.blocks.length, lateTarget ?? (isSelectedKeeper
      ? keeperFieldMax
      : percentageBlocks(game.totalBlocks, BANDS[player.group].min, 0)));
    const bandMaximum = Math.max(start, lateTarget ?? (isSelectedKeeper
      ? keeperFieldMax
      : maximumBlocks(game.totalBlocks, BANDS[player.group].max)));
    const maximum = allowRelaxedMaximums
      ? Math.max(start, maximumFieldBlocks(game, player, demand))
      : bandMaximum;
    info.set(player.name, {
      player,
      primaryGroup: group,
      keeperBlocks: keeper,
      selectedKeeper: isSelectedKeeper,
      hardFloor,
      floor,
      bandFloor: Math.max(pinData.blocks.length, bandFloor),
      bandMaximum,
      maximum,
      pinnedBlocks: pinData.blocks,
      pinnedByGroup: pinData.counts,
    });
    const counts = new Map(FIELD_GROUPS.map((fieldGroup) => [fieldGroup, pinData.counts[fieldGroup]]));
    const unpinnedStart = start - pinData.blocks.length;
    const startGroup = group ?? FIELD_GROUPS.find((fieldGroup) => pinData.counts[fieldGroup] > 0);
    if (startGroup && unpinnedStart > 0) {
      counts.set(startGroup, (counts.get(startGroup) ?? 0) + unpinnedStart);
    }
    allocations.set(player.name, counts);
  }

  const slots = new Map(FIELD_GROUPS.map((group) => [
    group,
    demand.fieldSlots.filter((slot) => slot.group === group).length * game.totalBlocks,
  ]));
  const minimumFieldBlocks = [...info.values()].reduce((sum, candidate) => sum + candidate.floor, 0);
  const totalFieldSlots = FIELD_GROUPS.reduce((sum, group) => sum + (slots.get(group) ?? 0), 0);
  const maximumCapacityShortfall = Math.max(0, totalFieldSlots
    - [...info.values()].reduce((sum, candidate) => sum + candidate.bandMaximum, 0));
  if (minimumFieldBlocks > totalFieldSlots) {
    const maximumPlayers = Math.floor(totalFieldSlots / nonKeeperFieldFloor(game.totalBlocks));
    rosterTooLarge = { maxPlayers: maximumPlayers };
    errors.push(`Roster too large for 40% minimum playing time. Maximum ${maximumPlayers} field players for ${game.totalBlocks} blocks.`);
  }
  const groupLoad = (group: FieldGroup): number => [...allocations.values()]
    .reduce((sum, count) => sum + (count.get(group) ?? 0), 0);
  const playerTotal = (name: string): number => allocationTotal(allocations.get(name));
  const groupMembers = (group: FieldGroup): WaterfillPlayer[] => [...info.values()]
    .filter((candidate) => candidate.primaryGroup === group);
  const allocationMembers = (group: FieldGroup): WaterfillPlayer[] => [...info.values()]
    .filter((candidate) => amountInGroup(candidate.player.name, group) > 0);
  const amountInGroup = (name: string, group: FieldGroup): number => allocations.get(name)?.get(group) ?? 0;

  const isGuardrailExempt = (candidate: WaterfillPlayer): boolean => candidate.selectedKeeper
    || game.lateArrival?.player === candidate.player.name
    || game.pins.some((pin) => pin.player === candidate.player.name);
  const guardrailAllows = (candidate: WaterfillPlayer, nextTotal: number): boolean => {
    if (isGuardrailExempt(candidate)) return true;
    const totals = [...info.values()]
      .filter((member) => !isGuardrailExempt(member))
      .map((member) => ({
        tier: member.player.group,
        total: member.player.name === candidate.player.name ? nextTotal : playerTotal(member.player.name),
      }));
    const core = totals.filter((entry) => entry.tier === 'core').map((entry) => entry.total);
    const rotational = totals.filter((entry) => entry.tier === 'rotational').map((entry) => entry.total);
    const developing = totals.filter((entry) => entry.tier === 'developing').map((entry) => entry.total);
    return (!core.length || !rotational.length || Math.min(...core) >= Math.max(...rotational))
      && (!rotational.length || !developing.length || Math.min(...rotational) >= Math.max(...developing));
  };
  const noteGuardrailRelaxation = (group: FieldGroup, action: string): void => {
    const warning = `${group} group ${action} proceeded after the soft tier guardrail blocked all valid candidates.`;
    if (!warnings.includes(warning)) warnings.push(warning);
  };
  const shedOne = (
    candidate: WaterfillPlayer,
    group: FieldGroup,
    floor: number,
  ): boolean => {
    const amount = amountInGroup(candidate.player.name, group);
    if (amount <= (candidate.pinnedByGroup[group] ?? 0) || playerTotal(candidate.player.name) <= floor) return false;
    allocations.get(candidate.player.name)!.set(group, amount - 1);
    writeRotation(rotationState, group, candidate.player.group, 'lastShed', candidate.player.name);
    return true;
  };
  const shedBandToFloor = (group: FieldGroup): boolean => {
    let changed = false;
    for (const tier of SHED_TIERS) {
      while (groupLoad(group) > (slots.get(group) ?? 0)) {
        const tierMembers = allocationMembers(group).filter((candidate) => candidate.player.group === tier);
        const nonKeepers = tierMembers.filter((candidate) => !candidate.selectedKeeper
          && playerTotal(candidate.player.name) > candidate.bandFloor
          && amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0));
        const rotationalKeepers = tier === 'rotational'
          ? tierMembers.filter((candidate) => candidate.selectedKeeper
            && playerTotal(candidate.player.name) > candidate.bandFloor
            && amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0))
          : [];
        const candidates = rotatedPlayers(
          nonKeepers.length ? nonKeepers : rotationalKeepers,
          rotationState,
          group,
          tier,
          'lastShed',
        );
        const next = candidates[0];
        if (!next || !shedOne(next, group, next.bandFloor)) break;
        changed = true;
      }
      if (groupLoad(group) <= (slots.get(group) ?? 0)) break;
    }
    return changed;
  };
  const transfer = (candidate: WaterfillPlayer, from: FieldGroup, to: FieldGroup): boolean => {
    const counts = allocations.get(candidate.player.name);
    if (!counts || candidate.selectedKeeper
      || (counts.get(from) ?? 0) <= (candidate.pinnedByGroup[from] ?? 0)) return false;
    counts.set(from, (counts.get(from) ?? 0) - 1);
    counts.set(to, (counts.get(to) ?? 0) + 1);
    writeRotation(rotationState, from, candidate.player.group, 'lastShed', candidate.player.name);
    writeRotation(rotationState, to, candidate.player.group, 'lastGained', candidate.player.name);
    return true;
  };
  const tryFlexMove = (candidate: WaterfillPlayer, from: FieldGroup, to: FieldGroup): boolean => {
    if (!transfer(candidate, from, to)) return false;
    while (groupLoad(to) > (slots.get(to) ?? 0)) {
      if (!shedBandToFloor(to)) break;
    }
    return true;
  };
  const flexOut = (group: FieldGroup): void => {
    for (const tier of FLEX_OUT_TIERS) {
      while (groupLoad(group) > (slots.get(group) ?? 0)) {
        const candidates = rotatedPlayers(
          allocationMembers(group).filter((candidate) => candidate.player.group === tier
            && !candidate.selectedKeeper
            && amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0)
            && backupGroups(candidate.player).some((backup) => backup !== group)),
          rotationState,
          group,
          tier,
          'lastShed',
        );
        let movedThisRound = false;
        for (const candidate of candidates) {
          if (groupLoad(group) <= (slots.get(group) ?? 0)) break;
          const destinations = backupGroups(candidate.player)
            .filter((backup) => backup !== group)
            .sort((left, right) => (slots.get(right)! - groupLoad(right)) - (slots.get(left)! - groupLoad(left))
              || FIELD_GROUPS.indexOf(left) - FIELD_GROUPS.indexOf(right));
          for (const destination of destinations) {
            if (tryFlexMove(candidate, group, destination)) {
              movedThisRound = true;
              break;
            }
          }
        }
        if (!movedThisRound) break;
      }
      if (groupLoad(group) <= (slots.get(group) ?? 0)) break;
    }
  };

  for (const group of FIELD_GROUPS) shedBandToFloor(group);
  for (const group of FIELD_GROUPS) flexOut(group);

  for (const group of FIELD_GROUPS) {
    while (groupLoad(group) > (slots.get(group) ?? 0)) {
      const candidates = rotatedPlayers(
        allocationMembers(group).filter((candidate) => candidate.selectedKeeper
          && candidate.player.group === 'rotational'
          && playerTotal(candidate.player.name) > candidate.floor
          && amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0)),
        rotationState,
        group,
        'rotational',
        'lastShed',
      );
      const next = candidates[0];
      if (!next || !shedOne(next, group, next.floor)) break;
    }
  }

  const hitOne = (candidate: WaterfillPlayer, group: FieldGroup, enforceGuardrail: boolean): boolean => {
    const name = candidate.player.name;
    if (playerTotal(name) <= candidate.floor
      || amountInGroup(name, group) <= (candidate.pinnedByGroup[group] ?? 0)
      || (enforceGuardrail && !guardrailAllows(candidate, playerTotal(name) - 1))) return false;
    const before = playerTotal(name);
    allocations.get(name)!.set(group, amountInGroup(name, group) - 1);
    writeRotation(rotationState, group, candidate.player.group, 'lastShed', name);
    relaxedPlayers.push({
      player: name,
      group: candidate.player.group,
      before,
      after: before - 1,
      belowHardFloor: before - 1 < candidate.hardFloor,
    });
    return true;
  };
  for (const group of FIELD_GROUPS) {
    while (groupLoad(group) > (slots.get(group) ?? 0)) {
      let hit = false;
      let guardrailBlocked = false;
      for (const tier of HIT_TIERS) {
        const eligible = allocationMembers(group).filter((candidate) => candidate.player.group === tier
          && !candidate.selectedKeeper
          && playerTotal(candidate.player.name) > candidate.floor
          && amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0));
        const rotationOrder = rotatedPlayers(eligible, rotationState, group, tier, 'lastShed');
        const rank = new Map(rotationOrder.map((candidate, index) => [candidate.player.name, index]));
        const candidates = [...eligible].sort((left, right) =>
          playerTotal(right.player.name) - playerTotal(left.player.name)
          || (rank.get(left.player.name) ?? 0) - (rank.get(right.player.name) ?? 0)
          || left.player.name.localeCompare(right.player.name));
        for (const candidate of candidates) {
          if (hitOne(candidate, group, true)) {
            hit = true;
            break;
          }
          if (!guardrailAllows(candidate, playerTotal(candidate.player.name) - 1)) guardrailBlocked = true;
        }
        if (hit) break;
      }
      if (!hit && guardrailBlocked) {
        noteGuardrailRelaxation(group, 'abundance hits');
        for (const tier of HIT_TIERS) {
          const candidates = rotatedPlayers(
            allocationMembers(group).filter((candidate) => candidate.player.group === tier
              && !candidate.selectedKeeper
              && playerTotal(candidate.player.name) > candidate.floor
              && amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0)),
            rotationState,
            group,
            tier,
            'lastShed',
          ).sort((left, right) => playerTotal(right.player.name) - playerTotal(left.player.name));
          const next = candidates[0];
          if (next && hitOne(next, group, false)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) break;
    }
  }

  const groupLabel = (group: FieldGroup): string => group === 'D' ? 'Defender' : group === 'M' ? 'Midfield' : 'Forward';
  for (const group of FIELD_GROUPS) {
    const overage = groupLoad(group) - (slots.get(group) ?? 0);
    if (overage <= 0) continue;
    overages.push({ group, blocks: overage });
    const member = allocationMembers(group).find((candidate) =>
      amountInGroup(candidate.player.name, group) > (candidate.pinnedByGroup[group] ?? 0))
      ?? allocationMembers(group)[0];
    const destination = member
      ? backupGroups(member.player).find((backup) => backup !== group)
        ?? FIELD_GROUPS.find((candidate) => candidate !== group)
      : FIELD_GROUPS.find((candidate) => candidate !== group);
    const playerName = member?.player.name ?? 'an eligible player';
    errors.push(`${groupLabel(group)} group (${group}) is over by ${overage} block(s). Add ${destination ?? 'another group'} backup to ${playerName} or move ${playerName} to ${destination ?? 'another group'}.`);
  }

  const collapsedRelaxedPlayers = [...relaxedPlayers.reduce((entries, entry) => {
    const previous = entries.get(entry.player);
    entries.set(entry.player, previous
      ? { ...previous, after: entry.after }
      : { ...entry });
    return entries;
  }, new Map<string, typeof relaxedPlayers[number]>()).values()];

  const gainOne = (candidate: WaterfillPlayer, group: FieldGroup, enforceGuardrail: boolean): boolean => {
    if (groupLoad(group) >= (slots.get(group) ?? 0)
      || playerTotal(candidate.player.name) >= candidate.maximum
      || (enforceGuardrail && !guardrailAllows(candidate, playerTotal(candidate.player.name) + 1))) return false;
    allocations.get(candidate.player.name)!.set(group, amountInGroup(candidate.player.name, group) + 1);
    writeRotation(rotationState, group, candidate.player.group, 'lastGained', candidate.player.name);
    surplusAssignments.push({ group: candidate.player.group, player: candidate.player.name, amount: 1 });
    return true;
  };

  const gainFrom = (
    group: FieldGroup,
    candidates: WaterfillPlayer[],
    action: string,
  ): boolean => {
    const ordered = SURPLUS_TIERS.flatMap((tier) => rotatedPlayers(
      candidates.filter((candidate) => candidate.player.group === tier),
      rotationState,
      group,
      tier,
      'lastGained',
    ));
    let guardrailBlocked = false;
    for (const candidate of ordered) {
      if (playerTotal(candidate.player.name) >= candidate.maximum) continue;
      if (gainOne(candidate, group, true)) return true;
      if (!guardrailAllows(candidate, playerTotal(candidate.player.name) + 1)) guardrailBlocked = true;
    }
    if (guardrailBlocked) {
      noteGuardrailRelaxation(group, action);
      for (const candidate of ordered) {
        if (gainOne(candidate, group, false)) return true;
      }
    }
    return false;
  };
  const fillCandidates = (
    group: FieldGroup,
    candidates: () => WaterfillPlayer[],
    action: string,
  ): void => {
    while (groupLoad(group) < (slots.get(group) ?? 0)) {
      if (!gainFrom(group, candidates(), action)) break;
    }
  };

  const equalizeRelaxedTotals = (): NonNullable<QuotaAssignment['audit']['relaxedEqualization']> => {
    const pool = [...info.values()]
      .filter((candidate) => !candidate.selectedKeeper && game.lateArrival?.player !== candidate.player.name)
      .sort((left, right) => left.player.name.localeCompare(right.player.name));
    const tierRank: Record<RedesignGroup, number> = { core: 0, rotational: 1, developing: 2 };
    const donorTierRank: Record<RedesignGroup, number> = { developing: 0, rotational: 1, core: 2 };
    const inversionCount = (totalAdjustments: ReadonlyMap<string, number> = new Map()): number => {
      let inversions = 0;
      for (let leftIndex = 0; leftIndex < pool.length; leftIndex += 1) {
        const left = pool[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < pool.length; rightIndex += 1) {
          const right = pool[rightIndex];
          if (tierRank[left.player.group] === tierRank[right.player.group]) continue;
          const higher = tierRank[left.player.group] < tierRank[right.player.group] ? left : right;
          const lower = higher === left ? right : left;
          const higherTotal = playerTotal(higher.player.name) + (totalAdjustments.get(higher.player.name) ?? 0);
          const lowerTotal = playerTotal(lower.player.name) + (totalAdjustments.get(lower.player.name) ?? 0);
          if (higherTotal < lowerTotal) inversions += 1;
        }
      }
      return inversions;
    };
    const eligibleForGroup = (candidate: WaterfillPlayer, group: FieldGroup): boolean =>
      candidate.primaryGroup === group || backupGroups(candidate.player).includes(group);
    const tierInversionsBefore = inversionCount();

    type EqualizationEdge = { donor: WaterfillPlayer; receiver: WaterfillPlayer; group: FieldGroup };
    type EqualizationMove = { donor: WaterfillPlayer; recipient: WaterfillPlayer; path: EqualizationEdge[] };

    const findMove = (): EqualizationMove | null => {
      const recipients = pool
        .filter((candidate) => playerTotal(candidate.player.name) < candidate.maximum)
        .sort((left, right) =>
          playerTotal(left.player.name) - playerTotal(right.player.name)
          || left.player.name.localeCompare(right.player.name));
      const inversionsBefore = inversionCount();

      for (const recipient of recipients) {
        const towardRecipient = new Map<string, EqualizationEdge>();
        const reached = new Set([recipient.player.name]);
        const queue = [recipient];
        for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
          const receiver = queue[queueIndex];
          for (const donor of pool) {
            if (reached.has(donor.player.name)) continue;
            const group = FIELD_GROUPS.find((fieldGroup) =>
              amountInGroup(donor.player.name, fieldGroup) > (donor.pinnedByGroup[fieldGroup] ?? 0)
              && eligibleForGroup(receiver, fieldGroup));
            if (!group) continue;
            reached.add(donor.player.name);
            towardRecipient.set(donor.player.name, { donor, receiver, group });
            queue.push(donor);
          }
        }

        const feasible: EqualizationMove[] = [];
        for (const donor of pool) {
          if (!reached.has(donor.player.name) || donor === recipient) continue;
          const donorTotal = playerTotal(donor.player.name);
          const recipientTotal = playerTotal(recipient.player.name);
          if (donorTotal < recipientTotal + 2 || donorTotal <= donor.hardFloor) continue;
          const path: EqualizationEdge[] = [];
          let current = donor;
          while (current !== recipient) {
            const edge = towardRecipient.get(current.player.name);
            if (!edge) break;
            path.push(edge);
            current = edge.receiver;
          }
          if (current !== recipient || !path.length) continue;
          const adjustments = new Map<string, number>([
            [donor.player.name, -1],
            [recipient.player.name, 1],
          ]);
          if (inversionCount(adjustments) <= inversionsBefore) {
            feasible.push({ donor, recipient, path });
          }
        }

        if (!feasible.length) continue;
        const preferredDonors = feasible.filter((move) => move.donor.player.group !== 'core');
        const candidates = preferredDonors.length ? preferredDonors : feasible;
        candidates.sort((left, right) =>
          playerTotal(right.donor.player.name) - playerTotal(left.donor.player.name)
          || donorTierRank[left.donor.player.group] - donorTierRank[right.donor.player.group]
          || left.donor.player.name.localeCompare(right.donor.player.name));
        return candidates[0];
      }
      return null;
    };

    let iterations = 0;
    while (iterations < RELAXED_EQUALIZATION_ITERATION_CAP) {
      const move = findMove();
      if (!move) break;
      for (const edge of move.path) {
        const donorCounts = allocations.get(edge.donor.player.name)!;
        const receiverCounts = allocations.get(edge.receiver.player.name)!;
        donorCounts.set(edge.group, amountInGroup(edge.donor.player.name, edge.group) - 1);
        receiverCounts.set(edge.group, amountInGroup(edge.receiver.player.name, edge.group) + 1);
        writeRotation(rotationState, edge.group, edge.donor.player.group, 'lastShed', edge.donor.player.name);
        writeRotation(rotationState, edge.group, edge.receiver.player.group, 'lastGained', edge.receiver.player.name);
      }
      iterations += 1;
    }
    if (iterations === RELAXED_EQUALIZATION_ITERATION_CAP) {
      warnings.push('Relaxed equalization reached its iteration cap; retaining the best plan found.');
    }
    return {
      iterations,
      tierInversionsBefore,
      tierInversionsAfter: inversionCount(),
      capped: iterations === RELAXED_EQUALIZATION_ITERATION_CAP,
    };
  };

  if (allowRelaxedMaximums) {
    let iterations = 0;
    let changed = true;
    while (changed && iterations < RELAXED_EQUALIZATION_ITERATION_CAP) {
      changed = false;
      let filledSlot = true;
      while (filledSlot) {
        filledSlot = false;
        for (const group of FIELD_GROUPS) {
          const candidates = [...info.values()]
            .filter((candidate) => (candidate.primaryGroup === group || backupGroups(candidate.player).includes(group))
              && playerTotal(candidate.player.name) < candidate.maximum)
            .sort((left, right) =>
              playerTotal(left.player.name) - playerTotal(right.player.name)
              || left.player.name.localeCompare(right.player.name));
          const candidate = candidates[0];
          if (candidate && gainOne(candidate, group, false)) {
            filledSlot = true;
            changed = true;
          }
        }
      }
      const equalization = equalizeRelaxedTotals();
      relaxedEqualization = {
        iterations: (relaxedEqualization?.iterations ?? 0) + equalization.iterations,
        tierInversionsBefore: relaxedEqualization?.tierInversionsBefore ?? equalization.tierInversionsBefore,
        tierInversionsAfter: equalization.tierInversionsAfter,
        capped: Boolean(relaxedEqualization?.capped) || equalization.capped,
      };
      changed ||= equalization.iterations > 0;
      iterations += 1;
    }
    if (iterations === RELAXED_EQUALIZATION_ITERATION_CAP && changed) {
      warnings.push('Relaxed fill and equalization reached their iteration cap; retaining the best plan found.');
      if (relaxedEqualization) relaxedEqualization.capped = true;
    }
  } else {
    for (const tier of SURPLUS_TIERS) {
      if (tier === 'rotational') {
        for (const group of FIELD_GROUPS) {
          fillCandidates(group,
            () => allocationMembers(group).filter((candidate) => candidate.selectedKeeper),
            'keeper surplus gains');
        }
      }
      for (const group of FIELD_GROUPS) {
        fillCandidates(group,
          () => groupMembers(group).filter((candidate) => candidate.player.group === tier && !candidate.selectedKeeper),
          `${tier} surplus gains`);
      }
      if (FLEX_IN_TIERS.includes(tier)) {
        for (const group of FIELD_GROUPS) {
          fillCandidates(group,
            () => [...info.values()].filter((candidate) => candidate.primaryGroup !== group
              && candidate.player.group === tier
              && !candidate.selectedKeeper
              && backupGroups(candidate.player).includes(group)),
            `${tier} flex-in gains`);
        }
      }
    }
  }

  const guardrailPlayer = [...info.values()].find((candidate) => !isGuardrailExempt(candidate));
  if (guardrailPlayer && !guardrailAllows(guardrailPlayer, playerTotal(guardrailPlayer.player.name))) {
    warnings.push('Final tier guardrail is relaxed; the hard field floor remains enforced.');
  }

  const quotas: PlayerQuota[] = available.map((player) => {
    const keeper = keeperBlocks(game, player, demand);
    const playerInfoValue = info.get(player.name);
    const pins = playerInfoValue?.pinnedBlocks.length ?? 0;
    const fieldCount = playerInfoValue ? playerTotal(player.name) : 0;
    const floor = playerInfoValue?.floor ?? 0;
    const fieldMin = Math.max(0, floor - pins);
    const fieldTarget = Math.max(0, fieldCount - pins);
    const fieldMax = fieldTarget;
    const groupTargets = playerInfoValue
      ? Object.fromEntries(FIELD_GROUPS.map((group) => [
        group,
        Math.max(0, amountInGroup(player.name, group) - playerInfoValue.pinnedByGroup[group]),
      ])) as Record<FieldGroup, number>
      : undefined;
    return {
      player: player.name,
      group: player.group,
      totalMin: fieldMin + pins + keeper,
      totalMax: fieldMax + pins + keeper,
      pinnedBlocks: playerInfoValue?.pinnedBlocks ?? [],
      remainingMin: fieldMin,
      remainingMax: fieldMax,
      fieldMin,
      fieldMax,
      fieldTarget,
      groupTargets,
      gkMin: keeper,
      gkMax: keeper,
      keeperBlocks: keeper,
      history: player.history,
    };
  });

  for (const group of FIELD_GROUPS) {
    const shortfall = (slots.get(group) ?? 0) - groupLoad(group);
    if (shortfall <= 0) continue;
    const positions = groupPositionNames(demand, group);
    underfill.push({ group, blocks: shortfall, slotNames: positions });
    const label = groupLabel(group);
    const blockLabel = shortfall === 1 ? 'block' : 'blocks';
    const article = group === 'D' ? 'a' : 'an';
    errors.push(`${label} group (${group}) is short ${shortfall} ${blockLabel}. Add ${article} ${group} backup${positions.length ? ` (${positions.join(', ')})` : ''} to a player.`);
  }

  const relaxedPlayerMap = new Map(collapsedRelaxedPlayers.map((entry) => [entry.player, entry]));
  for (const candidate of info.values()) {
    const actual = playerTotal(candidate.player.name);
    if (actual >= candidate.hardFloor) continue;
    const existing = relaxedPlayerMap.get(candidate.player.name);
    relaxedPlayerMap.set(candidate.player.name, {
      player: candidate.player.name,
      group: candidate.player.group,
      before: existing?.before ?? candidate.hardFloor,
      after: actual,
      belowHardFloor: true,
    });
  }
  const finalRelaxedPlayers = [...relaxedPlayerMap.values()]
    .map((entry) => {
      const candidate = info.get(entry.player);
      const actual = candidate ? playerTotal(entry.player) : entry.after;
      return {
        ...entry,
        after: actual,
        belowHardFloor: candidate ? actual < candidate.hardFloor : entry.belowHardFloor,
      };
    })
    .filter((entry) => entry.before > entry.after);
  const relaxedAmounts = new Map<RedesignGroup, number>();
  for (const candidate of info.values()) {
    relaxedAmounts.set(candidate.player.group,
      (relaxedAmounts.get(candidate.player.group) ?? 0) + Math.max(0, candidate.hardFloor - playerTotal(candidate.player.name)));
  }
  const relaxedGroups = [...relaxedAmounts]
    .filter(([, amount]) => amount > 0)
    .map(([group, amount]) => ({ group, amount }));

  const relaxedMaximums = [...info.values()]
    .flatMap((candidate) => {
      const after = playerTotal(candidate.player.name);
      return after > candidate.bandMaximum
        ? [{ player: candidate.player.name, group: candidate.player.group, before: candidate.bandMaximum, after }]
        : [];
    });

  return {
    quotas,
    audit: {
      relaxedGroups,
      relaxedPlayers: finalRelaxedPlayers,
      surplusAssignments,
      unfillableWithinMax: underfill.reduce((sum, entry) => sum + entry.blocks, 0),
      maximumCapacityShortfall,
      relaxedMaximums,
      ...(relaxedEqualization ? { relaxedEqualization } : {}),
      underfill,
      overage: overages,
      rosterTooLarge,
      errors,
      warnings,
    },
    fieldSlots: demand.fieldSlots.length * game.totalBlocks,
    goalkeeperSlots: demand.goalkeeperBlocks[0] + demand.goalkeeperBlocks[1],
    rotationState,
  };
}

function buildWaterfillQuotas(
  game: NormalizedGame,
  demand: DemandModel,
  allowRelaxedMinimums = false,
  allowRelaxedMaximums = false,
): QuotaAssignment {
  const floorOverrides = new Map<string, number>();
  let assignment = buildWaterfillQuotaAttempt(game, demand, floorOverrides, allowRelaxedMaximums);
  if (!allowRelaxedMinimums) return assignment;

  const tierOrder: Record<RedesignGroup, number> = { developing: 0, rotational: 1, core: 2 };
  while (assignment.audit.overage.length) {
    let changed = false;
    const reducedThisRound = new Set<string>();
    for (const { group } of assignment.audit.overage) {
      const candidates = assignment.quotas
        .filter((quota) => quota.groupTargets?.[group] !== undefined
          && quota.groupTargets[group]! > 0
          && quota.player !== game.lateArrival?.player
          && quota.totalMin - quota.keeperBlocks > quota.pinnedBlocks.length)
        .sort((left, right) => tierOrder[left.group] - tierOrder[right.group]
          || left.player.localeCompare(right.player));
      const candidate = candidates.find((quota) => !reducedThisRound.has(quota.player));
      if (!candidate) continue;
      floorOverrides.set(candidate.player, candidate.totalMin - candidate.keeperBlocks - 1);
      reducedThisRound.add(candidate.player);
      changed = true;
    }
    if (!changed) break;
    assignment = buildWaterfillQuotaAttempt(game, demand, floorOverrides, allowRelaxedMaximums);
  }
  return assignment;
}

export function assignQuotas(
  game: NormalizedGame,
  demand: DemandModel,
  allowRelaxedMinimums = false,
  allowRelaxedMaximums = false,
): QuotaAssignment {
  return buildWaterfillQuotas(game, demand, allowRelaxedMinimums, allowRelaxedMaximums);
}

export { BANDS, maximumBlocks, percentageBlocks };
