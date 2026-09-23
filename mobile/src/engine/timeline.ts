import type { Game, MovementMetrics, Player, PositionGroup, RotationResult, ScheduleBlock } from './models';
import { ANY_POSITION, backupCoversPosition, backupEligiblePlayers, eligiblePlayers, emergencyEligiblePlayers, generalPositionAllowsGroup, positionalPriority, POSITION_GROUP_BY_SLOT } from './positional';

export type FormationCounts = { D: number; M: number; F: number; _shape?: string };

function halfLength(totalBlocks: number): number {
  return Math.ceil(totalBlocks / 2);
}

function isSameHalf(firstBlock: number, secondBlock: number, totalBlocks: number): boolean {
  const midpoint = halfLength(totalBlocks);
  return (firstBlock < midpoint) === (secondBlock < midpoint);
}

function blockHalf(blockIndex: number, totalBlocks: number): 0 | 1 {
  return blockIndex < halfLength(totalBlocks) ? 0 : 1;
}

export function parseFormation(formation: string): FormationCounts {
  const parts = formation.split('-');
  if (formation === '2-1-2-1') return { D: 2, M: 3, F: 1, _shape: formation };
  if (formation === '4-2-3-1') return { D: 4, M: 5, F: 1, _shape: formation };
  if (parts.length === 2) return { D: Number(parts[0]), M: 0, F: Number(parts[1]) };
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) throw new Error("Formation must be in format 'D-M-F' or 'D-F'");
  return { D: Number(parts[0]), M: Number(parts[1]), F: Number(parts[2]) };
}

export function formationSlots(formation: FormationCounts): Record<'D' | 'M' | 'F', string[]> {
  if (formation._shape === '2-1-2-1') return { D: ['LB', 'RB'], M: ['CDM', 'LM', 'RM'], F: ['F'] };
  if (formation._shape === '4-2-3-1') return { D: ['LB', 'LCB', 'RCB', 'RB'], M: ['LAM', 'CAM', 'RAM', 'LDM', 'RDM'], F: ['F'] };
  const names: Record<'D' | 'M' | 'F', Record<number, string[]>> = {
    D: { 1: ['CB'], 2: ['LB', 'RB'], 3: ['LB', 'CB', 'RB'], 4: ['LB', 'LCB', 'RCB', 'RB'], 5: ['LWB', 'LCB', 'CB', 'RCB', 'RWB'] },
    M: { 1: ['CM'], 2: ['LCM', 'RCM'], 3: ['LM', 'CM', 'RM'], 4: ['LM', 'LCM', 'RCM', 'RM'], 5: ['LM', 'LCM', 'CM', 'RCM', 'RM'] },
    F: { 1: ['ST'], 2: ['LF', 'RF'], 3: ['LF', 'CF', 'RF'], 4: ['LW', 'LS', 'RS', 'RW'] },
  };
  return { D: names.D[formation.D] ?? Array.from({ length: formation.D }, (_, index) => `D${index + 1}`), M: names.M[formation.M] ?? Array.from({ length: formation.M }, (_, index) => `M${index + 1}`), F: names.F[formation.F] ?? Array.from({ length: formation.F }, (_, index) => `F${index + 1}`) };
}

export function chooseGk(game: Game, roster: Player[], blockNumber: number): Player | null {
  const goalkeepers = roster.filter((player) => player.available && player.primary_positions.some((position) => position.toUpperCase() === 'GK'));
  if (goalkeepers.length) {
    const half = blockNumber <= halfLength(game.total_blocks) ? 0 : 1;
    const requested = half === 0 ? game.first_half_gk : game.second_half_gk;
    const selected = requested ? goalkeepers.find((player) => player.name.trim().toLowerCase() === requested.trim().toLowerCase()) : undefined;
    if (selected) return selected;
    if (goalkeepers.length === 1) return goalkeepers[0];
    return goalkeepers[Math.min(half, goalkeepers.length - 1)] ?? goalkeepers[0];
  }
  if (!game.allow_emergency_positions) return null;
  return roster.filter((player) => player.available && player.primary_position !== 'GK' && player.position_usage.GK === 0).sort((left, right) => left.block_count - right.block_count || left.name.localeCompare(right.name))[0] ?? null;
}

function resetPlayerStats(player: Player): void {
  player.block_count = 0; player.bench_count = 0; player.gk_blocks = 0; player.field_blocks = 0; player.blocks_by_half = [0, 0]; player.position_usage = { GK: 0, D: 0, M: 0, F: 0 }; player.last_two = [];
}

function playerUnavailable(game: Game, name: string, blockNumber: number): boolean {
  let unavailable = false;
  for (const change of game.availability_changes) if (change.player === name && blockNumber >= change.block + 1) unavailable = change.action === 'unavailable';
  return unavailable;
}

export function applyBlockToStats(roster: Player[], block: ScheduleBlock, half: 0 | 1, game?: Game, blockNumber?: number): void {
  const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]);
  for (const position of ['D', 'M', 'F'] as const) for (const name of block[position]) {
    const player = roster.find((candidate) => candidate.name === name); if (!player) continue;
    player.block_count += 1; player.field_blocks += 1; player.blocks_by_half[half] += 1; player.position_usage[position] += 1;
  }
  const goalkeeper = roster.find((player) => player.name === block.GK);
  if (goalkeeper) { goalkeeper.block_count += 1; goalkeeper.gk_blocks += 1; goalkeeper.position_usage.GK += 1; }
  for (const player of roster) if (!assigned.has(player.name) && (!game || !playerUnavailable(game, player.name, blockNumber ?? 0))) player.bench_count += 1;
}

