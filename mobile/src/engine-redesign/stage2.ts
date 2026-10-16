import type { DemandModel, NormalizedGame, NormalizedPlayer, PlayerQuota, QuotaAssignment, RedesignGroup } from './model';

const BANDS: Record<RedesignGroup, { min: number; max: number; midpoint: number }> = {
  core: { min: 0.7, max: 0.8, midpoint: 0.75 },
  rotational: { min: 0.6, max: 0.7, midpoint: 0.65 },
  developing: { min: 0.5, max: 0.6, midpoint: 0.55 },
};

const QUOTA_DIAGNOSTICS = true;

function quotaLog(message: string): void {
  if (QUOTA_DIAGNOSTICS) console.log(`[quota] ${message}`);
}

function percentageBlocks(totalBlocks: number, percentage: number, minimum: number): number {
  return Math.max(minimum, Math.min(totalBlocks, Math.round(totalBlocks * percentage)));
}

function maximumBlocks(totalBlocks: number, percentage: number): number {
  const rounded = Math.round(totalBlocks * percentage);
  return Math.max(1, Math.min(totalBlocks, rounded > totalBlocks * percentage ? Math.floor(totalBlocks * percentage) : rounded));
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
    ? Math.min(available, Math.max(0, Math.floor(game.totalBlocks / 2) - 1))
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

export function assignQuotas(game: NormalizedGame, demand: DemandModel, tier = 0, allowRelaxedMinimums = false): QuotaAssignment {
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
    quotaLog(`${player.name} group=${player.group} band.min=${band.min} rawMin=${rawMin} rawMax=${rawMax} halfKeeper=${halfKeeper} keeperBlocks=${keeper}`);
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
    quotaLog(`RELAXATION triggered: sumMin=${sum('min')} slots=${fieldSlots} allowRelaxedMinimums=${allowRelaxedMinimums}`);
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
    quotaLog(`After relaxation: sumMin=${sum('min')}`);
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
    if (QUOTA_DIAGNOSTICS && !isDedicatedKeeper(player)) {
      const rawMin = percentageBlocks(game.totalBlocks, BANDS[player.group].min, 0);
      const rawMax = maximumBlocks(game.totalBlocks, BANDS[player.group].max);
      quotaLog(`${player.name} FINAL: raw=${rawMin}-${rawMax} pins=${pins.length} field=${quota.fieldMin}-${quota.fieldMax} total=${quota.totalMin}-${quota.totalMax}`);
    }
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
  return { quotas, audit, fieldSlots, goalkeeperSlots: demand.goalkeeperBlocks[0] + demand.goalkeeperBlocks[1] };
}

export { BANDS, maximumBlocks, percentageBlocks };
