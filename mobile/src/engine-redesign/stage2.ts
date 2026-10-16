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

function isDedicatedKeeper(player: NormalizedPlayer): boolean {
  return player.keeper && player.generalPositions.length === 0;
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

function assignLegacyQuotas(game: NormalizedGame, demand: DemandModel, tier = 0, allowRelaxedMinimums = false): QuotaAssignment {
  const available = game.players.filter((player) => player.available);
  const fieldPlayers = available.filter((player) => !isDedicatedKeeper(player));
  const fieldSlots = demand.slotsPerBlock * game.totalBlocks;
  const base = new Map<string, { min: number; max: number }>();
  const targets = new Map<string, number>();
  for (const player of fieldPlayers) {
    const band = BANDS[player.group];
    const rawMin = percentageBlocks(game.totalBlocks, band.min, 0);
    const rawMax = maximumBlocks(game.totalBlocks, band.max);
    const halfKeeper = isHalfKeeper(game, player, demand);
    const keeper = keeperBlocks(game, player, demand);
    base.set(player.name, {
      min: halfKeeper ? Math.min(Math.ceil(game.totalBlocks * 0.2), maximumFieldBlocks(game, player, demand)) : rawMin,
      max: halfKeeper ? Math.min(maximumFieldBlocks(game, player, demand), game.totalBlocks - keeper) : rawMax,
    });
    targets.set(player.name, base.get(player.name)!.min);
  }
  const sum = (key: 'min' | 'max'): number => [...base.values()].reduce((total, value) => total + value[key], 0);
  const audit: QuotaAssignment['audit'] = { relaxedGroups: [], relaxedPlayers: [], surplusAssignments: [], unfillableWithinMax: 0 };
  if (sum('min') < fieldSlots) {
    let remaining = fieldSlots - sum('min');
    for (const group of ['core', 'rotational', 'developing'] as const) {
      for (const player of fieldPlayers.filter((candidate) => candidate.group === group).sort((left, right) => left.name.localeCompare(right.name))) {
        const value = base.get(player.name)!;
        const amount = Math.min(remaining, value.max - value.min);
        targets.set(player.name, (targets.get(player.name) ?? value.min) + amount);
        value.max = Math.max(value.max, value.min);
        if (amount) audit.surplusAssignments.push({ group, player: player.name, amount });
        remaining -= amount;
        if (!remaining) break;
      }
      if (!remaining) break;
    }
    audit.unfillableWithinMax = remaining;
  } else if (sum('min') > fieldSlots) {
    const order: RedesignGroup[] = ['developing', 'rotational', 'core'];
    const startingPercent: Record<RedesignGroup, number> = allowRelaxedMinimums
      ? { core: 60, rotational: 50, developing: 40 }
      : { core: 70, rotational: 60, developing: 50 };
    const initialMinimums = new Map(fieldPlayers.map((player) => [player.name, base.get(player.name)!.min]));
    const groupPercent = { ...startingPercent };
    const reduceStep = (minimumPercent: number): void => {
      const group = order[steps % order.length];
      const nextPercent = Math.max(minimumPercent, groupPercent[group] - 10);
      if (nextPercent === groupPercent[group]) {
        steps += 1;
        return;
      }
      groupPercent[group] = nextPercent;
      const target = percentageBlocks(game.totalBlocks, nextPercent / 100, 0);
      for (const player of fieldPlayers.filter((candidate) => candidate.group === group && !isHalfKeeper(game, candidate, demand))) {
        const value = base.get(player.name)!;
        if (value.min > target) {
          value.min = target;
        }
      }
      steps += 1;
    };
    let steps = 0;
    while (sum('min') > fieldSlots && steps < 6) reduceStep(40);
    steps = 0;
    while (sum('min') > fieldSlots && steps < 30) {
      if (Object.values(groupPercent).every((percent) => percent === 0)) break;
      reduceStep(0);
    }
    for (const group of ['core', 'rotational', 'developing'] as const) {
      const amount = fieldPlayers
        .filter((player) => player.group === group)
        .reduce((total, player) => total + (initialMinimums.get(player.name)! - base.get(player.name)!.min), 0);
      if (amount > 0) audit.relaxedGroups.push({ group, amount });
    }
    audit.relaxedPlayers = fieldPlayers
      .map((player) => ({ player: player.name, group: player.group, before: initialMinimums.get(player.name)!, after: base.get(player.name)!.min }))
      .filter((entry) => entry.before > entry.after);
  }
  const effectiveMax = (): number => fieldPlayers.reduce((total, player) => {
    const value = base.get(player.name)!;
    const pins = endpointPins(game, player).length;
    return total + Math.max(0, Math.min(value.max - pins, maximumFieldBlocks(game, player, demand) - pins));
  }, 0);
  const totalPins = fieldPlayers.reduce((total, player) => total + endpointPins(game, player).length, 0);
  if (effectiveMax() < fieldSlots - totalPins) {
    let deficit = fieldSlots - totalPins - effectiveMax();
    const priority = (group: RedesignGroup): number => group === 'core' ? 0 : group === 'rotational' ? 1 : 2;
    const candidates = [...fieldPlayers]
      .sort((left, right) => {
        const leftKeeper = isHalfKeeper(game, left, demand) ? 1 : 0;
        const rightKeeper = isHalfKeeper(game, right, demand) ? 1 : 0;
        return leftKeeper - rightKeeper || priority(left.group) - priority(right.group) || left.name.localeCompare(right.name);
      });
    while (deficit > 0) {
      let changed = false;
      for (const player of candidates) {
        const value = base.get(player.name)!;
        const cap = maximumFieldBlocks(game, player, demand);
        if (value.max >= cap) continue;
        value.max += 1;
        audit.surplusAssignments.push({ group: player.group, player: player.name, amount: 1 });
        deficit = fieldSlots - totalPins - effectiveMax();
        changed = true;
        if (!deficit) break;
      }
      if (!changed) break;
    }
    audit.unfillableWithinMax += deficit;
  }
  const tierShifts = [
    { core: 0, rotational: 0, developing: 0 },
    { core: 2, rotational: 1, developing: 1 },
    { core: 2, rotational: 2, developing: 1 },
    { core: 2, rotational: 2, developing: 2 },
  ];
  const shifts = tierShifts[Math.max(0, Math.min(3, tier))];
  if (tier > 0) {
    for (const player of fieldPlayers) {
      if (isHalfKeeper(game, player, demand)) continue;
      const value = base.get(player.name)!;
      value.max = Math.min(game.totalBlocks, value.max + shifts[player.group]);
    }
  }
  const quotas: PlayerQuota[] = available.map((player) => {
    const pins = endpointPins(game, player);
    const gk = keeperBlocks(game, player, demand);
    const dedicated = isDedicatedKeeper(player);
    const field = base.get(player.name) ?? { min: 0, max: 0 };
    const availableField = Math.max(0, maximumFieldBlocks(game, player, demand) - pins.length);
    const fieldMin = dedicated ? 0 : Math.max(0, Math.min(field.min - pins.length, availableField));
    const fieldMax = dedicated ? 0 : Math.max(fieldMin, Math.min(field.max - pins.length, game.totalBlocks - gk - pins.length));
    const gkMin = dedicated ? gk : gk;
    const gkMax = dedicated ? gk : gk;
    const quota = {
      player: player.name,
      group: player.group,
      totalMin: fieldMin + pins.length + gkMin,
      totalMax: fieldMax + pins.length + gkMax,
      pinnedBlocks: pins,
      remainingMin: fieldMin,
      remainingMax: fieldMax,
      fieldMin,
      fieldMax,
      fieldTarget: dedicated
        ? 0
        : Math.max(0, Math.min((targets.get(player.name) ?? field.min) - pins.length, availableField)),
      gkMin,
      gkMax,
      keeperBlocks: gk,
      history: player.history,
    };
    return quota;
  });
  const arrival = game.lateArrival;
  if (arrival) {
    const quota = quotas.find((candidate) => candidate.player === arrival.player);
    if (quota) {
      const player = game.players.find((candidate) => candidate.name === arrival.player)!;
      const remainingBlocks = game.totalBlocks - arrival.arrivalBlock + 1;
      const target = arrival.targetBlocks ?? Math.round(BANDS[player.group].midpoint * remainingBlocks);
      quota.totalMin = target;
      quota.totalMax = target;
      quota.remainingMin = Math.max(0, target - quota.pinnedBlocks.length);
      quota.remainingMax = quota.remainingMin;
    }
  }
  return {
    quotas,
    audit,
    fieldSlots,
    goalkeeperSlots: demand.goalkeeperBlocks[0] + demand.goalkeeperBlocks[1],
    rotationState: game.seasonRotation,
  };
}

type FieldAllocation = Map<string, Map<FieldGroup, number>>;
type RotationAction = 'lastShed' | 'lastGained';

interface WaterfillPlayer {
  player: NormalizedPlayer;
  primaryGroup: FieldGroup | null;
  keeperBlocks: number;
  selectedKeeper: boolean;
  floor: number;
  bandFloor: number;
  maximum: number;
  pinnedBlocks: number[];
  pinnedByGroup: Record<FieldGroup, number>;
}

const FIELD_GROUPS: FieldGroup[] = ['D', 'M', 'F'];
const SHED_TIERS: RedesignGroup[] = ['developing', 'rotational'];
const HIT_TIERS: RedesignGroup[] = ['developing', 'rotational', 'core'];
const SURPLUS_TIERS: RedesignGroup[] = ['core', 'rotational', 'developing'];
const FLEX_OUT_TIERS: RedesignGroup[] = ['rotational', 'developing', 'core'];
const FLEX_IN_TIERS: RedesignGroup[] = ['core', 'rotational'];

function groupForPosition(position: string): FieldGroup | null {
  const normalized = position.toUpperCase();
  if (['D', 'LB', 'LCB', 'CB', 'RCB', 'RB', 'LWB', 'RWB'].includes(normalized)) return 'D';
  if (['M', 'LM', 'LCM', 'CM', 'RCM', 'RM', 'CDM', 'CAM'].includes(normalized)) return 'M';
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

function buildWaterfillQuotas(
  game: NormalizedGame,
  demand: DemandModel,
): QuotaAssignment {
  const available = game.players.filter((player) => player.available);
  const fieldPlayers = available.filter((player) => !isDedicatedKeeper(player));
  const info = new Map<string, WaterfillPlayer>();
  const allocations: FieldAllocation = new Map();
  let rotationState = cloneRotation(game.seasonRotation ?? {});
  const relaxedPlayers: Array<{ player: string; group: RedesignGroup; before: number; after: number }> = [];
  const surplusAssignments: QuotaAssignment['audit']['surplusAssignments'] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

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
    const floor = Math.max(pinData.blocks.length, lateTarget ?? (isSelectedKeeper
      ? player.group === 'rotational' ? keeperFloor : keeperFieldMax
      : nonKeeperFieldFloor(game.totalBlocks)));
    const start = Math.max(pinData.blocks.length, lateTarget ?? (isSelectedKeeper
      ? keeperFieldMax
      : percentageBlocks(game.totalBlocks, BANDS[player.group].min, 0)));
    const maximum = Math.max(start, lateTarget ?? (isSelectedKeeper
      ? keeperFieldMax
      : maximumBlocks(game.totalBlocks, BANDS[player.group].max)));
    info.set(player.name, {
      player,
      primaryGroup: group,
      keeperBlocks: keeper,
      selectedKeeper: isSelectedKeeper,
      floor,
      bandFloor: Math.max(pinData.blocks.length, bandFloor),
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
  if (minimumFieldBlocks > totalFieldSlots) {
    const maximumPlayers = Math.floor(totalFieldSlots / nonKeeperFieldFloor(game.totalBlocks));
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
    relaxedPlayers.push({ player: name, group: candidate.player.group, before, after: before - 1 });
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
    const label = group === 'D' ? 'Defender' : group === 'M' ? 'Midfield' : 'Forward';
    const blockLabel = shortfall === 1 ? 'block' : 'blocks';
    const article = group === 'D' ? 'a' : 'an';
    errors.push(`${label} group (${group}) is short ${shortfall} ${blockLabel}. Add ${article} ${group} backup${positions.length ? ` (${positions.join(', ')})` : ''} to a player.`);
  }

  return {
    quotas,
    audit: {
      relaxedGroups: [],
      relaxedPlayers: collapsedRelaxedPlayers,
      surplusAssignments,
      unfillableWithinMax: errors.length ? FIELD_GROUPS.reduce((sum, group) =>
        sum + Math.max(0, (slots.get(group) ?? 0) - groupLoad(group)), 0) : 0,
      errors,
      warnings,
    },
    fieldSlots: demand.fieldSlots.length * game.totalBlocks,
    goalkeeperSlots: demand.goalkeeperBlocks[0] + demand.goalkeeperBlocks[1],
    rotationState,
  };
}

export function assignQuotas(
  game: NormalizedGame,
  demand: DemandModel,
  tier = 0,
  allowRelaxedMinimums = false,
): QuotaAssignment {
  const usesWaterfill = usesWaterfillQuotas(game);
  return usesWaterfill
    ? buildWaterfillQuotas(game, demand)
    : assignLegacyQuotas(game, demand, tier, allowRelaxedMinimums);
}

export function usesWaterfillQuotas(game: NormalizedGame): boolean {
  const fieldPlayers = game.players.filter((player) => player.available && !isDedicatedKeeper(player));
  return !fieldPlayers.some((player) => {
    const groups = new Set(player.generalPositions.map(groupForPosition).filter((group) => group !== null));
    return groups.size > 1 || (groups.size === 0 && player.generalPositions.length > 0);
  });
}

export { BANDS, maximumBlocks, percentageBlocks };