export function replayTimeline(roster: Player[], prefix: ScheduleBlock[], game: Game): void {
  roster.forEach(resetPlayerStats);
  prefix.forEach((block, index) => applyBlockToStats(roster, block, index < halfLength(game.total_blocks) ? 0 : 1, game, index + 1));
  for (const credit of game.replacement_credits) {
    const player = roster.find((candidate) => candidate.name === credit.player); if (!player) continue;
    const half = credit.block <= halfLength(game.total_blocks) ? 0 : 1;
    player.block_count += 1; player.blocks_by_half[half] += 1; player.position_usage[credit.position as PositionGroup] += 1;
    if (credit.position === 'GK') player.gk_blocks += 1; else player.field_blocks += 1;
  }
}

function completeExactAssignmentExists(roster: Player[], names: string[], slots: string[], group: PositionGroup): boolean {
  const players = names.map((name) => roster.find((player) => player.name === name)).filter((player): player is Player => Boolean(player));
  if (players.length !== slots.length) return false;
  const candidatesBySlot = new Map(slots.map((slot) => [slot, players.filter((player) => canCoverSlot(player, slot, group))]));
  const orderedSlots = [...slots].sort((left, right) => (candidatesBySlot.get(left)?.length ?? 0) - (candidatesBySlot.get(right)?.length ?? 0));

  const search = (index: number, used: Set<string>): boolean => {
    if (index === orderedSlots.length) return true;
    for (const player of candidatesBySlot.get(orderedSlots[index]) ?? []) {
      if (used.has(player.name)) continue;
      used.add(player.name);
      if (search(index + 1, used)) return true;
      used.delete(player.name);
    }
    return false;
  };

  return search(0, new Set<string>());
}

function assignExactSlots(roster: Player[], names: string[], slots: string[], group: PositionGroup, previous: Record<string, string>, seasonStarts: Record<string, Record<string, number>> = {}): Record<string, string> {
  const players = names.map((name) => roster.find((player) => player.name === name)).filter((player): player is Player => Boolean(player));
  const candidatesBySlot = new Map(slots.map((slot) => [slot, players.filter((player) => canCoverSlot(player, slot, group))]));
  const orderedSlots = [...slots].sort((left, right) => (candidatesBySlot.get(left)?.length ?? 0) - (candidatesBySlot.get(right)?.length ?? 0));
  let bestAssignment: Record<string, string> | null = null;
  let bestScore: [number, number, number, string] | null = null;

  const scoreAssignment = (assignment: Record<string, string>): [number, number, number, string] => {
    let stayed = 0;
    let primary = 0;
    let historicalStarts = 0;
    for (const slot of slots) {
      const player = players.find((candidate) => candidate.name === assignment[slot]);
      if (!player) continue;
      if (previous[player.name] === slot) stayed += 1;
      if (player.primary_positions.includes(slot)) primary += 1;
      historicalStarts += seasonStarts[player.name]?.[slot] ?? 0;
    }
    return [stayed, primary, -historicalStarts, slots.map((slot) => assignment[slot]).join('|')];
  };

  const isBetter = (left: [number, number, number, string], right: [number, number, number, string] | null): boolean => {
    if (!right) return true;
    for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
    return left[3] < right[3];
  };

  const search = (index: number, used: Set<string>, assignment: Record<string, string>): void => {
    if (index === orderedSlots.length) {
      const score = scoreAssignment(assignment);
      if (isBetter(score, bestScore)) { bestScore = score; bestAssignment = { ...assignment }; }
      return;
    }
    const slot = orderedSlots[index];
    for (const player of candidatesBySlot.get(slot) ?? []) {
      if (used.has(player.name)) continue;
      used.add(player.name); assignment[slot] = player.name;
      search(index + 1, used, assignment);
      used.delete(player.name); delete assignment[slot];
    }
  };
  search(0, new Set<string>(), {});
  if (bestAssignment) return Object.fromEntries(slots.map((slot) => [slot, bestAssignment?.[slot] ?? 'UNASSIGNED']));
  return Object.fromEntries(slots.map((slot) => [slot, 'UNASSIGNED']));
}

export function canCoverSlot(player: Player, slot: string, group: PositionGroup): boolean {
  const centralMidfield = new Set(['LCM', 'CM', 'RCM']);
  const centralDefense = new Set(['LCB', 'CB', 'RCB']);
  const equivalentCentralMidfield = centralMidfield.has(slot) && player.primary_positions.some((position) => centralMidfield.has(position));
  const equivalentCentralDefense = centralDefense.has(slot) && player.primary_positions.some((position) => centralDefense.has(position));
  return !player.forbidden_positions.includes(group) && (
    player.primary_positions.includes(slot) ||
    (player.primary_positions.includes(ANY_POSITION) && generalPositionAllowsGroup(player, group)) ||
    equivalentCentralMidfield ||
    equivalentCentralDefense ||
    backupCoversPosition(player, slot) ||
    player.general_positions.includes(group)
  );
}

function movementMetricScore(metrics: MovementMetrics): [number, number, number, number, number] {
  return [metrics.exact_slot_switches, metrics.turnovers, metrics.backup_assignments, metrics.emergency_assignments, -metrics.primary_assignments];
}

function compareMetricScores(left: MovementMetrics, right: MovementMetrics): number {
  const leftScore = movementMetricScore(left);
  const rightScore = movementMetricScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return leftScore[index] - rightScore[index];
  }
  return 0;
}

function assignmentQuality(player: Player | undefined, slot: string): 'primary' | 'backup' | 'emergency' | null {
  if (!player || player.name === 'UNASSIGNED') return null;
  if (player.primary_positions.includes(slot)) return 'primary';
  if (backupCoversPosition(player, slot)) return 'backup';
  return 'emergency';
}

