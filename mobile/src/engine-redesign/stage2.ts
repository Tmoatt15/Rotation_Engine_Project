import type { DemandModel, NormalizedGame, NormalizedPlayer, PlayerQuota, QuotaAssignment, RedesignGroup } from './model';

const BANDS: Record<RedesignGroup, { min: number; max: number; midpoint: number }> = {
  core: { min: 0.7, max: 0.8, midpoint: 0.75 },
  rotational: { min: 0.6, max: 0.7, midpoint: 0.65 },
  developing: { min: 0.5, max: 0.6, midpoint: 0.55 },
};

function percentageBlocks(totalBlocks: number, percentage: number, minimum: number): number {
  return Math.max(minimum, Math.min(totalBlocks, Math.round(totalBlocks * percentage)));
}

function maximumBlocks(totalBlocks: number, percentage: number): number {
  const rounded = Math.round(totalBlocks * percentage);
  return Math.max(1, Math.min(totalBlocks, rounded > totalBlocks * percentage ? Math.floor(totalBlocks * percentage) : rounded));
}

function isDedicatedKeeper(player: NormalizedPlayer): boolean {
  return player.generalPositions.length > 0 && player.generalPositions.every((position) => position === 'GK');
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

function endpointPins(game: NormalizedGame, player: NormalizedPlayer): number[] {
  if (player.group !== 'core' || !player.available) return [];
  const blockOnePin = game.pins.some((pin) => pin.block === 1 && pin.player === player.name);
  const late = game.lateArrival?.player === player.name;
  if (late || (!blockOnePin && game.pins.length > 0)) return [game.totalBlocks];
  return [1, game.totalBlocks];
}

export function assignQuotas(game: NormalizedGame, demand: DemandModel): QuotaAssignment {
  const available = game.players.filter((player) => player.available);
  const fieldPlayers = available.filter((player) => !isDedicatedKeeper(player));
  const fieldSlots = demand.slotsPerBlock * game.totalBlocks;
  const base = new Map<string, { min: number; max: number }>();
  const targets = new Map<string, number>();
  for (const player of fieldPlayers) {
    const band = BANDS[player.group];
    const halfKeeper = isHalfKeeper(game, player, demand);
    const keeper = keeperBlocks(game, player, demand);
    base.set(player.name, {
      min: halfKeeper ? Math.min(2, game.totalBlocks - keeper) : percentageBlocks(game.totalBlocks, band.min, 0),
      max: halfKeeper ? Math.min(4, game.totalBlocks - keeper) : maximumBlocks(game.totalBlocks, band.max),
    });
    targets.set(player.name, base.get(player.name)!.min);
  }
  const sum = (key: 'min' | 'max'): number => [...base.values()].reduce((total, value) => total + value[key], 0);
  const audit: QuotaAssignment['audit'] = { relaxedGroups: [], surplusAssignments: [], unfillableWithinMax: 0 };
  if (sum('min') < fieldSlots) {
    let remaining = fieldSlots - sum('min');
    for (const group of ['core', 'rotational', 'developing'] as const) {
      for (const player of fieldPlayers.filter((candidate) => candidate.group === group).sort((left, right) => left.name.localeCompare(right.name))) {
        const value = base.get(player.name)!;
        const amount = Math.min(remaining, value.max - value.min);
        if (isHalfKeeper(game, player, demand)) targets.set(player.name, (targets.get(player.name) ?? value.min) + amount);
        else value.min += amount;
        value.max = Math.max(value.max, value.min);
        if (amount) audit.surplusAssignments.push({ group, player: player.name, amount });
        remaining -= amount;
        if (!remaining) break;
      }
      if (!remaining) break;
    }
    audit.unfillableWithinMax = remaining;
  } else if (sum('min') > fieldSlots) {
    let shortage = sum('min') - fieldSlots;
    const reduceRoundRobin = (groups: RedesignGroup[], floor: number | ((player: NormalizedPlayer) => number)): void => {
      const candidates = groups.flatMap((group) => fieldPlayers
        .filter((candidate) => candidate.group === group)
          .filter((candidate) => !isHalfKeeper(game, candidate, demand))
          .sort((left, right) => left.name.localeCompare(right.name)));
      while (shortage > 0) {
        let changed = false;
        for (const player of candidates) {
          const value = base.get(player.name)!;
          const minimum = typeof floor === 'function' ? floor(player) : floor;
          if (value.min <= minimum) continue;
          value.min -= 1;
          shortage -= 1;
          changed = true;
          audit.relaxedGroups.push({ group: player.group, amount: 1 });
          if (!shortage) return;
        }
        if (!changed) return;
      }
    };
    const rotationalMins = fieldPlayers.filter((player) => player.group === 'rotational').map((player) => base.get(player.name)!.min);
    const rotationalMin = rotationalMins.length ? Math.min(...rotationalMins) : 0;
    reduceRoundRobin(['developing'], 0);
    reduceRoundRobin(['core'], rotationalMin);
    reduceRoundRobin(['core', 'rotational'], 0);
    reduceRoundRobin(['developing', 'core', 'rotational'], 0);
  }
  const quotas: PlayerQuota[] = available.map((player) => {
    const pins = endpointPins(game, player);
    const gk = keeperBlocks(game, player, demand);
    const dedicated = isDedicatedKeeper(player);
    const field = base.get(player.name) ?? { min: 0, max: 0 };
    const fieldMin = dedicated ? 0 : Math.max(0, field.min - pins.length);
    const fieldMax = dedicated ? 0 : Math.max(fieldMin, Math.min(field.max - pins.length, game.totalBlocks - gk - pins.length));
    const gkMin = dedicated ? gk : gk;
    const gkMax = dedicated ? gk : gk;
    return {
      player: player.name,
      group: player.group,
      totalMin: fieldMin + pins.length + gkMin,
      totalMax: fieldMax + pins.length + gkMax,
      pinnedBlocks: pins,
      remainingMin: fieldMin,
      remainingMax: fieldMax,
      fieldMin,
      fieldMax,
      fieldTarget: targets.get(player.name) ?? fieldMin,
      gkMin,
      gkMax,
      keeperBlocks: gk,
      history: player.history,
    };
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