export function calculateMovementMetrics(
  timeline: ScheduleBlock[],
  totalBlocks: number,
  roster: Player[] = [],
  slots?: Record<'D' | 'M' | 'F', string[]>,
): MovementMetrics {
  const groupsBySlot = slots ?? { D: [], M: [], F: [] };
  const slotGroup = new Map<string, PositionGroup>([
    ...FIELD_GROUPS.flatMap((group) => groupsBySlot[group].map((slot) => [slot, group] as const)),
    ['GK', 'GK'],
  ]);
  const metrics: MovementMetrics = {
    turnovers: 0,
    exact_slot_switches: 0,
    group_switches: 0,
    primary_assignments: 0,
    backup_assignments: 0,
    emergency_assignments: 0,
    by_half: [{ turnovers: 0, exact_slot_switches: 0, group_switches: 0 }, { turnovers: 0, exact_slot_switches: 0, group_switches: 0 }],
  };
  const playerByName = new Map(roster.map((player) => [player.name, player]));
  for (const block of timeline) {
    for (const [slot, name] of Object.entries(block.positions ?? {})) {
      const quality = assignmentQuality(playerByName.get(name), slot);
      if (quality === 'primary') metrics.primary_assignments += 1;
      if (quality === 'backup') metrics.backup_assignments += 1;
      if (quality === 'emergency') metrics.emergency_assignments += 1;
    }
  }
  for (let blockIndex = 1; blockIndex < timeline.length; blockIndex += 1) {
    const previous = timeline[blockIndex - 1].positions ?? {};
    const current = timeline[blockIndex].positions ?? {};
    const transitionHalf = blockHalf(blockIndex, totalBlocks);
    const sameHalf = isSameHalf(blockIndex - 1, blockIndex, totalBlocks);
    const allSlots = new Set([...Object.keys(previous), ...Object.keys(current)]);
    let turnovers = 0;
    for (const slot of allSlots) if (previous[slot] !== current[slot]) turnovers += 1;
    metrics.turnovers += turnovers;
    metrics.by_half[transitionHalf].turnovers += turnovers;
    const previousSlots = new Map<string, string>();
    const currentSlots = new Map<string, string>();
    for (const [slot, name] of Object.entries(previous)) if (name && name !== 'UNASSIGNED') previousSlots.set(name, slot);
    for (const [slot, name] of Object.entries(current)) if (name && name !== 'UNASSIGNED') currentSlots.set(name, slot);
    if (!sameHalf) continue;
    let exact = 0;
    let groups = 0;
    for (const [name, previousSlot] of previousSlots) {
      const currentSlot = currentSlots.get(name);
      if (!currentSlot || currentSlot === previousSlot || previousSlot === 'GK' || currentSlot === 'GK') continue;
      exact += 1;
      if (slotGroup.get(previousSlot) !== slotGroup.get(currentSlot)) groups += 1;
    }
    metrics.exact_slot_switches += exact;
    metrics.group_switches += groups;
    metrics.by_half[transitionHalf].exact_slot_switches += exact;
    metrics.by_half[transitionHalf].group_switches += groups;
  }
  return metrics;
}

function legalAssignments(names: string[], slots: string[], roster: Player[], group: PositionGroup): Record<string, string>[] {
  const players = names.map((name) => roster.find((player) => player.name === name)).filter((player): player is Player => Boolean(player));
  const candidatesBySlot = new Map(slots.map((slot) => [slot, players.filter((player) => canCoverSlot(player, slot, group))]));
  const orderedSlots = [...slots].sort((left, right) => (candidatesBySlot.get(left)?.length ?? 0) - (candidatesBySlot.get(right)?.length ?? 0));
  const assignments: Record<string, string>[] = [];
  const search = (index: number, used: Set<string>, assignment: Record<string, string>): void => {
    if (index === orderedSlots.length) {
      assignments.push({ ...assignment });
      return;
    }
    const slot = orderedSlots[index];
    for (const player of candidatesBySlot.get(slot) ?? []) {
      if (used.has(player.name)) continue;
      used.add(player.name);
      assignment[slot] = player.name;
      search(index + 1, used, assignment);
      used.delete(player.name);
      delete assignment[slot];
    }
  };
  search(0, new Set<string>(), {});
  return assignments;
}

function optimizeExactSlotSwitches(game: Game, roster: Player[], timeline: ScheduleBlock[], slots: Record<'D' | 'M' | 'F', string[]>, startBlock: number): void {
  const firstBlock = Math.max(0, startBlock - 1);
  let improved = true;
  for (let pass = 0; improved && pass < game.total_blocks * FIELD_GROUPS.length; pass += 1) {
    improved = false;
    const before = calculateMovementMetrics(timeline, game.total_blocks, roster, slots);
    let bestTimeline: Record<string, string> | null = null;
    let bestBlock = -1;
    let bestGroup: 'D' | 'M' | 'F' | null = null;
    let bestMetrics = before;
    for (let blockIndex = firstBlock; blockIndex < timeline.length; blockIndex += 1) {
      for (const group of FIELD_GROUPS) {
        const groupSlots = slots[group];
        const names = groupSlots.map((slot) => timeline[blockIndex].positions[slot]).filter((name) => name && name !== 'UNASSIGNED');
        if (names.length !== groupSlots.length || new Set(names).size !== names.length) continue;
        for (const candidate of legalAssignments(names, groupSlots, roster, group)) {
          const current = Object.fromEntries(groupSlots.map((slot) => [slot, timeline[blockIndex].positions[slot]]));
          if (groupSlots.every((slot) => candidate[slot] === current[slot])) continue;
          Object.assign(timeline[blockIndex].positions, candidate);
          const after = calculateMovementMetrics(timeline, game.total_blocks, roster, slots);
          Object.assign(timeline[blockIndex].positions, current);
          if (compareMetricScores(after, bestMetrics) < 0) {
            bestMetrics = after;
            bestTimeline = candidate;
            bestBlock = blockIndex;
            bestGroup = group;
          }
        }
      }
    }
    if (bestTimeline && bestGroup && bestBlock >= 0) {
      Object.assign(timeline[bestBlock].positions, bestTimeline);
      improved = true;
    }
  }
}

function validateTimeline(roster: Player[], timeline: ScheduleBlock[], formation: FormationCounts, slots: Record<'D' | 'M' | 'F', string[]>): string[] {
  const errors: string[] = [];
  for (const [index, block] of timeline.entries()) {
    const blockNumber = index + 1;
    const assigned = [block.GK, ...FIELD_GROUPS.flatMap((group) => block[group])].filter(Boolean);
    if (new Set(assigned).size !== assigned.length) errors.push(`Block ${blockNumber}: duplicate players are assigned on the field.`);
    for (const group of FIELD_GROUPS) {
      if (block[group].length !== formation[group]) errors.push(`Block ${blockNumber}: ${group} requires ${formation[group]} players but has ${block[group].length}.`);
      if (block[group].length === formation[group] && !completeExactAssignmentExists(roster, block[group], slots[group], group)) errors.push(`Block ${blockNumber}: ${group} players cannot form a complete legal exact-slot assignment.`);
    }
  }
  return errors;
}

function chooseFieldPlayers(game: Game, roster: Player[], group: PositionGroup, needed: number, used: Set<string>, half: 0 | 1, previous: Set<string>): Player[] {
  const candidates = eligiblePlayers(roster, group, game.allow_emergency_positions).filter((player) => !used.has(player.name) && player.block_count < player.hard_maximum_blocks && player.blocks_by_half[half] < player.max_blocks_per_half);
  candidates.sort((left, right) => {
    const deficit = (player: Player) => Math.max(0, player.hard_minimum_blocks - player.block_count);
    const target = (player: Player) => Math.max(0, player.target_blocks - player.block_count);
    return (deficit(right) - deficit(left)) || (positionalPriority(left, group, game.allow_emergency_positions) - positionalPriority(right, group, game.allow_emergency_positions)) || (target(right) - target(left)) || (previous.has(left.name) ? -1 : 1) || left.block_count - right.block_count || left.name.localeCompare(right.name);
  });
  if (candidates.length < needed && game.allow_emergency_positions) {
    const fallback = roster.filter((player) => player.available && !used.has(player.name) && !player.excluded_positions.includes(group));
    for (const player of fallback) if (!candidates.includes(player)) candidates.push(player);
  }
  return candidates.slice(0, needed);
}

type PlannedGroups = Record<'D' | 'M' | 'F', string[][]>;

const FIELD_GROUPS: Array<'D' | 'M' | 'F'> = ['D', 'M', 'F'];

function canCoverGroup(game: Game, roster: Player[], name: string, position: PositionGroup): boolean {
  return [
    ...eligiblePlayers(roster, position, game.allow_emergency_positions),
    ...backupEligiblePlayers(roster, position),
  ].some((player) => player.name === name);
}

function groupSwitchCount(plans: PlannedGroups, fromBlock: number, toBlock: number): number {
  let switches = 0;
  for (const fromGroup of FIELD_GROUPS) {
    for (const name of plans[fromGroup][fromBlock]) {
      if (FIELD_GROUPS.some((toGroup) => toGroup !== fromGroup && plans[toGroup][toBlock].includes(name))) switches += 1;
    }
  }
  return switches;
}

function optimizeGlobalPositionSwitches(game: Game, roster: Player[], formation: FormationCounts, plans: PlannedGroups, startBlock: number): void {
  const firstBlock = Math.max(0, startBlock - 1);
  const totalSwitches = (): number => {
    let score = 0;
    for (let blockIndex = Math.max(1, firstBlock); blockIndex < game.total_blocks; blockIndex += 1) score += groupSwitchCount(plans, blockIndex - 1, blockIndex);
    return score;
  };
  const exactGroupsRemainLegal = (blockIndex: number): boolean => FIELD_GROUPS.every((group) => !formation[group] || completeExactAssignmentExists(roster, plans[group][blockIndex], formationSlots(formation)[group], group));

  // Search globally for legal swaps that reduce total broad-position changes.
  let improved = true;
  for (let pass = 0; improved && pass < game.total_blocks * FIELD_GROUPS.length; pass += 1) {
    improved = false;
    for (let blockIndex = firstBlock; blockIndex < game.total_blocks; blockIndex += 1) {
      const before = totalSwitches();
      let best: { left: 'D' | 'M' | 'F'; leftIndex: number; right: 'D' | 'M' | 'F'; rightIndex: number; score: number } | null = null;
      for (let leftGroupIndex = 0; leftGroupIndex < FIELD_GROUPS.length; leftGroupIndex += 1) {
        for (let rightGroupIndex = leftGroupIndex + 1; rightGroupIndex < FIELD_GROUPS.length; rightGroupIndex += 1) {
          const leftGroup = FIELD_GROUPS[leftGroupIndex];
          const rightGroup = FIELD_GROUPS[rightGroupIndex];
          for (let leftIndex = 0; leftIndex < plans[leftGroup][blockIndex].length; leftIndex += 1) {
            const leftName = plans[leftGroup][blockIndex][leftIndex];
            if (!canCoverGroup(game, roster, leftName, rightGroup)) continue;
            for (let rightIndex = 0; rightIndex < plans[rightGroup][blockIndex].length; rightIndex += 1) {
              const rightName = plans[rightGroup][blockIndex][rightIndex];
              if (!canCoverGroup(game, roster, rightName, leftGroup)) continue;
              plans[leftGroup][blockIndex][leftIndex] = rightName;
              plans[rightGroup][blockIndex][rightIndex] = leftName;
              const after = exactGroupsRemainLegal(blockIndex) ? totalSwitches() : Number.POSITIVE_INFINITY;
              plans[leftGroup][blockIndex][leftIndex] = leftName;
              plans[rightGroup][blockIndex][rightIndex] = rightName;
              if (after < before && (!best || after < best.score)) best = { left: leftGroup, leftIndex, right: rightGroup, rightIndex, score: after };
            }
          }
        }
      }
      if (best) {
        const leftName = plans[best.left][blockIndex][best.leftIndex];
        plans[best.left][blockIndex][best.leftIndex] = plans[best.right][blockIndex][best.rightIndex];
        plans[best.right][blockIndex][best.rightIndex] = leftName;
        improved = true;
      }
    }
  }
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  const result: T[][] = [];
  for (let index = 0; index <= items.length - size; index += 1) {
    for (const suffix of combinations(items.slice(index + 1), size - 1)) result.push([items[index], ...suffix]);
  }
  return result;
}

function planPositionGroups(game: Game, roster: Player[], formation: FormationCounts, goalkeeperNames: string[], startBlock: number): PlannedGroups {
  const positions = (['D', 'M', 'F'] as const).filter((position) => formation[position] > 0);
  const plans: PlannedGroups = { D: Array.from({ length: game.total_blocks }, () => []), M: Array.from({ length: game.total_blocks }, () => []), F: Array.from({ length: game.total_blocks }, () => []) };
  const reserved = goalkeeperNames.map((name) => new Set(name ? [name] : []));
  const assignedGoalkeepers = new Set(goalkeeperNames.filter(Boolean));
  const rawCounts = new Map(roster.map((player) => [player.name, player.block_count]));
  const fieldCounts = new Map(roster.map((player) => [player.name, player.block_count]));
  for (const goalkeeperName of goalkeeperNames) {
    if (goalkeeperName) rawCounts.set(goalkeeperName, (rawCounts.get(goalkeeperName) ?? 0) + 1);
  }
  const halfCounts = new Map(roster.map((player) => [player.name, [...player.blocks_by_half] as [number, number]]));
  const midpoint = halfLength(game.total_blocks);
  const coreGroups = new Set<Player['group']>(['core', 'core_a', 'core_b']);
  const playersByName = new Map(roster.map((player) => [player.name, player]));
  const backupBlocks: Record<'D' | 'M' | 'F', Map<number, string[]>> = { D: new Map(), M: new Map(), F: new Map() };
  const usable = (player: Player, position: PositionGroup, blockIndex: number, ignoreLimits = false): boolean => {
    const half = blockHalf(blockIndex, game.total_blocks);
    return player.available && !reserved[blockIndex].has(player.name) &&
      (ignoreLimits || ((rawCounts.get(player.name) ?? 0) < player.hard_maximum_blocks && (halfCounts.get(player.name)?.[half] ?? 0) < player.max_blocks_per_half && (!assignedGoalkeepers.has(player.name) || (fieldCounts.get(player.name) ?? 0) < player.gk_field_maximum_blocks))) &&
      !player.forbidden_positions.includes(position);
  };
  const playerKey = (player: Player, position: PositionGroup, blockIndex: number, previous: Set<string>): [number, number, number, number, number, string] => {
    const half = blockHalf(blockIndex, game.total_blocks);
    const fieldMinimum = assignedGoalkeepers.has(player.name) ? player.gk_field_minimum_blocks : player.hard_minimum_blocks;
    const deficit = Math.max(0, fieldMinimum - (fieldCounts.get(player.name) ?? 0));
    const target = assignedGoalkeepers.has(player.name) ? player.gk_field_maximum_blocks : player.target_blocks;
    const targetDeficit = Math.max(0, target - (fieldCounts.get(player.name) ?? 0));
    const nonCore = !coreGroups.has(player.group);
    const tier = deficit > 0
      ? assignedGoalkeepers.has(player.name) ? 0 : nonCore ? 1 : 2
      : assignedGoalkeepers.has(player.name) ? 5 : nonCore ? 3 : 4;
    const urgency = player.group === 'developing' || player.group === 'developmental' ? 0.5 : 1;
    return [tier, positionalPriority(player, position, game.allow_emergency_positions), -(deficit || targetDeficit * urgency), previous.has(player.name) ? 0 : 1, halfCounts.get(player.name)?.[half] ?? 0, player.name];
  };
  const leavesFutureCoverage = (position: 'D' | 'M' | 'F', blockIndex: number, chosen: Player[], candidates: Player[]): boolean => {
    const simulatedRaw = new Map(rawCounts); const simulatedField = new Map(fieldCounts); const simulatedHalf = new Map([...halfCounts].map(([name, counts]) => [name, [...counts] as [number, number]]));
    for (const player of chosen) { simulatedRaw.set(player.name, (simulatedRaw.get(player.name) ?? 0) + 1); simulatedField.set(player.name, (simulatedField.get(player.name) ?? 0) + 1); const half = blockHalf(blockIndex, game.total_blocks); const counts = simulatedHalf.get(player.name) ?? [0, 0]; counts[half] += 1; simulatedHalf.set(player.name, counts); }
    for (let future = blockIndex + 1; future < game.total_blocks; future += 1) {
      const available = candidates.filter((player) => !reserved[future].has(player.name) && (simulatedRaw.get(player.name) ?? 0) < player.hard_maximum_blocks && (simulatedHalf.get(player.name)?.[blockHalf(future, game.total_blocks)] ?? 0) < player.max_blocks_per_half && (!assignedGoalkeepers.has(player.name) || (simulatedField.get(player.name) ?? 0) < player.gk_field_maximum_blocks));
      if (available.length < formation[position]) return false;
      const hasExactFutureChoice = combinations(available, formation[position]).some((choice) =>
        completeExactAssignmentExists(
          roster,
          choice.map((player) => player.name),
          formationSlots(formation)[position],
          position,
        ),
      );
      if (!hasExactFutureChoice) return false;
    }
    return true;
  };

  // Reserve declared backups before the normal groups consume them. This is
  // deliberately calculated per half, matching Python's capacity accounting.
  for (const position of positions) {
    const normalCandidates = eligiblePlayers(roster, position, game.allow_emergency_positions);
    const backups = backupEligiblePlayers(roster, position);
    for (const [half, indices] of [[0, Array.from({ length: midpoint }, (_, index) => index).filter((index) => index >= Math.max(0, startBlock - 1))], [1, Array.from({ length: game.total_blocks - midpoint }, (_, index) => index + midpoint).filter((index) => index >= Math.max(0, startBlock - 1))]] as const) {
      if (!indices.length || !backups.length) continue;
      const normalCapacity = normalCandidates.reduce((total, player) => total + Math.min(player.max_blocks_per_half, player.hard_maximum_blocks - (rawCounts.get(player.name) ?? 0)), 0);
      let required = Math.max(0, formation[position] * indices.length - normalCapacity);
      const capacity = new Map<string, number>(backups.map((player: Player) => [player.name, Math.min(player.max_blocks_per_half, player.hard_maximum_blocks - (rawCounts.get(player.name) ?? 0))]));
      let slot = 0;
      for (const player of [...backups].sort((left, right) => left.name.localeCompare(right.name))) {
        for (let count = 0; count < Math.min(capacity.get(player.name) ?? 0, required); count += 1) {
          const index = indices[indices.length - 1 - (slot % indices.length)];
          const planned = backupBlocks[position].get(index) ?? [];
          planned.push(player.name); backupBlocks[position].set(index, planned);
          slot += 1; required -= 1;
          if (!required) break;
        }
        if (!required) break;
      }
    }
  }
  let previous = new Set<string>();
  for (const position of [...positions].sort((left, right) => {
    const leftCount = eligiblePlayers(roster, left, game.allow_emergency_positions).length;
    const rightCount = eligiblePlayers(roster, right, game.allow_emergency_positions).length;
    return leftCount - rightCount || positions.indexOf(left) - positions.indexOf(right);
  })) {
    const needed = formation[position];
    const normalCandidates = eligiblePlayers(roster, position, false);
    const backupCandidates = backupEligiblePlayers(roster, position);
    const emergencyCandidates = game.allow_emergency_positions ? emergencyEligiblePlayers(roster, position) : [];
    const candidates = [...normalCandidates, ...backupCandidates.filter((player) => !normalCandidates.includes(player)), ...emergencyCandidates.filter((player) => !normalCandidates.includes(player) && !backupCandidates.includes(player))];
    for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
      const plannedBackupNames = new Set(backupBlocks[position].get(blockIndex) ?? []);
      const available = candidates.filter((player) => usable(player, position, blockIndex) && (!plannedBackupNames.size || normalCandidates.includes(player) || plannedBackupNames.has(player.name)));
      const ordered = [...available].sort((left, right) => {
        const leftKey = playerKey(left, position, blockIndex, previous); const rightKey = playerKey(right, position, blockIndex, previous);
        for (let index = 0; index < leftKey.length - 1; index += 1) if (leftKey[index] !== rightKey[index]) return (leftKey[index] as number) - (rightKey[index] as number);
        return String(leftKey[leftKey.length - 1]).localeCompare(String(rightKey[rightKey.length - 1]));
      });
      const requiredBackups = ordered.filter((player) => plannedBackupNames.has(player.name));
      const requiredCount = Math.max(0, needed - requiredBackups.length);
      const optional = ordered.filter((player) => !requiredBackups.includes(player));
      const candidateChoices = requiredBackups.length
        ? combinations(optional, requiredCount).map((choice) => [...requiredBackups, ...choice])
        : combinations(ordered, needed);
      const exactFeasibleChoices = candidateChoices.filter((choice) =>
        completeExactAssignmentExists(
          roster,
          choice.map((player) => player.name),
          formationSlots(formation)[position],
          position,
        ),
      );
      const choices = exactFeasibleChoices.filter((choice) => leavesFutureCoverage(position, blockIndex, choice, candidates));
      const compareKeys = (left: (number | string)[], right: (number | string)[]): number => {
        for (let index = 0; index < left.length; index += 1) {
          if (left[index] === right[index]) continue;
          if (typeof left[index] === 'number' && typeof right[index] === 'number') return (left[index] as number) - (right[index] as number);
          return String(left[index]).localeCompare(String(right[index]));
        }
        return 0;
      };
      const choiceKey = (choice: Player[]) => choice.map((player) => playerKey(player, position, blockIndex, previous)).sort(compareKeys);
      choices.sort((left, right) => {
        const leftKey = choiceKey(left); const rightKey = choiceKey(right);
        for (let index = 0; index < leftKey.length; index += 1) {
          const comparison = compareKeys(leftKey[index], rightKey[index]);
          if (comparison) return comparison;
        }
        return 0;
      });
      const chosen = choices[0] ?? exactFeasibleChoices[0] ?? [];
      plans[position][blockIndex] = chosen.map((player) => player.name);
      for (const player of chosen) {
        reserved[blockIndex].add(player.name); rawCounts.set(player.name, (rawCounts.get(player.name) ?? 0) + 1); fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
        const half = blockHalf(blockIndex, game.total_blocks); const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number]; counts[half] += 1; halfCounts.set(player.name, counts);
      }
      previous = new Set(plans[position][blockIndex]);
    }
  }
  const coreRestScore = (blockIndex: number): number => {
    const assigned = new Set(positions.flatMap((position) => plans[position][blockIndex]));
    const counts = new Map<PositionGroup, number>([['D', 0], ['M', 0], ['F', 0]]);
    for (const player of roster) if (player.available && coreGroups.has(player.group) && !assigned.has(player.name)) {
      for (const group of player.general_positions) if (group === 'D' || group === 'M' || group === 'F') counts.set(group, (counts.get(group) ?? 0) + 1);
      if (player.general_positions.includes(ANY_POSITION)) for (const group of ['D', 'M', 'F'] as const) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  };
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    let improved = true;
    while (improved) {
      improved = false;
      const before = coreRestScore(blockIndex);
      const assigned = new Set(positions.flatMap((position) => plans[position][blockIndex]));
      for (const position of positions) {
        for (const currentName of [...plans[position][blockIndex]]) {
          const current = roster.find((player) => player.name === currentName);
          if (!current || coreGroups.has(current.group)) continue;
          for (const rested of roster) {
            if (!rested.available || !coreGroups.has(rested.group) || assigned.has(rested.name) || rested.name === goalkeeperNames[blockIndex]) continue;
            if (!eligiblePlayers(roster, position, game.allow_emergency_positions).some((player) => player.name === rested.name)) continue;
            if (!usable(rested, position, blockIndex)) continue;
            const slot = plans[position][blockIndex].indexOf(currentName);
            plans[position][blockIndex][slot] = rested.name;
            if (coreRestScore(blockIndex) < before) {
              const half = blockHalf(blockIndex, game.total_blocks);
              rawCounts.set(current.name, (rawCounts.get(current.name) ?? 0) - 1);
              fieldCounts.set(current.name, (fieldCounts.get(current.name) ?? 0) - 1);
              const currentHalfCounts = halfCounts.get(current.name) ?? [0, 0] as [number, number]; currentHalfCounts[half] -= 1; halfCounts.set(current.name, currentHalfCounts);
              rawCounts.set(rested.name, (rawCounts.get(rested.name) ?? 0) + 1);
              fieldCounts.set(rested.name, (fieldCounts.get(rested.name) ?? 0) + 1);
              const restedHalfCounts = halfCounts.get(rested.name) ?? [0, 0] as [number, number]; restedHalfCounts[half] += 1; halfCounts.set(rested.name, restedHalfCounts);
              improved = true; break;
            }
            plans[position][blockIndex][slot] = currentName;
          }
          if (improved) break;
        }
        if (improved) break;
      }
    }
  }

  // Final-core lineup swaps: trade a non-core in the final block for a core
  // player from an earlier second-half block, preserving each group's slot.
  const finalBlock = game.total_blocks - 1;
  const secondHalfStart = midpoint;
  if (startBlock - 1 <= finalBlock) {
    const finalAssigned = new Set([goalkeeperNames[finalBlock], ...positions.flatMap((position) => plans[position][finalBlock])]);
    for (const position of positions) {
      const finalPlayers = plans[position][finalBlock];
      for (let finalSlot = 0; finalSlot < finalPlayers.length; finalSlot += 1) {
        const finalPlayer = playersByName.get(finalPlayers[finalSlot]);
        if (!finalPlayer || coreGroups.has(finalPlayer.group)) continue;
        let swapped = false;
        for (let blockIndex = secondHalfStart; blockIndex < finalBlock && !swapped; blockIndex += 1) {
          const sourceAssigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((group) => plans[group][blockIndex])]);
          const source = plans[position][blockIndex];
          for (let sourceSlot = 0; sourceSlot < source.length; sourceSlot += 1) {
            const core = playersByName.get(source[sourceSlot]);
            if (!core || !coreGroups.has(core.group) || finalAssigned.has(core.name) || sourceAssigned.has(finalPlayer.name)) continue;
            source[sourceSlot] = finalPlayer.name; finalPlayers[finalSlot] = core.name;
            finalAssigned.delete(finalPlayer.name); finalAssigned.add(core.name); swapped = true; break;
          }
        }
      }
    }
  }

  // Rescue a short group by moving a compatible player from another group and
  // replacing them there with a legal, unused player.
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    const half = blockHalf(blockIndex, game.total_blocks);
    for (const position of positions) {
      while (plans[position][blockIndex].length < formation[position]) {
        let rescued = false;
        for (const other of positions) {
          if (other === position) continue;
          for (const candidateName of [...plans[other][blockIndex]]) {
            const candidate = playersByName.get(candidateName);
            const canCoverPosition = candidate && (
              eligiblePlayers(roster, position, game.allow_emergency_positions).some((player) => player.name === candidate.name) ||
              backupEligiblePlayers(roster, position).some((player) => player.name === candidate.name)
            );
            if (!candidate || !canCoverPosition) continue;
            const replacement = eligiblePlayers(roster, other, game.allow_emergency_positions)
              .filter((player) => player.name !== candidateName && !plans[other][blockIndex].includes(player.name) && usable(player, other, blockIndex))
              .sort((left, right) => playerKey(left, other, blockIndex, new Set()).join('|').localeCompare(playerKey(right, other, blockIndex, new Set()).join('|')))[0];
            if (!replacement) continue;
            plans[other][blockIndex] = plans[other][blockIndex].filter((name) => name !== candidateName).concat(replacement.name);
            rawCounts.set(replacement.name, (rawCounts.get(replacement.name) ?? 0) + 1);
            fieldCounts.set(replacement.name, (fieldCounts.get(replacement.name) ?? 0) + 1);
            const replacementHalfCounts = halfCounts.get(replacement.name) ?? [0, 0] as [number, number]; replacementHalfCounts[half] += 1; halfCounts.set(replacement.name, replacementHalfCounts);
            plans[position][blockIndex].push(candidateName); rescued = true; break;
          }
          if (rescued) break;
        }
        if (!rescued) break;
      }
    }
  }

  // Last resort: fill every remaining slot with any available non-excluded
  // player, retaining limits whenever a legal candidate exists.
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    const half = blockHalf(blockIndex, game.total_blocks);
    for (const position of positions) {
      while (plans[position][blockIndex].length < formation[position]) {
        const assigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((group) => plans[group][blockIndex])]);
        const eligible = new Set([
          ...eligiblePlayers(roster, position, game.allow_emergency_positions),
          ...backupEligiblePlayers(roster, position),
          ...(game.allow_emergency_positions ? emergencyEligiblePlayers(roster, position) : []),
        ].map((player) => player.name));
        const candidates = roster.filter((player) => eligible.has(player.name) && player.available && !assigned.has(player.name) && !player.excluded_positions.includes(position) && player.name !== goalkeeperNames[blockIndex]);
        const legal = candidates.filter((player) => usable(player, position, blockIndex));
        const pool = legal.length ? legal : candidates;
        const player = [...pool].sort((left, right) => (Math.max(0, left.hard_minimum_blocks - left.block_count) - Math.max(0, right.hard_minimum_blocks - right.block_count)) * -1 || left.block_count - right.block_count || left.name.localeCompare(right.name))[0];
        if (!player) break;
        plans[position][blockIndex].push(player.name);
        const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number]; counts[half] += 1; halfCounts.set(player.name, counts);
        rawCounts.set(player.name, (rawCounts.get(player.name) ?? 0) + 1); fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
      }
    }
  }

  // Repair avoidable minimum misses after all formation slots are filled. A
  // swap is accepted only when the under-minimum player can legally cover the
  // group's exact slots and the donor remains above their own minimum.
  const plannedCount = (name: string): number => plans.D.flat().concat(plans.M.flat(), plans.F.flat()).filter((playerName) => playerName === name).length;
  for (const position of positions) {
    const candidates = roster
      .filter((player) => player.available && !assignedGoalkeepers.has(player.name) && canCoverGroup(game, roster, player.name, position))
      .sort((left, right) => (Math.max(0, right.hard_minimum_blocks - plannedCount(right.name)) - Math.max(0, left.hard_minimum_blocks - plannedCount(left.name))) || left.name.localeCompare(right.name));
    for (const deficit of candidates) {
      while (plannedCount(deficit.name) < deficit.hard_minimum_blocks) {
        let repaired = false;
        for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks && !repaired; blockIndex += 1) {
          const assignedElsewhere = new Set(positions.flatMap((group) => plans[group][blockIndex]));
          if (assignedElsewhere.has(deficit.name)) continue;
          const current = plans[position][blockIndex];
          for (const donorName of [...current]) {
            const donor = playersByName.get(donorName);
            if (!donor || plannedCount(donor.name) <= donor.hard_minimum_blocks) continue;
            const replacement = current.map((name) => name === donor.name ? deficit.name : name);
            if (!completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position)) continue;
            plans[position][blockIndex] = replacement;
            repaired = true;
            break;
          }
        }
        if (!repaired) break;
      }
    }
  }
  optimizeGlobalPositionSwitches(game, roster, formation, plans, startBlock);
  return plans;
}

export function buildTimeline(game: Game, roster: Player[], startBlock = 1, frozenTimeline: ScheduleBlock[] = []): RotationResult {
  const result: RotationResult = { timeline: [...frozenTimeline], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, formation: game.formation, gk_assignment: game.gk_assignment } };
  const formation = parseFormation(game.formation); const slots = formationSlots(formation); const goalkeepers: Array<Player | null> = [];
  for (let block = 1; block <= game.total_blocks; block++) goalkeepers.push(block < startBlock ? roster.find((player) => player.name === frozenTimeline[block - 1]?.GK) ?? null : chooseGk(game, roster, block));
  const planned = planPositionGroups(game, roster, formation, goalkeepers.map((player) => player?.name ?? ''), startBlock);
  let previousPositions: Record<string, string> = startBlock > 1 ? { ...(frozenTimeline[startBlock - 2]?.positions ?? {}) } : {};
  for (let block = startBlock; block <= game.total_blocks; block++) {
    const half: 0 | 1 = block <= Math.ceil(game.total_blocks / 2) ? 0 : 1; const gk = goalkeepers[block - 1]; const used = new Set(gk ? [gk.name] : []);
    const assignment = { GK: gk?.name ?? 'NO GK AVAILABLE', D: [] as string[], M: [] as string[], F: [] as string[], bench: [] as string[], positions: { GK: gk?.name ?? 'NO GK AVAILABLE' } };
    for (const group of ['D', 'M', 'F'] as const) {
      const chosen = planned[group][block - 1].map((name) => roster.find((player) => player.name === name)).filter((player): player is Player => player !== undefined && !used.has(player.name)); assignment[group] = chosen.map((player) => player.name); chosen.forEach((player) => used.add(player.name));
      const exactAssignment = assignExactSlots(roster, assignment[group], slots[group], group, previousPositions, game.season_position_starts);
      Object.assign(assignment.positions, exactAssignment);
      if (Object.values(exactAssignment).some((name) => name === 'UNASSIGNED')) result.errors.push(`Block ${block}: ${group} players cannot form a complete legal exact-slot assignment.`);
      if (chosen.length < formation[group]) result.errors.push(`Block ${block}: ${group} requires ${formation[group]} players but only ${chosen.length} were assigned.`);
    }
    for (const player of roster) if (!used.has(player.name)) assignment.bench.push(player.name);
    previousPositions = { ...assignment.positions };
    applyBlockToStats(roster, assignment, half); if (!gk) result.errors.push(`Block ${block}: no goalkeeper was assigned.`);
    result.timeline.push(assignment);
  }
  optimizeExactSlotSwitches(game, roster, result.timeline, slots, startBlock);
  result.movement_metrics = calculateMovementMetrics(result.timeline, game.total_blocks, roster, slots);
  result.errors = [...new Set([...result.errors, ...validateTimeline(roster, result.timeline, formation, slots)])];
  return result;
}
