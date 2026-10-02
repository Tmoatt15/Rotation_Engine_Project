import type { Game, MovementMetrics, Player, PositionGroup, QuotaFeasibilityMetadata, RotationResult, ScheduleBlock } from './models';
import { ANY_POSITION, backupCoversPosition, backupEligiblePlayers, CENTRAL_DEFENSE_ZONE, CENTRAL_MIDFIELD_ZONE, eligiblePlayers, exclusionBlocksSlot, generalPositionAllowsGroup, positionalPriority, POSITION_GROUP_BY_SLOT, STRIKER_ZONE } from './positional';

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

function needsEmergencyFieldAssignment(game: Game, roster: Player[], formation: FormationCounts, goalkeeperName: string): boolean {
  if (!game.allow_emergency_assignments) return false;
  const requiredFieldPlayers = formation.D + formation.M + formation.F;
  const availableFieldPlayers = roster.filter((player) => player.available && player.name !== goalkeeperName && !player.primary_positions.some((position) => position.toUpperCase() === 'GK')).length;
  return availableFieldPlayers < requiredFieldPlayers;
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
  const half = blockNumber <= halfLength(game.total_blocks) ? 0 : 1;
  const requested = half === 0 ? (game.first_half_gk ?? game.gk_assignment) : (game.second_half_gk ?? game.gk_assignment);
  if (!requested) return null;
  return goalkeepers.find((player) => player.name.trim().toLowerCase() === requested.trim().toLowerCase()) ?? null;
}

function goalkeeperSelectionErrors(game: Game, roster: Player[]): string[] {
  if (game.has_goalkeeper === false) return [];
  return ([['first half', game.first_half_gk ?? game.gk_assignment], ['second half', game.second_half_gk ?? game.gk_assignment]] as const).flatMap(([half, name]) => {
    if (!name?.trim()) return [`Coach must select a goalkeeper for the ${half}.`];
    const player = roster.find((candidate) => candidate.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!player) return [`The selected ${half} goalkeeper '${name}' is not on the roster.`];
    if (!player.available) return [`The selected ${half} goalkeeper '${name}' is unavailable.`];
    if (!player.primary_positions.some((position) => position.toUpperCase() === 'GK')) return [`The selected ${half} goalkeeper '${name}' is not GK-eligible.`];
    return [];
  });
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
  if (goalkeeper) { goalkeeper.block_count += 1; goalkeeper.gk_blocks += 1; goalkeeper.blocks_by_half[half] += 1; goalkeeper.position_usage.GK += 1; }
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

const rosterPlayerMaps = new WeakMap<Player[], Map<string, Player>>();

export function completeExactAssignmentExists(roster: Player[], names: string[], slots: string[], group: PositionGroup): boolean {
  const playerByName = rosterPlayerMaps.get(roster) ?? new Map(roster.map((player) => [player.name, player]));
  rosterPlayerMaps.set(roster, playerByName);
  const players = names.map((name) => playerByName.get(name)).filter((player): player is Player => Boolean(player));
  if (players.length !== slots.length) return false;
  const candidatesBySlot = new Map(slots.map((slot) => [slot, players
    .filter((player) => canCoverSlot(player, slot, group))
    .sort((left, right) => left.name.localeCompare(right.name))]));
  const orderedSlots = [...slots].sort((left, right) => {
    const difference = (candidatesBySlot.get(left)?.length ?? 0) - (candidatesBySlot.get(right)?.length ?? 0);
    return difference || left.localeCompare(right);
  });
  const assignedSlotByPlayer = new Map<string, string>();

  const augment = (slot: string, visited: Set<string>): boolean => {
    for (const player of candidatesBySlot.get(slot) ?? []) {
      if (visited.has(player.name)) continue;
      visited.add(player.name);
      const assignedSlot = assignedSlotByPlayer.get(player.name);
      if (!assignedSlot || augment(assignedSlot, visited)) {
        assignedSlotByPlayer.set(player.name, slot);
        return true;
      }
    }
    return false;
  };

  return orderedSlots.every((slot) => augment(slot, new Set<string>()));
}

export function assignExactSlots(roster: Player[], names: string[], slots: string[], group: PositionGroup, previous: Record<string, string>, seasonStarts: Record<string, Record<string, number>> = {}, allowUnrestricted = false): Record<string, string> {
  const players = names.map((name) => roster.find((player) => player.name === name)).filter((player): player is Player => Boolean(player));
  if (allowUnrestricted) return Object.fromEntries(slots.map((slot, index) => [slot, players[index]?.name ?? 'UNASSIGNED']));
  const candidatesBySlot = new Map(slots.map((slot) => [slot, players.filter((player) => !exclusionBlocksSlot(player.forbidden_positions, slot)
    && (allowUnrestricted || canCoverSlot(player, slot, group)))]));
  const orderedSlots = [...slots].sort((left, right) => (candidatesBySlot.get(left)?.length ?? 0) - (candidatesBySlot.get(right)?.length ?? 0));
  let bestAssignment: Record<string, string> | null = null;
  let bestScore: [number, number, number, number, string] | null = null;

  const scoreAssignment = (assignment: Record<string, string>): [number, number, number, number, string] => {
    let stayed = 0;
    let primary = 0;
    let general = 0;
    let historicalStarts = 0;
    for (const slot of slots) {
      const player = players.find((candidate) => candidate.name === assignment[slot]);
      if (!player) continue;
      if (previous[player.name] === slot) stayed += 1;
      if (player.primary_positions.includes(slot)) primary += 1;
      else if (generalPositionAllowsGroup(player, group)) general += 1;
      historicalStarts += seasonStarts[player.name]?.[slot] ?? 0;
    }
    return [primary, general, stayed, -historicalStarts, slots.map((slot) => assignment[slot]).join('|')];
  };

  const isBetter = (left: [number, number, number, number, string], right: [number, number, number, number, string] | null): boolean => {
    if (!right) return true;
    for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return left[index] > right[index];
    return left[4] < right[4];
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
  return !exclusionBlocksSlot(player.forbidden_positions, slot) && (
    player.primary_positions.includes(slot) ||
    (player.primary_positions.includes(ANY_POSITION) && generalPositionAllowsGroup(player, group)) ||
    equivalentCentralMidfield ||
    equivalentCentralDefense ||
    backupCoversPosition(player, slot) ||
    player.general_positions.includes(group)
  );
}

function movementMetricScore(metrics: MovementMetrics): [number, number, number, number, number] {
  return [-metrics.primary_assignments, metrics.exact_slot_switches, metrics.turnovers, metrics.backup_assignments, metrics.emergency_assignments];
}

function compareMetricScores(left: MovementMetrics, right: MovementMetrics): number {
  const leftScore = movementMetricScore(left);
  const rightScore = movementMetricScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return leftScore[index] - rightScore[index];
  }
  return 0;
}

type AssignmentQuality = 'primary' | 'general' | 'backup' | 'emergency';

function assignmentQuality(player: Player | undefined, slot: string, emergencyActive: boolean): AssignmentQuality | null {
  if (!player || player.name === 'UNASSIGNED') return null;
  const normalizedSlot = slot.trim().toUpperCase();
  if (player.primary_positions.some((position) => position.trim().toUpperCase() === normalizedSlot)) return 'primary';
  const primaryZone = normalizedSlot === 'GK'
    ? undefined
    : [CENTRAL_MIDFIELD_ZONE, CENTRAL_DEFENSE_ZONE, STRIKER_ZONE].find((zone) => zone.has(normalizedSlot));
  if (primaryZone && player.primary_positions.some((position) => primaryZone.has(position.trim().toUpperCase()))) return 'primary';
  const group = POSITION_GROUP_BY_SLOT[normalizedSlot];
  if (group && generalPositionAllowsGroup(player, group)) return 'general';
  if (backupCoversPosition(player, slot)) return 'backup';
  return emergencyActive ? 'emergency' : null;
}

export function calculateMovementMetrics(
  timeline: ScheduleBlock[],
  totalBlocks: number,
  roster: Player[] = [],
  slots?: Record<'D' | 'M' | 'F', string[]>,
  allowEmergencyAssignments = false,
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
    general_assignments: 0,
    backup_assignments: 0,
    emergency_assignments: 0,
    by_half: [{ turnovers: 0, exact_slot_switches: 0, group_switches: 0 }, { turnovers: 0, exact_slot_switches: 0, group_switches: 0 }],
  };
  const playerByName = new Map(roster.map((player) => [player.name, player]));
  for (const block of timeline) {
    const requiredFieldSlots = FIELD_GROUPS.reduce((total, group) => total + groupsBySlot[group].length, 0);
    const availableNonGoalkeepers = roster.filter((player) => player.available && !player.primary_positions.some((position) => position.toUpperCase() === 'GK')).length;
    const emergencyActive = allowEmergencyAssignments && availableNonGoalkeepers < requiredFieldSlots;
    for (const [slot, name] of Object.entries(block.positions ?? {})) {
      const quality = assignmentQuality(playerByName.get(name), slot, emergencyActive);
      if (quality === 'primary') metrics.primary_assignments += 1;
      if (quality === 'general') metrics.general_assignments += 1;
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

export function optimizeExactSlotSwitches(game: Game, roster: Player[], timeline: ScheduleBlock[], slots: Record<'D' | 'M' | 'F', string[]>, startBlock: number): void {
  const firstBlock = Math.max(0, startBlock - 1);
  let improved = true;
  for (let pass = 0; improved && pass < game.total_blocks * FIELD_GROUPS.length; pass += 1) {
    improved = false;
    const before = calculateMovementMetrics(timeline, game.total_blocks, roster, slots);
    let bestChanges: Array<{ block: number; assignment: Record<string, string> }> = [];
    let bestGroup: 'D' | 'M' | 'F' | null = null;
    let bestMetrics = before;
    for (let blockIndex = firstBlock; blockIndex < timeline.length; blockIndex += 1) {
      for (const group of FIELD_GROUPS) {
        const groupSlots = slots[group];
        const assignmentsForBlock = (index: number): Record<string, string>[] => {
          const names = groupSlots.map((slot) => timeline[index].positions[slot]).filter((name) => name && name !== 'UNASSIGNED');
          if (names.length !== groupSlots.length || new Set(names).size !== names.length) return [];
          return legalAssignments(names, groupSlots, roster, group);
        };
        const firstAssignments = assignmentsForBlock(blockIndex);
        for (const candidate of firstAssignments) {
          const current = Object.fromEntries(groupSlots.map((slot) => [slot, timeline[blockIndex].positions[slot]]));
          if (groupSlots.every((slot) => candidate[slot] === current[slot])) continue;
          Object.assign(timeline[blockIndex].positions, candidate);
          const after = calculateMovementMetrics(timeline, game.total_blocks, roster, slots);
          Object.assign(timeline[blockIndex].positions, current);
          if (compareMetricScores(after, bestMetrics) < 0) {
            bestMetrics = after;
            bestChanges = [{ block: blockIndex, assignment: candidate }];
            bestGroup = group;
          }
        }

        const nextBlock = blockIndex + 1;
        if (nextBlock >= timeline.length || !isSameHalf(blockIndex, nextBlock, game.total_blocks)) continue;
        const nextAssignments = assignmentsForBlock(nextBlock);
        for (const firstCandidate of firstAssignments) for (const nextCandidate of nextAssignments) {
          const current = [
            Object.fromEntries(groupSlots.map((slot) => [slot, timeline[blockIndex].positions[slot]])),
            Object.fromEntries(groupSlots.map((slot) => [slot, timeline[nextBlock].positions[slot]])),
          ];
          if (groupSlots.every((slot) => firstCandidate[slot] === current[0][slot])
            && groupSlots.every((slot) => nextCandidate[slot] === current[1][slot])) continue;
          Object.assign(timeline[blockIndex].positions, firstCandidate);
          Object.assign(timeline[nextBlock].positions, nextCandidate);
          const after = calculateMovementMetrics(timeline, game.total_blocks, roster, slots);
          Object.assign(timeline[blockIndex].positions, current[0]);
          Object.assign(timeline[nextBlock].positions, current[1]);
          if (compareMetricScores(after, bestMetrics) < 0) {
            bestMetrics = after;
            bestChanges = [{ block: blockIndex, assignment: firstCandidate }, { block: nextBlock, assignment: nextCandidate }];
            bestGroup = group;
          }
        }
      }
    }
    if (bestChanges.length && bestGroup) {
      for (const change of bestChanges) Object.assign(timeline[change.block].positions, change.assignment);
      improved = true;
    }
  }
}

export function validateTimeline(roster: Player[], timeline: ScheduleBlock[], formation: FormationCounts, slots: Record<'D' | 'M' | 'F', string[]>, totalBlocks = timeline.length): string[] {
  const errors: string[] = [];
  const totals = new Map<string, number>();
  const fieldHalfTotals = new Map<string, [number, number]>();
  for (const [index, block] of timeline.entries()) {
    const blockNumber = index + 1;
    const expectedSlots = (block.GK ? ['GK'] : []).concat(FIELD_GROUPS.flatMap((group) => slots[group]));
    const assigned = expectedSlots.map((slot) => block.positions?.[slot] ?? '').filter(Boolean);
    const duplicateCheck = assigned.filter((name) => name !== 'UNASSIGNED' && name !== 'NO GK AVAILABLE');
    if (new Set(duplicateCheck).size !== duplicateCheck.length) errors.push(`Block ${blockNumber}: duplicate players are assigned on the field.`);
    if (assigned.some((name) => name === 'UNASSIGNED' || name === 'NO GK AVAILABLE')) errors.push(`Block ${blockNumber}: one or more required slots are unassigned.`);
    for (const name of assigned) {
      if (name === 'UNASSIGNED' || name === 'NO GK AVAILABLE') continue;
      totals.set(name, (totals.get(name) ?? 0) + 1);
    }
    for (const name of [...block.D, ...block.M, ...block.F]) {
      if (name === 'UNASSIGNED' || name === 'NO GK AVAILABLE') continue;
      const counts = fieldHalfTotals.get(name) ?? [0, 0];
      counts[blockHalf(index, totalBlocks)] += 1;
      fieldHalfTotals.set(name, counts);
    }
    for (const group of FIELD_GROUPS) {
      if (block[group].length !== formation[group]) errors.push(`Block ${blockNumber}: ${group} requires ${formation[group]} players but has ${block[group].length}.`);
      if (block[group].length === formation[group] && !completeExactAssignmentExists(roster, block[group], slots[group], group)) errors.push(`Block ${blockNumber}: ${group} players cannot form a complete legal exact-slot assignment.`);
      if (block[group].some((name) => !block.positions || !Object.values(block.positions).includes(name))) errors.push(`Block ${blockNumber}: ${group} assignment is missing from exact positions.`);
    }
  }
  for (const player of roster) {
    const total = totals.get(player.name) ?? 0;
    const halves = fieldHalfTotals.get(player.name) ?? [0, 0];
    const availableGoalkeepers = roster.filter((candidate) => candidate.available && candidate.primary_positions.includes('GK'));
    const soleGoalkeeper = player.primary_positions.includes('GK') && availableGoalkeepers.length === 1;
    if (!soleGoalkeeper && total > player.hard_maximum_blocks) errors.push(`${player.name} exceeds hard maximum by ${total - player.hard_maximum_blocks} blocks.`);
    for (const half of [0, 1] as const) if (halves[half] > player.max_blocks_per_half) errors.push(`${player.name} exceeds the half ${half + 1} maximum by ${halves[half] - player.max_blocks_per_half} blocks.`);
  }
  return errors;
}

export function estimateAdditionalPlayersNeeded(
  timeline: ScheduleBlock[],
  formation: FormationCounts,
  totalBlocks: number,
): string[] {
  const missingByGroup: Record<'D' | 'M' | 'F', [number, number]> = { D: [0, 0], M: [0, 0], F: [0, 0] };
  const slots = formationSlots(formation);
  for (const [index, block] of timeline.entries()) {
    const half = blockHalf(index, totalBlocks);
    for (const group of FIELD_GROUPS) {
      for (const slot of slots[group]) if (!block.positions?.[slot] || block.positions[slot] === 'UNASSIGNED') missingByGroup[group][half] += 1;
    }
  }

  const labels: Record<'D' | 'M' | 'F', string> = { D: 'Defender', M: 'Midfielder', F: 'Forward' };
  const standardMaximum = Math.max(1, Math.ceil(totalBlocks * 0.8));
  const standardHalfMaximum = Math.max(1, Math.ceil(standardMaximum / 2));
  return FIELD_GROUPS.flatMap((group) => {
    const [firstHalfMissing, secondHalfMissing] = missingByGroup[group];
    if (!firstHalfMissing && !secondHalfMissing) return [];
    const neededForHalves = Math.max(Math.ceil(firstHalfMissing / standardHalfMaximum), Math.ceil(secondHalfMissing / standardHalfMaximum));
    const neededOverall = Math.ceil((firstHalfMissing + secondHalfMissing) / standardMaximum);
    const needed = Math.max(neededForHalves, neededOverall);
    const label = labels[group];
    return [`Please assign ${needed} more ${label}${needed === 1 ? '' : 's'} to successfully complete this schedule.`];
  });
}

function chooseFieldPlayers(game: Game, roster: Player[], group: PositionGroup, needed: number, used: Set<string>, half: 0 | 1, previous: Set<string>): Player[] {
  const candidates = eligiblePlayers(roster, group).filter((player) => !used.has(player.name) && player.block_count < player.hard_maximum_blocks && player.blocks_by_half[half] < player.max_blocks_per_half);
  candidates.sort((left, right) => {
    const deficit = (player: Player) => Math.max(0, player.hard_minimum_blocks - player.block_count);
    const target = (player: Player) => Math.max(0, player.target_blocks - player.block_count);
    return (deficit(right) - deficit(left)) || (positionalPriority(left, group) - positionalPriority(right, group)) || (target(right) - target(left)) || (previous.has(left.name) ? -1 : 1) || left.block_count - right.block_count || left.name.localeCompare(right.name);
  });
  return candidates.slice(0, needed);
}

type PlannedGroups = Record<'D' | 'M' | 'F', string[][]>;

const FIELD_GROUPS: Array<'D' | 'M' | 'F'> = ['D', 'M', 'F'];
const CORE_GROUPS = new Set<Player['group']>(['core', 'core_a', 'core_b']);

type CoreReservations = {
  byBlock: Array<Set<string>>;
  byGroupAndBlock: Record<'D' | 'M' | 'F', string[][]>;
};

type EndpointLineup = {
  groups: Record<'D' | 'M' | 'F', string[]>;
  assignedCore: Set<string>;
};

function endpointAssignmentTier(player: Player, slot: string, group: PositionGroup): 0 | 1 | 2 | null {
  if (exclusionBlocksSlot(player.forbidden_positions, slot)) return null;
  if (player.primary_positions.includes(slot) && player.primary_positions.some((position) => position.toUpperCase() !== ANY_POSITION)) return 0;
  if (generalPositionAllowsGroup(player, group)) return 1;
  if (backupCoversPosition(player, slot)) return 2;
  return null;
}

function solveEndpointLineup(roster: Player[], formation: FormationCounts, goalkeeperName: string, seasonStarts: Record<string, Record<string, number>> = {}, preferredNames = new Set<string>()): EndpointLineup {
  const slots = formationSlots(formation);
  const fieldSlots = FIELD_GROUPS.flatMap((group) => slots[group].map((slot) => ({ group, slot })));
  const corePlayers = roster.filter((player) => player.available && CORE_GROUPS.has(player.group) && player.name !== goalkeeperName);
  let best: { assignment: Map<string, { group: PositionGroup; slot: string; tier: number }>; score: [number, number, number, number, string] } | null = null;

  const compare = (left: [number, number, number, number, string], right: [number, number, number, number, string]): number => {
    for (let index = 0; index < 4; index += 1) if (left[index] !== right[index]) return (right[index] as number) - (left[index] as number);
    return left[4].localeCompare(right[4]);
  };

  const search = (index: number, usedSlots: Set<string>, assignment: Map<string, { group: PositionGroup; slot: string; tier: number }>): void => {
    if (index === corePlayers.length) {
      let primary = 0; let general = 0; let backup = 0;
      for (const value of assignment.values()) {
        if (value.tier === 0) primary += 1;
        else if (value.tier === 1) general += 1;
        else backup += 1;
      }
      const score: [number, number, number, number, string] = [assignment.size, primary, general, -backup, [...assignment.keys()].sort().join('|')];
      if (!best || compare(score, best.score) < 0) best = { assignment: new Map(assignment), score };
      return;
    }
    const player = corePlayers[index];
    const choices: Array<{ group: 'D' | 'M' | 'F'; slot: string; tier: 0 | 1 | 2 }> = [];
    for (const { group, slot } of fieldSlots) {
      const tier = endpointAssignmentTier(player, slot, group);
      if (tier !== null && !usedSlots.has(slot)) choices.push({ group, slot, tier });
    }
    for (const choice of choices) {
      usedSlots.add(choice.slot); assignment.set(player.name, choice);
      search(index + 1, usedSlots, assignment);
      assignment.delete(player.name); usedSlots.delete(choice.slot);
    }
    search(index + 1, usedSlots, assignment);
  };
  search(0, new Set<string>(), new Map());

  const groups: Record<'D' | 'M' | 'F', string[]> = { D: [], M: [], F: [] };
  const assignedCore = new Set<string>();
  const selectedAssignment: Map<string, { group: 'D' | 'M' | 'F'; slot: string; tier: number }> = best
    ? (best as { assignment: Map<string, { group: 'D' | 'M' | 'F'; slot: string; tier: number }> }).assignment
    : new Map<string, { group: 'D' | 'M' | 'F'; slot: string; tier: number }>();
  for (const [name, value] of selectedAssignment) { groups[value.group].push(name); assignedCore.add(name); }
  const used = new Set(assignedCore);
  const usedSlots = new Set([...selectedAssignment.values()].map((value) => value.slot));
  const remainingSlots = FIELD_GROUPS.flatMap((group) => slots[group]
    .filter((slot) => !usedSlots.has(slot))
    .map((slot) => ({ group, slot })));
  const nonCore = roster
    .filter((player) => player.available && player.name !== goalkeeperName && !used.has(player.name) && !CORE_GROUPS.has(player.group))
    .sort((left, right) => {
      const leftStarts = Object.values(seasonStarts[left.name] ?? {}).reduce((sum, count) => sum + count, 0);
      const rightStarts = Object.values(seasonStarts[right.name] ?? {}).reduce((sum, count) => sum + count, 0);
      return Number(preferredNames.has(right.name)) - Number(preferredNames.has(left.name))
        || leftStarts - rightStarts
        || left.name.localeCompare(right.name);
    });
  const fill = (index: number): boolean => {
    if (index === remainingSlots.length) return FIELD_GROUPS.every((group) => groups[group].length === formation[group]
      && completeExactAssignmentExists(roster, groups[group], slots[group], group));
    const { group, slot } = remainingSlots[index];
    for (const player of nonCore) {
      if (used.has(player.name) || endpointAssignmentTier(player, slot, group) === null) continue;
      used.add(player.name); groups[group].push(player.name);
      if (fill(index + 1)) return true;
      groups[group].pop(); used.delete(player.name);
    }
    return false;
  };
  fill(0);
  return { groups, assignedCore };
}

function reserveCoreBlocks(
  game: Game,
  roster: Player[],
  formation: FormationCounts,
  goalkeeperNames: string[],
  totalBlocks: number,
  shortageMode = false,
): CoreReservations {
  const byBlock = Array.from({ length: totalBlocks }, () => new Set<string>());
  const byGroupAndBlock: CoreReservations['byGroupAndBlock'] = {
    D: Array.from({ length: totalBlocks }, () => []),
    M: Array.from({ length: totalBlocks }, () => []),
    F: Array.from({ length: totalBlocks }, () => []),
  };
  const fieldCounts = new Map<string, number>();
  const halfCounts = new Map<string, [number, number]>();
  const midpoint = halfLength(totalBlocks);
  const corePlayers = roster.filter((player) => player.available && CORE_GROUPS.has(player.group));

  for (const player of corePlayers) {
    fieldCounts.set(player.name, 0);
    halfCounts.set(player.name, [0, 0]);
  }
  for (const [blockIndex, goalkeeperName] of goalkeeperNames.entries()) {
    const goalkeeper = roster.find((player) => player.name === goalkeeperName);
    if (!goalkeeper || !CORE_GROUPS.has(goalkeeper.group)) continue;
    const half = blockHalf(blockIndex, totalBlocks);
    const counts = halfCounts.get(goalkeeperName) ?? [0, 0] as [number, number];
    counts[half] += 1;
    halfCounts.set(goalkeeperName, counts);
  }

  const blockOrder = totalBlocks === 1
    ? [0]
    : [0, totalBlocks - 1, ...Array.from({ length: totalBlocks - 2 }, (_, index) => index + 1)];
  for (const blockIndex of blockOrder) {
    const half = blockIndex < midpoint ? 0 : 1;
    const remainingBlocksInHalf = (half === 0 ? midpoint : totalBlocks) - blockIndex - 1;
    const isEndpoint = blockIndex === 0 || blockIndex === totalBlocks - 1;
    const used = new Set([goalkeeperNames[blockIndex]]);
    const groups = FIELD_GROUPS
      .filter((group) => formation[group] > 0)
      .sort((left, right) => {
        const leftEligible = corePlayers.filter((player) => generalPositionAllowsGroup(player, left)).length;
        const rightEligible = corePlayers.filter((player) => generalPositionAllowsGroup(player, right)).length;
        return leftEligible - rightEligible || FIELD_GROUPS.indexOf(left) - FIELD_GROUPS.indexOf(right);
      });

    for (const group of groups) {
      const needed = formation[group];
      const candidates = corePlayers
        .filter((player) => !used.has(player.name)
          && generalPositionAllowsGroup(player, group)
          && !player.forbidden_positions.includes(group)
          && (fieldCounts.get(player.name) ?? 0) < (isEndpoint
            ? player.hard_maximum_blocks
            : shortageMode
              ? (goalkeeperNames.includes(player.name) ? player.gk_field_minimum_blocks : player.hard_minimum_blocks)
              : player.target_blocks)
          && (halfCounts.get(player.name)?.[half] ?? 0) < player.max_blocks_per_half)
        .sort((left, right) => {
          const leftTarget = shortageMode ? (goalkeeperNames.includes(left.name) ? left.gk_field_minimum_blocks : left.hard_minimum_blocks) : left.target_blocks;
          const rightTarget = shortageMode ? (goalkeeperNames.includes(right.name) ? right.gk_field_minimum_blocks : right.hard_minimum_blocks) : right.target_blocks;
          const leftTotalRemaining = leftTarget - (fieldCounts.get(left.name) ?? 0);
          const rightTotalRemaining = rightTarget - (fieldCounts.get(right.name) ?? 0);
          const leftHalfRemaining = Math.max(0, Math.ceil(leftTarget / 2) - (halfCounts.get(left.name)?.[half] ?? 0));
          const rightHalfRemaining = Math.max(0, Math.ceil(rightTarget / 2) - (halfCounts.get(right.name)?.[half] ?? 0));
          const leftMustPlay = leftTotalRemaining > remainingBlocksInHalf;
          const rightMustPlay = rightTotalRemaining > remainingBlocksInHalf;
          return Number(rightMustPlay) - Number(leftMustPlay)
            || rightHalfRemaining - leftHalfRemaining
            || rightTotalRemaining - leftTotalRemaining
            || left.name.localeCompare(right.name);
        });

      for (const player of candidates.slice(0, needed)) {
        byGroupAndBlock[group][blockIndex].push(player.name);
        byBlock[blockIndex].add(player.name);
        used.add(player.name);
        fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
        const counts = halfCounts.get(player.name) ?? [0, 0];
        counts[half] += 1;
        halfCounts.set(player.name, counts);
      }
    }
  }

  return { byBlock, byGroupAndBlock };
}

const coverGroupCache = new WeakMap<Player[], Map<PositionGroup, Set<string>>>();

function canCoverGroup(game: Game, roster: Player[], name: string, position: PositionGroup): boolean {
  let rosterCache = coverGroupCache.get(roster);
  if (!rosterCache) {
    rosterCache = new Map<PositionGroup, Set<string>>();
    coverGroupCache.set(roster, rosterCache);
  }
  let coveredNames = rosterCache.get(position);
  if (!coveredNames) {
    coveredNames = new Set([
      ...eligiblePlayers(roster, position),
      ...backupEligiblePlayers(roster, position),
    ].map((player) => player.name));
    rosterCache.set(position, coveredNames);
  }
  return coveredNames.has(name);
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
      if (blockIndex === 0 || blockIndex === game.total_blocks - 1) continue;
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

function combinations<T>(items: T[], size: number, limit = Number.POSITIVE_INFINITY): T[][] {
  if (size === 0) return [[]];
  if (size > items.length) return [];
  const result: T[][] = [];
  for (let index = 0; index <= items.length - size; index += 1) {
    for (const suffix of combinations(items.slice(index + 1), size - 1, limit - result.length)) {
      result.push([items[index], ...suffix]);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function findCombination<T>(items: T[], size: number, isValid: (choice: T[]) => boolean, limit = Number.POSITIVE_INFINITY): T[] | undefined {
  let examined = 0;
  const search = (start: number, remaining: number, choice: T[]): T[] | undefined => {
    if (examined >= limit) return undefined;
    if (remaining === 0) {
      examined += 1;
      return isValid(choice) ? [...choice] : undefined;
    }
    for (let index = start; index <= items.length - remaining; index += 1) {
      choice.push(items[index]);
      const result = search(index + 1, remaining - 1, choice);
      choice.pop();
      if (result) return result;
    }
    return undefined;
  };
  return search(0, size, []);
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
  for (const [blockIndex, goalkeeperName] of goalkeeperNames.entries()) {
    if (!goalkeeperName) continue;
    const half = blockHalf(blockIndex, game.total_blocks);
    const counts = halfCounts.get(goalkeeperName) ?? [0, 0] as [number, number];
    counts[half] += 1;
    halfCounts.set(goalkeeperName, counts);
  }
  const midpoint = halfLength(game.total_blocks);
  const coreGroups = CORE_GROUPS;
  const shortageMode = Boolean(game.quota_feasibility && !game.quota_feasibility.minimumsFeasible);
  const coreReservations = game.disable_maximum_limits
    ? {
      byBlock: Array.from({ length: game.total_blocks }, () => new Set<string>()),
      byGroupAndBlock: {
        D: Array.from({ length: game.total_blocks }, () => [] as string[]),
        M: Array.from({ length: game.total_blocks }, () => [] as string[]),
        F: Array.from({ length: game.total_blocks }, () => [] as string[]),
      },
    }
    : reserveCoreBlocks(game, roster, formation, goalkeeperNames, game.total_blocks, shortageMode);
  const playersByName = new Map(roster.map((player) => [player.name, player]));
  const groupUrgency = (player: Player): number => {
    if (CORE_GROUPS.has(player.group)) return 0;
    if (player.group === 'rotational') return 1;
    return 2;
  };
  const fieldMinimumFor = (player: Player): number => assignedGoalkeepers.has(player.name) ? player.gk_field_minimum_blocks : player.hard_minimum_blocks;
  const shortageKey = (player: Player, previous: Set<string>, half: 0 | 1 = 0): [number, number, number, number, number, string] => [
    halfCounts.get(player.name)?.[half] ?? 0,
    -Math.max(0, fieldMinimumFor(player) - (fieldCounts.get(player.name) ?? 0)),
    fieldCounts.get(player.name) ?? 0,
    groupUrgency(player),
    previous.has(player.name) ? 0 : 1,
    player.name,
  ];
  const compareShortagePlayers = (left: Player, right: Player, previous: Set<string>, half: 0 | 1 = 0): number => {
    const leftKey = shortageKey(left, previous, half);
    const rightKey = shortageKey(right, previous, half);
    for (let index = 0; index < leftKey.length - 1; index += 1) {
      if (leftKey[index] !== rightKey[index]) return leftKey[index] - rightKey[index];
    }
    return leftKey[leftKey.length - 1].localeCompare(rightKey[rightKey.length - 1]);
  };
  const backupBlocks: Record<'D' | 'M' | 'F', Map<number, string[]>> = { D: new Map(), M: new Map(), F: new Map() };
  const usable = (player: Player, position: PositionGroup, blockIndex: number, ignorePositionRestrictions = false): boolean => {
    const half = blockHalf(blockIndex, game.total_blocks);
    return player.available && !reserved[blockIndex].has(player.name) &&
      (game.disable_maximum_limits || ((rawCounts.get(player.name) ?? 0) < player.hard_maximum_blocks && (halfCounts.get(player.name)?.[half] ?? 0) < player.max_blocks_per_half && (!assignedGoalkeepers.has(player.name) || (fieldCounts.get(player.name) ?? 0) < player.gk_field_maximum_blocks))) &&
      (ignorePositionRestrictions || !player.forbidden_positions.includes(position));
  };
  const playerKey = (player: Player, position: PositionGroup, blockIndex: number, previous: Set<string>): [number, number, number, number, number, number, number, string] => {
    const half = blockHalf(blockIndex, game.total_blocks);
    const totalStarts = Object.values(game.season_position_starts?.[player.name] ?? {}).reduce((sum, count) => sum + count, 0);
    const positionStarts = game.season_position_starts?.[player.name]?.[position] ?? 0;
    const fieldMinimum = assignedGoalkeepers.has(player.name) ? player.gk_field_minimum_blocks : player.hard_minimum_blocks;
    const deficit = Math.max(0, fieldMinimum - (fieldCounts.get(player.name) ?? 0));
    const target = assignedGoalkeepers.has(player.name) ? player.gk_field_maximum_blocks : player.target_blocks;
    const targetDeficit = Math.max(0, target - (fieldCounts.get(player.name) ?? 0));
    const intendedMaximum = assignedGoalkeepers.has(player.name) ? player.gk_field_maximum_blocks : player.maximum_blocks;
    const intendedBandPriority = game.disable_maximum_limits || (fieldCounts.get(player.name) ?? 0) < intendedMaximum ? 0 : 1;
    const nonCore = !coreGroups.has(player.group);
    const tier = deficit > 0
      ? assignedGoalkeepers.has(player.name) ? 0 : nonCore ? 1 : 2
      : assignedGoalkeepers.has(player.name) ? 5 : nonCore ? 3 : 4;
    const urgency = player.group === 'developing' || player.group === 'developmental' ? 0.5 : 1;
    const fieldMinimumPriority = assignedGoalkeepers.has(player.name) && deficit > 0 ? 0 : 1;
    const manualOverrideCount = game.disable_maximum_limits ? fieldCounts.get(player.name) ?? 0 : 0;
    const overridePhase = !game.disable_maximum_limits
      ? 0
      : (manualOverrideCount < Math.floor(game.total_blocks * 0.7) ? 0
        : manualOverrideCount < Math.floor(game.total_blocks * 0.8) ? 1
          : CORE_GROUPS.has(player.group) && manualOverrideCount < Math.floor(game.total_blocks * 0.9) ? 2
            : player.group === 'rotational' && manualOverrideCount < Math.floor(game.total_blocks * 0.9) ? 3
              : ['developing', 'developmental'].includes(player.group) && manualOverrideCount < Math.floor(game.total_blocks * 0.9) ? 4
                : manualOverrideCount < game.total_blocks ? 5 : 6);
    return game.disable_maximum_limits
      ? [overridePhase, manualOverrideCount, totalStarts, positionStarts, positionalPriority(player, position), rawCounts.get(player.name) ?? 0, fieldMinimumPriority, intendedBandPriority, player.name]
      : [fieldMinimumPriority, manualOverrideCount, -(deficit || targetDeficit * urgency), intendedBandPriority, totalStarts, positionStarts, positionalPriority(player, position), rawCounts.get(player.name) ?? 0, player.name];
  };
  const comparePlayerKeys = (left: Player, right: Player, position: PositionGroup, blockIndex: number, previous: Set<string>): number => {
    const leftKey = playerKey(left, position, blockIndex, previous);
    const rightKey = playerKey(right, position, blockIndex, previous);
    for (let index = 0; index < leftKey.length - 1; index += 1) {
      if (leftKey[index] !== rightKey[index]) return (leftKey[index] as number) - (rightKey[index] as number);
    }
    return String(leftKey[leftKey.length - 1]).localeCompare(String(rightKey[rightKey.length - 1]));
  };
  const leavesFutureCoverage = (position: 'D' | 'M' | 'F', blockIndex: number, chosen: Player[], candidates: Player[]): boolean => {
    const initialRaw = new Map(rawCounts);
    const initialField = new Map(fieldCounts);
    const initialHalf = new Map([...halfCounts].map(([name, counts]) => [name, [...counts] as [number, number]]));
    const normalCandidates = eligiblePlayers(roster, position);
    const slots = formationSlots(formation)[position];
    const eligibleNamesBySlot = new Map(slots.map((slot) => [slot, new Set(
      candidates.filter((player) => canCoverSlot(player, slot, position)).map((player) => player.name),
    )]));
    const searchBudget = Math.max(12000, candidates.length * game.total_blocks * 500);
    let statesVisited = 0;
    const updateState = (state: { raw: Map<string, number>; field: Map<string, number>; half: Map<string, [number, number]> }, players: Player[], index: number) => {
      const raw = new Map(state.raw); const field = new Map(state.field); const half = new Map([...state.half].map(([name, counts]) => [name, [...counts] as [number, number]]));
      for (const player of players) {
        raw.set(player.name, (raw.get(player.name) ?? 0) + 1);
        field.set(player.name, (field.get(player.name) ?? 0) + 1);
        const playerHalf = half.get(player.name) ?? [0, 0]; playerHalf[blockHalf(index, game.total_blocks)] += 1; half.set(player.name, playerHalf);
      }
      return { raw, field, half };
    };
    const assignableChoices = (available: Player[], requiredNames: Set<string>, limit: number): Player[][] => {
      if (available.length < formation[position]) return [];
      if ([...requiredNames].some((name) => !available.some((player) => player.name === name))) return [];
      const allSlotsFlexible = slots.every((slot) => available.every((player) => canCoverSlot(player, slot, position)));
      if (allSlotsFlexible) {
        const ordered = [...available].sort((left, right) => Number(requiredNames.has(right.name)) - Number(requiredNames.has(left.name)) || left.name.localeCompare(right.name));
        return combinations(ordered, formation[position], limit).filter((choice) => requiredNames.size > formation[position]
          ? choice.every((player) => requiredNames.has(player.name))
          : [...requiredNames].every((name) => choice.some((player) => player.name === name)));
      }
      const candidatesBySlot = new Map(slots.map((slot) => [slot, available
        .filter((player) => eligibleNamesBySlot.get(slot)?.has(player.name))
        .sort((left, right) => {
          const requiredDifference = Number(requiredNames.has(right.name)) - Number(requiredNames.has(left.name));
          return requiredDifference || left.name.localeCompare(right.name);
        })]));
      const orderedSlots = [...slots].sort((left, right) => {
        const difference = (candidatesBySlot.get(left)?.length ?? 0) - (candidatesBySlot.get(right)?.length ?? 0);
        return difference || left.localeCompare(right);
      });
      const chosenNames = new Set<string>();
      const choices: Player[][] = [];
      const search = (index: number): boolean => {
        statesVisited += 1;
        if (statesVisited > searchBudget) return false;
        if (index === orderedSlots.length) {
          const requiredSatisfied = requiredNames.size > formation[position]
            ? [...chosenNames].every((name) => requiredNames.has(name))
            : [...requiredNames].every((name) => chosenNames.has(name));
          if (requiredSatisfied) choices.push(available.filter((player) => chosenNames.has(player.name)));
          return choices.length >= limit;
        }
        const slot = orderedSlots[index];
        for (const player of candidatesBySlot.get(slot) ?? []) {
          if (chosenNames.has(player.name)) continue;
          chosenNames.add(player.name);
          if (search(index + 1)) return true;
          chosenNames.delete(player.name);
        }
        return false;
      };
      search(0);
      return choices;
    };
    const postChoice = updateState({ raw: initialRaw, field: initialField, half: initialHalf }, chosen, blockIndex);
    if (slots.every((slot) => candidates.every((player) => canCoverSlot(player, slot, position)))) {
      for (const half of [0, 1] as const) {
        const futureIndices = Array.from({ length: game.total_blocks }, (_, index) => index)
          .filter((index) => index > blockIndex && blockHalf(index, game.total_blocks) === half);
        const capacity = candidates.reduce((total, player) => {
          const remainingHalf = Math.max(0, player.max_blocks_per_half - (postChoice.half.get(player.name)?.[half] ?? 0));
          const remainingTotal = Math.max(0, player.hard_maximum_blocks - (postChoice.raw.get(player.name) ?? 0));
          return total + Math.min(futureIndices.length, remainingHalf, remainingTotal);
        }, 0);
        if (capacity < formation[position] * futureIndices.length) return false;
      }
      return true;
    }
    const stateKey = (index: number, state: { raw: Map<string, number>; field: Map<string, number>; half: Map<string, [number, number]> }) => [
      index,
      candidates.map((player) => `${player.name}:${state.raw.get(player.name) ?? 0}:${state.field.get(player.name) ?? 0}:${(state.half.get(player.name) ?? [0, 0]).join(',')}`).join('|'),
    ].join(';');
    const failed = new Set<string>();
    const search = (future: number, state: { raw: Map<string, number>; field: Map<string, number>; half: Map<string, [number, number]> }): boolean => {
      if (future >= game.total_blocks) return true;
      const key = stateKey(future, state);
      if (failed.has(key)) return false;
      for (const half of [0, 1] as const) {
        const futureIndices = Array.from({ length: game.total_blocks }, (_, index) => index)
          .filter((index) => index >= future && blockHalf(index, game.total_blocks) === half);
        if (!futureIndices.length) continue;
        const capacity = candidates.reduce((total, player) => {
          const playerHalf = state.half.get(player.name)?.[half] ?? 0;
          const remainingHalf = Math.max(0, player.max_blocks_per_half - playerHalf);
          const remainingTotal = Math.max(0, player.hard_maximum_blocks - (state.raw.get(player.name) ?? 0));
          const remainingField = assignedGoalkeepers.has(player.name)
            ? Math.max(0, player.gk_field_maximum_blocks - (state.field.get(player.name) ?? 0))
            : remainingTotal;
          const eligibleBlocks = futureIndices.filter((index) => {
            const plannedBackupNames = new Set(backupBlocks[position].get(index) ?? []);
            const reservedCoreNames = new Set(coreReservations.byGroupAndBlock[position][index]);
            return player.available && !reserved[index].has(player.name)
              && (!plannedBackupNames.size || normalCandidates.includes(player) || plannedBackupNames.has(player.name))
              && (!coreGroups.has(player.group) || reservedCoreNames.has(player.name))
              && slots.some((slot) => eligibleNamesBySlot.get(slot)?.has(player.name));
          }).length;
          return total + Math.min(eligibleBlocks, remainingHalf, remainingTotal, remainingField);
        }, 0);
        const required = formation[position] * futureIndices.length;
        if (capacity < required) {
          failed.add(key);
          return false;
        }
      }
      const plannedBackupNames = new Set(backupBlocks[position].get(future) ?? []);
      const reservedCoreNames = new Set(coreReservations.byGroupAndBlock[position][future]);
      const available = candidates.filter((player) => {
        const half = blockHalf(future, game.total_blocks);
        const normalOrPlannedBackup = !plannedBackupNames.size || normalCandidates.includes(player) || plannedBackupNames.has(player.name);
        const coreAllowed = !coreGroups.has(player.group) || reservedCoreNames.has(player.name);
        return player.available && !reserved[future].has(player.name) && normalOrPlannedBackup && coreAllowed &&
          !player.forbidden_positions.includes(position) &&
          (state.raw.get(player.name) ?? 0) < player.hard_maximum_blocks &&
          (state.half.get(player.name)?.[half] ?? 0) < player.max_blocks_per_half &&
          (!assignedGoalkeepers.has(player.name) || (state.field.get(player.name) ?? 0) < player.gk_field_maximum_blocks);
      });
      const requiredBackups = available.filter((player) => plannedBackupNames.has(player.name) || reservedCoreNames.has(player.name));
      const choices = assignableChoices(available, new Set(requiredBackups.map((player) => player.name)), 32);
      for (const choice of choices) {
        if (search(future + 1, updateState(state, choice, future))) return true;
      }
      failed.add(key);
      return false;
    };
    return search(blockIndex + 1, postChoice);
  };

  // Reserve declared backups before the normal groups consume them. This is
  // deliberately calculated per half, matching Python's capacity accounting.
  for (const position of positions) {
    const normalCandidates = eligiblePlayers(roster, position);
    const backups = backupEligiblePlayers(roster, position);
    for (const [half, indices] of [[0, Array.from({ length: midpoint }, (_, index) => index).filter((index) => index >= Math.max(0, startBlock - 1))], [1, Array.from({ length: game.total_blocks - midpoint }, (_, index) => index + midpoint).filter((index) => index >= Math.max(0, startBlock - 1))]] as const) {
      if (!indices.length || !backups.length) continue;
      const normalCapacity = normalCandidates.reduce((total, player) => {
        const fieldIndices = indices.filter((index) => goalkeeperNames[index] !== player.name).length;
        return total + Math.min(fieldIndices, player.max_blocks_per_half, player.hard_maximum_blocks - (rawCounts.get(player.name) ?? 0));
      }, 0);
      let required = Math.max(0, formation[position] * indices.length - normalCapacity);
      const capacity = new Map<string, number>(backups.map((player: Player) => {
        const fieldIndices = indices.filter((index) => goalkeeperNames[index] !== player.name).length;
        return [player.name, Math.min(fieldIndices, player.max_blocks_per_half, player.hard_maximum_blocks - (rawCounts.get(player.name) ?? 0))];
      }));
      let slot = 0;
      for (const player of [...backups].sort((left, right) => left.name.localeCompare(right.name))) {
        const eligibleIndices = indices.filter((index) => goalkeeperNames[index] !== player.name);
        for (let count = 0; count < Math.min(capacity.get(player.name) ?? 0, required); count += 1) {
          const index = eligibleIndices[eligibleIndices.length - 1 - (slot % eligibleIndices.length)];
          const planned = backupBlocks[position].get(index) ?? [];
          if (planned.includes(player.name)) continue;
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
    const leftCount = eligiblePlayers(roster, left).length;
    const rightCount = eligiblePlayers(roster, right).length;
    return leftCount - rightCount || positions.indexOf(left) - positions.indexOf(right);
  })) {
    const needed = formation[position];
    const normalCandidates = eligiblePlayers(roster, position);
    const backupCandidates = backupEligiblePlayers(roster, position);
    const candidates = [...normalCandidates, ...backupCandidates.filter((player) => !normalCandidates.includes(player))];
    for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
      const plannedBackupNames = new Set(backupBlocks[position].get(blockIndex) ?? []);
      const reservedCoreNames = new Set(coreReservations.byGroupAndBlock[position][blockIndex]);
      const available = candidates.filter((player) => usable(player, position, blockIndex)
        && (!plannedBackupNames.size || normalCandidates.includes(player) || plannedBackupNames.has(player.name))
        && (!coreGroups.has(player.group) || reservedCoreNames.has(player.name)));
      const ordered = [...available].sort((left, right) => {
        if (shortageMode) return compareShortagePlayers(left, right, previous, blockHalf(blockIndex, game.total_blocks));
        const leftKey = playerKey(left, position, blockIndex, previous); const rightKey = playerKey(right, position, blockIndex, previous);
        for (let index = 0; index < leftKey.length - 1; index += 1) if (leftKey[index] !== rightKey[index]) return (leftKey[index] as number) - (rightKey[index] as number);
        return String(leftKey[leftKey.length - 1]).localeCompare(String(rightKey[rightKey.length - 1]));
      });
      const requiredBackups = ordered.filter((player) => plannedBackupNames.has(player.name) || reservedCoreNames.has(player.name));
      const requiredCount = Math.max(0, needed - requiredBackups.length);
      const optional = ordered.filter((player) => !requiredBackups.includes(player));
      const boundedCombinations = (items: Player[], count: number, limit: number): Player[][] => {
        const result: Player[][] = [];
        const visit = (start: number, selected: Player[]): void => {
          if (result.length >= limit) return;
          if (selected.length === count) {
            result.push(selected);
            return;
          }
          for (let index = start; index <= items.length - (count - selected.length); index += 1) {
            visit(index + 1, [...selected, items[index]]);
            if (result.length >= limit) return;
          }
        };
        if (count === 0) result.push([]);
        else if (count > 0 && count <= items.length) visit(0, []);
        return result;
      };
      const choiceLimit = 4096;
      const candidateChoices = requiredBackups.length > needed
        ? boundedCombinations(requiredBackups, needed, choiceLimit)
        : requiredBackups.length
          ? boundedCombinations(optional, requiredCount, choiceLimit).map((choice) => [...requiredBackups, ...choice])
          : boundedCombinations(ordered, needed, choiceLimit);
      const compareKeys = (left: (number | string)[], right: (number | string)[]): number => {
        for (let index = 0; index < left.length; index += 1) {
          if (left[index] === right[index]) continue;
          if (typeof left[index] === 'number' && typeof right[index] === 'number') return (left[index] as number) - (right[index] as number);
          return String(left[index]).localeCompare(String(right[index]));
        }
        return 0;
      };
      const choiceKey = (choice: Player[]) => shortageMode
        ? choice.map((player) => shortageKey(player, previous, blockHalf(blockIndex, game.total_blocks))).sort(compareKeys)
        : choice.map((player) => playerKey(player, position, blockIndex, previous)).sort(compareKeys);
      const exactFeasibleChoices = candidateChoices.filter((choice) =>
        completeExactAssignmentExists(
          roster,
          choice.map((player) => player.name),
          formationSlots(formation)[position],
          position,
        ),
      );
      const futureSafeChoices = exactFeasibleChoices.filter((choice) => leavesFutureCoverage(position, blockIndex, choice, candidates));
      const choices = futureSafeChoices.length ? futureSafeChoices : exactFeasibleChoices;
      choices.sort((left, right) => {
        const leftKey = choiceKey(left); const rightKey = choiceKey(right);
        for (let index = 0; index < leftKey.length; index += 1) {
          const comparison = compareKeys(leftKey[index], rightKey[index]);
          if (comparison) return comparison;
        }
        return 0;
      });
      const chosen = choices[0] ?? [];
      plans[position][blockIndex] = chosen.map((player) => player.name);
      for (const player of chosen) {
        reserved[blockIndex].add(player.name); rawCounts.set(player.name, (rawCounts.get(player.name) ?? 0) + 1); fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
        const half = blockHalf(blockIndex, game.total_blocks); const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number]; counts[half] += 1; halfCounts.set(player.name, counts);
      }
      previous = new Set(plans[position][blockIndex]);
    }
  }

  const fieldCandidates = roster.filter((player) => player.available && !assignedGoalkeepers.has(player.name));
  const allAvailableFieldPlayersCore = fieldCandidates.every((player) => coreGroups.has(player.group));
  const mixedQuotaGroups = new Set(fieldCandidates.map((player) => player.group));
  const allFieldPlayersFlexible = fieldCandidates.every((player) =>
    ['D', 'M', 'F'].every((position) => player.general_positions.includes(position)));
  const plansComplete = positions.every((position) => plans[position].every((players) => players.length >= formation[position]));
  const symmetricShortageCandidates = shortageMode && positions.every((position) => {
    const slots = formationSlots(formation)[position];
    const candidates = eligiblePlayers(roster, position).filter((player) => player.available);
    return slots.every((slot) => candidates.length >= formation[position] && candidates.every((player) => canCoverSlot(player, slot, position)));
  });
  if (symmetricShortageCandidates && plansComplete && allAvailableFieldPlayersCore) return plans;
  if (symmetricShortageCandidates && allFieldPlayersFlexible
    && mixedQuotaGroups.has('core') && mixedQuotaGroups.has('rotational') && mixedQuotaGroups.has('developing')) {
    const candidates = fieldCandidates;
    const counts = new Map(candidates.map((player) => [player.name, 0]));
    const halfCounts = new Map(candidates.map((player) => [player.name, [0, 0] as [number, number]]));
    for (let blockIndex = 0; blockIndex < game.total_blocks; blockIndex += 1) {
      const half = blockHalf(blockIndex, game.total_blocks);
      const used = new Set<string>();
      for (const position of positions) {
        const chosen = [...candidates]
          .filter((player) => !used.has(player.name)
            && (counts.get(player.name) ?? 0) < player.hard_maximum_blocks
            && (halfCounts.get(player.name)?.[half] ?? 0) < player.max_blocks_per_half)
          .sort((left, right) => (halfCounts.get(left.name)?.[half] ?? 0) - (halfCounts.get(right.name)?.[half] ?? 0)
            || (counts.get(left.name) ?? 0) - (counts.get(right.name) ?? 0)
            || left.name.localeCompare(right.name))
          .slice(0, formation[position]);
        plans[position][blockIndex] = chosen.map((player) => player.name);
        for (const player of chosen) {
          used.add(player.name);
          counts.set(player.name, (counts.get(player.name) ?? 0) + 1);
          const playerHalfCounts = halfCounts.get(player.name)!;
          playerHalfCounts[half] += 1;
        }
      }
    }
    return plans;
  }

  const repairCoreReservations = (start: number, end: number): void => {
    for (let blockIndex = start; blockIndex < end; blockIndex += 1) {
      const assigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((position) => plans[position][blockIndex])]);
      for (const position of positions) {
        for (const coreName of coreReservations.byGroupAndBlock[position][blockIndex]) {
          if (plans[position][blockIndex].includes(coreName)) continue;
          const core = playersByName.get(coreName);
          reserved[blockIndex].delete(coreName);
          if (!core || !usable(core, position, blockIndex)) continue;
          const sourcePosition = positions.find((candidatePosition) => plans[candidatePosition][blockIndex].includes(coreName));
          if (sourcePosition && sourcePosition !== position) {
            const sourceIndex = plans[sourcePosition][blockIndex].indexOf(coreName);
            const targetIndex = plans[position][blockIndex].findIndex((name) => {
              const donor = playersByName.get(name);
              return Boolean(donor && coreGroups.has(donor.group) && canCoverGroup(game, roster, donor.name, sourcePosition));
            });
            if (targetIndex >= 0) {
              const replacement = [...plans[position][blockIndex]];
              replacement[targetIndex] = coreName;
              const sourceReplacement = [...plans[sourcePosition][blockIndex]];
              sourceReplacement[sourceIndex] = plans[position][blockIndex][targetIndex];
              if (completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position)
                && completeExactAssignmentExists(roster, sourceReplacement, formationSlots(formation)[sourcePosition], sourcePosition)) {
                plans[position][blockIndex] = replacement;
                plans[sourcePosition][blockIndex] = sourceReplacement;
                reserved[blockIndex].add(coreName);
                continue;
              }
            }
          }
          if (assigned.has(coreName)) continue;
          const donorIndex = plans[position][blockIndex].findIndex((name) => {
            const donor = playersByName.get(name);
            return Boolean(donor && !coreGroups.has(donor.group));
          });
          if (donorIndex < 0) {
            let exchanged = false;
            for (const donorName of plans[position][blockIndex]) {
              const donor = playersByName.get(donorName);
              if (!donor || !coreGroups.has(donor.group)) continue;
              for (const otherPosition of positions) {
                if (otherPosition === position) continue;
                const otherDonorIndex = plans[otherPosition][blockIndex].findIndex((name) => {
                  const otherDonor = playersByName.get(name);
                  return Boolean(otherDonor && !coreGroups.has(otherDonor.group));
                });
                if (otherDonorIndex < 0 || !canCoverGroup(game, roster, donor.name, otherPosition)) continue;
                const otherDonorName = plans[otherPosition][blockIndex][otherDonorIndex];
                const replacement = [...plans[position][blockIndex]];
                replacement[replacement.indexOf(donor.name)] = core.name;
                const otherReplacement = [...plans[otherPosition][blockIndex]];
                otherReplacement[otherDonorIndex] = donor.name;
                if (!completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position)
                  || !completeExactAssignmentExists(roster, otherReplacement, formationSlots(formation)[otherPosition], otherPosition)) continue;
                plans[position][blockIndex] = replacement;
                plans[otherPosition][blockIndex] = otherReplacement;
                const half = blockHalf(blockIndex, game.total_blocks);
                rawCounts.set(core.name, (rawCounts.get(core.name) ?? 0) + 1);
                fieldCounts.set(core.name, (fieldCounts.get(core.name) ?? 0) + 1);
                const coreHalfCounts = halfCounts.get(core.name) ?? [0, 0] as [number, number]; coreHalfCounts[half] += 1; halfCounts.set(core.name, coreHalfCounts);
                rawCounts.set(otherDonorName, Math.max(0, (rawCounts.get(otherDonorName) ?? 0) - 1));
                fieldCounts.set(otherDonorName, Math.max(0, (fieldCounts.get(otherDonorName) ?? 0) - 1));
                const exchangedDonorHalfCounts = halfCounts.get(otherDonorName) ?? [0, 0] as [number, number]; exchangedDonorHalfCounts[half] -= 1; halfCounts.set(otherDonorName, exchangedDonorHalfCounts);
                assigned.add(core.name);
                exchanged = true;
                break;
              }
              if (exchanged) break;
            }
            if (exchanged) continue;
            continue;
          }
          const replacement = [...plans[position][blockIndex]];
          replacement[donorIndex] = coreName;
          if (!completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position)) continue;
          const donor = playersByName.get(replacement[donorIndex] === coreName ? plans[position][blockIndex][donorIndex] : '');
          plans[position][blockIndex] = replacement;
          assigned.delete(donor?.name ?? '');
          assigned.add(coreName);
          if (donor) {
            rawCounts.set(donor.name, Math.max(0, (rawCounts.get(donor.name) ?? 0) - 1));
            fieldCounts.set(donor.name, Math.max(0, (fieldCounts.get(donor.name) ?? 0) - 1));
          }
          rawCounts.set(core.name, (rawCounts.get(core.name) ?? 0) + 1);
          fieldCounts.set(core.name, (fieldCounts.get(core.name) ?? 0) + 1);
        }
      }
      if (blockIndex === 0 || blockIndex === game.total_blocks - 1) {
        for (const position of positions) {
          const protectedNames = new Set(coreReservations.byGroupAndBlock[position][blockIndex]);
          const usedNames = new Set(positions.flatMap((candidatePosition) => plans[candidatePosition][blockIndex]));
          const backupCandidates = backupEligiblePlayers(roster, position)
            .filter((player) => !coreGroups.has(player.group) && !usedNames.has(player.name))
            .sort((left, right) => left.name.localeCompare(right.name));
          for (const index of plans[position][blockIndex].keys()) {
            const current = playersByName.get(plans[position][blockIndex][index]);
            if (!current || protectedNames.has(current.name) || !coreGroups.has(current.group)) continue;
            const candidate = backupCandidates.find((player) => {
              const replacement = [...plans[position][blockIndex]];
              replacement[index] = player.name;
              return completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position);
            });
            if (!candidate) continue;
            plans[position][blockIndex][index] = candidate.name;
            usedNames.delete(current.name);
            usedNames.add(candidate.name);
            break;
          }
        }
      }
    }
  };

  // Review each half independently first, then review the complete game.
  repairCoreReservations(0, midpoint);
  repairCoreReservations(midpoint, game.total_blocks);
  repairCoreReservations(0, game.total_blocks);

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
            if (!rested.available || !coreGroups.has(rested.group) || !coreReservations.byBlock[blockIndex].has(rested.name) || assigned.has(rested.name) || rested.name === goalkeeperNames[blockIndex]) continue;
            if (!eligiblePlayers(roster, position).some((player) => player.name === rested.name)) continue;
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
            if (!core || !coreGroups.has(core.group) || !coreReservations.byBlock[finalBlock].has(core.name) || finalAssigned.has(core.name) || sourceAssigned.has(finalPlayer.name)) continue;
            source[sourceSlot] = finalPlayer.name; finalPlayers[finalSlot] = core.name;
            finalAssigned.delete(finalPlayer.name); finalAssigned.add(core.name); swapped = true; break;
          }
        }
      }
    }
  }

  const refreshPlanningCounts = (): void => {
    rawCounts.clear(); fieldCounts.clear(); halfCounts.clear();
    for (const player of roster) {
      rawCounts.set(player.name, player.block_count);
      fieldCounts.set(player.name, player.block_count);
      halfCounts.set(player.name, [...player.blocks_by_half] as [number, number]);
    }
    for (const [blockIndex, goalkeeperName] of goalkeeperNames.entries()) {
      if (!goalkeeperName) continue;
      rawCounts.set(goalkeeperName, (rawCounts.get(goalkeeperName) ?? 0) + 1);
    }
    for (const position of positions) {
      for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
        for (const name of plans[position][blockIndex]) {
          rawCounts.set(name, (rawCounts.get(name) ?? 0) + 1);
          fieldCounts.set(name, (fieldCounts.get(name) ?? 0) + 1);
          const counts = halfCounts.get(name) ?? [0, 0] as [number, number];
          counts[blockHalf(blockIndex, game.total_blocks)] += 1;
          halfCounts.set(name, counts);
        }
      }
    }
  };
  refreshPlanningCounts();

  const replanPositionHalf = (position: PositionGroup, half: 0 | 1): boolean => {
    const halfStart = half === 0 ? Math.max(0, startBlock - 1) : midpoint;
    const halfEnd = half === 0 ? midpoint : game.total_blocks;
    const indices = Array.from({ length: Math.max(0, halfEnd - halfStart) }, (_, index) => index + halfStart);
    if (!indices.length || !indices.some((index) => plans[position][index].length < formation[position])) return false;
    const originalPlans = indices.map((index) => [...plans[position][index]]);
    const originalReserved = indices.map((index) => new Set(reserved[index]));
    for (const index of indices) {
      for (const name of plans[position][index]) {
        rawCounts.set(name, Math.max(0, (rawCounts.get(name) ?? 0) - 1));
        fieldCounts.set(name, Math.max(0, (fieldCounts.get(name) ?? 0) - 1));
        const counts = halfCounts.get(name) ?? [0, 0] as [number, number];
        counts[half] -= 1;
        halfCounts.set(name, counts);
      }
      plans[position][index] = [];
      reserved[index].clear();
      reserved[index].add(goalkeeperNames[index]);
      for (const group of positions) if (group !== position) plans[group][index].forEach((name) => reserved[index].add(name));
    }
    let visited = 0;
    const search = (index: number): boolean => {
      visited += 1;
      if (visited > 10000) return false;
      if (index === indices.length) return true;
      const blockIndex = indices[index];
      const assignedElsewhere = new Set([goalkeeperNames[blockIndex], ...positions
        .filter((group) => group !== position)
        .flatMap((group) => plans[group][blockIndex])]);
      const candidates = roster
        .filter((player) => player.available && !assignedElsewhere.has(player.name)
          && canCoverGroup(game, roster, player.name, position)
          && usable(player, position, blockIndex))
        .sort((left, right) => {
          const leftCurrent = originalPlans[index].includes(left.name) ? 0 : 1;
          const rightCurrent = originalPlans[index].includes(right.name) ? 0 : 1;
          return leftCurrent - rightCurrent || comparePlayerKeys(left, right, position, blockIndex, new Set(originalPlans[index]));
        });
      const choices = combinations(candidates, formation[position], 256)
        .filter((choice) => choice.every((player) => {
          const nextFieldCount = (fieldCounts.get(player.name) ?? 0) + 1;
          const nextRawCount = (rawCounts.get(player.name) ?? 0) + 1;
          const nextHalfCount = (halfCounts.get(player.name)?.[half] ?? 0) + 1;
          return (game.disable_maximum_limits || (nextRawCount <= player.hard_maximum_blocks
            && nextHalfCount <= player.max_blocks_per_half
            && (!assignedGoalkeepers.has(player.name) || nextFieldCount <= player.gk_field_maximum_blocks)))
            && !choice.slice(0, choice.indexOf(player)).some((other) => other.name === player.name);
        }))
        .filter((choice) => completeExactAssignmentExists(roster, choice.map((player) => player.name), formationSlots(formation)[position], position));
      for (const choice of choices) {
        plans[position][blockIndex] = choice.map((player) => player.name);
        choice.forEach((player) => {
          rawCounts.set(player.name, (rawCounts.get(player.name) ?? 0) + 1);
          fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
          const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number];
          counts[half] += 1;
          halfCounts.set(player.name, counts);
        });
        if (search(index + 1)) return true;
        choice.forEach((player) => {
          rawCounts.set(player.name, Math.max(0, (rawCounts.get(player.name) ?? 0) - 1));
          fieldCounts.set(player.name, Math.max(0, (fieldCounts.get(player.name) ?? 0) - 1));
          const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number];
          counts[half] -= 1;
          halfCounts.set(player.name, counts);
        });
        plans[position][blockIndex] = [];
      }
      return false;
    };
    if (search(0)) {
      indices.forEach((index) => plans[position][index].forEach((name) => reserved[index].add(name)));
      refreshPlanningCounts();
      return true;
    }
    indices.forEach((index, offset) => { plans[position][index] = originalPlans[offset]; });
    indices.forEach((index, offset) => { reserved[index].clear(); originalReserved[offset].forEach((name) => reserved[index].add(name)); });
    refreshPlanningCounts();
    return false;
  };
  for (const position of positions) for (const half of [0, 1] as const) replanPositionHalf(position, half);

  const replanHalfJoint = (half: 0 | 1): boolean => {
    const halfStart = half === 0 ? Math.max(0, startBlock - 1) : midpoint;
    const halfEnd = half === 0 ? midpoint : game.total_blocks;
    const indices = Array.from({ length: Math.max(0, halfEnd - halfStart) }, (_, index) => index + halfStart);
    if (!indices.length || !indices.some((index) => positions.some((position) => plans[position][index].length < formation[position]))) return false;
    const originalPlans = positions.reduce((saved, position) => {
      saved[position] = indices.map((index) => [...plans[position][index]]);
      return saved;
    }, { D: [], M: [], F: [] } as PlannedGroups);
    const originalReserved = indices.map((index) => new Set(reserved[index]));
    for (const index of indices) {
      for (const position of positions) plans[position][index] = [];
      reserved[index].clear();
      if (goalkeeperNames[index]) reserved[index].add(goalkeeperNames[index]);
    }
    refreshPlanningCounts();
    let visited = 0;
    const searchBlock = (blockOffset: number): boolean => {
      visited += 1;
      if (visited > 10000) return false;
      if (blockOffset === indices.length) return true;
      const blockIndex = indices[blockOffset];
      const groupOrder = [...positions].sort((left, right) => {
        const leftCount = roster.filter((player) => player.available && canCoverGroup(game, roster, player.name, left) && usable(player, left, blockIndex)).length;
        const rightCount = roster.filter((player) => player.available && canCoverGroup(game, roster, player.name, right) && usable(player, right, blockIndex)).length;
        return leftCount - rightCount || positions.indexOf(left) - positions.indexOf(right);
      });
      const searchGroup = (groupOffset: number, used: Set<string>): boolean => {
        if (groupOffset === groupOrder.length) return searchBlock(blockOffset + 1);
        const position = groupOrder[groupOffset];
        const candidates = roster
          .filter((player) => player.available && !used.has(player.name) && player.name !== goalkeeperNames[blockIndex]
            && canCoverGroup(game, roster, player.name, position) && usable(player, position, blockIndex))
          .sort((left, right) => comparePlayerKeys(left, right, position, blockIndex, used) || left.name.localeCompare(right.name));
        const choices = combinations(candidates, formation[position], 96)
          .filter((choice) => completeExactAssignmentExists(roster, choice.map((player) => player.name), formationSlots(formation)[position], position));
        for (const choice of choices) {
          plans[position][blockIndex] = choice.map((player) => player.name);
          choice.forEach((player) => {
            used.add(player.name);
            rawCounts.set(player.name, (rawCounts.get(player.name) ?? 0) + 1);
            fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
            const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number];
            counts[half] += 1;
            halfCounts.set(player.name, counts);
          });
          if (searchGroup(groupOffset + 1, used)) return true;
          choice.forEach((player) => {
            used.delete(player.name);
            rawCounts.set(player.name, Math.max(0, (rawCounts.get(player.name) ?? 0) - 1));
            fieldCounts.set(player.name, Math.max(0, (fieldCounts.get(player.name) ?? 0) - 1));
            const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number];
            counts[half] -= 1;
            halfCounts.set(player.name, counts);
          });
          plans[position][blockIndex] = [];
        }
        return false;
      };
      return searchGroup(0, new Set([goalkeeperNames[blockIndex]]));
    };
    if (searchBlock(0)) {
      for (const index of indices) for (const position of positions) plans[position][index].forEach((name) => reserved[index].add(name));
      refreshPlanningCounts();
      return true;
    }
    for (const position of positions) indices.forEach((index, offset) => { plans[position][index] = originalPlans[position][offset]; });
    indices.forEach((index, offset) => { reserved[index].clear(); originalReserved[offset].forEach((name) => reserved[index].add(name)); });
    refreshPlanningCounts();
    return false;
  };
  for (const half of [0, 1] as const) {
    const halfStart = half === 0 ? Math.max(0, startBlock - 1) : midpoint;
    const halfEnd = half === 0 ? midpoint : game.total_blocks;
    const forwardCapacity = roster.filter((player) => player.available && canCoverGroup(game, roster, player.name, 'F')).length;
    if (!shortageMode && forwardCapacity > formation.F && Array.from({ length: Math.max(0, halfEnd - halfStart) }, (_, index) => index + halfStart)
      .some((index) => plans.F[index].length < formation.F)) replanHalfJoint(half);
  }

  const repairShortBlock = (blockIndex: number): boolean => {
    if (positions.every((position) => plans[position][blockIndex].length >= formation[position])) return false;
    const groupOrder = [...positions].sort((left, right) => {
      const leftCandidates = roster.filter((player) => player.available && player.name !== goalkeeperNames[blockIndex]
        && canCoverGroup(game, roster, player.name, left) && usable(player, left, blockIndex)).length;
      const rightCandidates = roster.filter((player) => player.available && player.name !== goalkeeperNames[blockIndex]
        && canCoverGroup(game, roster, player.name, right) && usable(player, right, blockIndex)).length;
      return leftCandidates - rightCandidates || positions.indexOf(left) - positions.indexOf(right);
    });
    const choicesByGroup = new Map<PositionGroup, Player[][]>();
    for (const position of groupOrder) {
      const candidates = roster
        .filter((player) => player.available && player.name !== goalkeeperNames[blockIndex]
          && canCoverGroup(game, roster, player.name, position) && usable(player, position, blockIndex))
        .sort((left, right) => {
          const leftCurrent = plans[position][blockIndex].includes(left.name) ? 0 : 1;
          const rightCurrent = plans[position][blockIndex].includes(right.name) ? 0 : 1;
          return leftCurrent - rightCurrent || comparePlayerKeys(left, right, position, blockIndex, new Set(plans[position][blockIndex]));
        });
      choicesByGroup.set(position, combinations(candidates, formation[position], 512)
        .filter((choice) => completeExactAssignmentExists(roster, choice.map((player) => player.name), formationSlots(formation)[position], position)));
    }
    const assignment: Record<'D' | 'M' | 'F', Player[]> = { D: [], M: [], F: [] };
    const search = (index: number, used: Set<string>): boolean => {
      if (index === groupOrder.length) return true;
      const position = groupOrder[index];
      for (const choice of choicesByGroup.get(position) ?? []) {
        if (choice.some((player) => used.has(player.name))) continue;
        assignment[position] = choice;
        choice.forEach((player) => used.add(player.name));
        if (search(index + 1, used)) return true;
        choice.forEach((player) => used.delete(player.name));
      }
      return false;
    };
    if (!search(0, new Set([goalkeeperNames[blockIndex]]))) return false;
    for (const position of positions) plans[position][blockIndex] = assignment[position].map((player) => player.name);
    refreshPlanningCounts();
    return true;
  };
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) repairShortBlock(blockIndex);

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
              eligiblePlayers(roster, position).some((player) => player.name === candidate.name) ||
              backupEligiblePlayers(roster, position).some((player) => player.name === candidate.name)
            );
            if (!candidate || !canCoverPosition) continue;
            const replacement = eligiblePlayers(roster, other)
              .filter((player) => player.name !== candidateName && !plans[other][blockIndex].includes(player.name) && usable(player, other, blockIndex))
              .sort((left, right) => shortageMode
                ? compareShortagePlayers(left, right, new Set(plans[other][blockIndex]))
                : comparePlayerKeys(left, right, other, blockIndex, new Set(plans[other][blockIndex])))[0];
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

  const augmentGroupAtBlock = (target: 'D' | 'M' | 'F', blockIndex: number, blocked: Set<PositionGroup> = new Set(), depth = 0): boolean => {
    if (plans[target][blockIndex].length >= formation[target]) return true;
    if (depth > positions.length) return false;
    const targetSlots = formationSlots(formation)[target];
    const used = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((group) => plans[group][blockIndex])]);
    const directCandidates = roster
      .filter((player) => !used.has(player.name) && canCoverGroup(game, roster, player.name, target) && usable(player, target, blockIndex))
      .sort((left, right) => shortageMode
        ? compareShortagePlayers(left, right, new Set(plans[target][blockIndex]), blockHalf(blockIndex, game.total_blocks))
        : comparePlayerKeys(left, right, target, blockIndex, new Set(plans[target][blockIndex])));
    for (const candidate of directCandidates) {
      const replacementPlan = [...plans[target][blockIndex], candidate.name];
      if (replacementPlan.length === formation[target] && !completeExactAssignmentExists(roster, replacementPlan, targetSlots, target)) continue;
      plans[target][blockIndex] = replacementPlan;
      return true;
    }
    for (const source of positions) {
      if (source === target || blocked.has(source)) continue;
      for (const candidateName of [...plans[source][blockIndex]]) {
        const candidate = playersByName.get(candidateName);
        if (!candidate || !canCoverGroup(game, roster, candidate.name, target)) continue;
        const sourcePlan = plans[source][blockIndex].filter((name) => name !== candidate.name);
        const targetPlan = [...plans[target][blockIndex], candidate.name];
        if (targetPlan.length === formation[target] && !completeExactAssignmentExists(roster, targetPlan, targetSlots, target)) continue;
        plans[source][blockIndex] = sourcePlan;
        plans[target][blockIndex] = targetPlan;
        if (augmentGroupAtBlock(source, blockIndex, new Set([...blocked, target]), depth + 1)
          && completeExactAssignmentExists(roster, plans[source][blockIndex], formationSlots(formation)[source], source)) return true;
        plans[source][blockIndex] = [...sourcePlan, candidate.name];
        plans[target][blockIndex] = plans[target][blockIndex].filter((name) => name !== candidate.name);
      }
    }
    return false;
  };
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    for (const position of positions) while (plans[position][blockIndex].length < formation[position]) {
      if (!augmentGroupAtBlock(position, blockIndex)) break;
    }
  }

  // Last resort: fill every remaining slot with any available non-excluded
  // player, retaining limits whenever a legal candidate exists.
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    const half = blockHalf(blockIndex, game.total_blocks);
    for (const position of positions) {
      while (plans[position][blockIndex].length < formation[position]) {
        const assigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((group) => plans[group][blockIndex])]);
        const emergency = needsEmergencyFieldAssignment(game, roster, formation, goalkeeperNames[blockIndex] ?? '');
        const eligible = new Set([
          ...eligiblePlayers(roster, position),
          ...backupEligiblePlayers(roster, position),
        ].map((player) => player.name));
        const candidates = emergency
          ? roster.filter((player) => player.available && !assigned.has(player.name) && player.name !== goalkeeperNames[blockIndex] && !player.primary_positions.some((position) => position.toUpperCase() === 'GK'))
          : roster.filter((player) => eligible.has(player.name) && player.available && !assigned.has(player.name) && !player.excluded_positions.includes(position) && player.name !== goalkeeperNames[blockIndex]);
        const legal = candidates.filter((player) => usable(player, position, blockIndex, emergency));
        const player = [...legal].sort((left, right) => shortageMode
          ? compareShortagePlayers(left, right, new Set(plans[position][blockIndex - 1] ?? []))
          : comparePlayerKeys(left, right, position, blockIndex, new Set(plans[position][blockIndex - 1] ?? [])))[0];
        if (!player) break;
        plans[position][blockIndex].push(player.name);
        const counts = halfCounts.get(player.name) ?? [0, 0] as [number, number]; counts[half] += 1; halfCounts.set(player.name, counts);
        rawCounts.set(player.name, (rawCounts.get(player.name) ?? 0) + 1); fieldCounts.set(player.name, (fieldCounts.get(player.name) ?? 0) + 1);
      }
    }
  }

  // Rebalance a short group from an earlier block before reporting a deficit.
  // This preserves quota capacity while allowing a newly eligible backup to
  // cover the final block where the greedy pass may have exhausted normals.
  for (const position of positions) {
    for (let blockIndex = game.total_blocks - 1; blockIndex >= Math.max(0, startBlock - 1); blockIndex -= 1) {
      while (plans[position][blockIndex].length < formation[position]) {
        const targetAssigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((group) => plans[group][blockIndex])]);
        const candidates = roster.filter((candidate) => !targetAssigned.has(candidate.name)
          && canCoverGroup(game, roster, candidate.name, position)
          && candidate.name !== goalkeeperNames[blockIndex]);
        let repaired = false;
        for (const candidate of candidates) {
          const sourceIndex = plans[position].findIndex((players, index) => (shortageMode ? index >= 0 : index > 0) && index < blockIndex && players.includes(candidate.name));
          if (sourceIndex < 0) continue;
          const sourceAssigned = new Set([goalkeeperNames[sourceIndex], ...positions.flatMap((group) => plans[group][sourceIndex])]);
          const sourcePlayers = plans[position][sourceIndex];
          for (const replacement of roster) {
            if (replacement.name === candidate.name || sourceAssigned.has(replacement.name) || replacement.name === goalkeeperNames[sourceIndex]) continue;
            if (!canCoverGroup(game, roster, replacement.name, position) || !usable(replacement, position, sourceIndex)) continue;
            const sourcePlan = sourcePlayers.map((name) => name === candidate.name ? replacement.name : name);
            const targetPlan = [...plans[position][blockIndex], candidate.name];
            if (!completeExactAssignmentExists(roster, sourcePlan, formationSlots(formation)[position], position)
              || !completeExactAssignmentExists(roster, targetPlan, formationSlots(formation)[position], position)) continue;
            const sourceHalf = blockHalf(sourceIndex, game.total_blocks);
            const targetHalf = blockHalf(blockIndex, game.total_blocks);
            const candidateHalfCounts = halfCounts.get(candidate.name) ?? [0, 0] as [number, number];
            const replacementHalfCounts = halfCounts.get(replacement.name) ?? [0, 0] as [number, number];
            rawCounts.set(candidate.name, Math.max(0, (rawCounts.get(candidate.name) ?? 0) - 1));
            fieldCounts.set(candidate.name, Math.max(0, (fieldCounts.get(candidate.name) ?? 0) - 1));
            candidateHalfCounts[sourceHalf] -= 1;
            rawCounts.set(replacement.name, (rawCounts.get(replacement.name) ?? 0) + 1);
            fieldCounts.set(replacement.name, (fieldCounts.get(replacement.name) ?? 0) + 1);
            replacementHalfCounts[sourceHalf] += 1;
            plans[position][sourceIndex] = sourcePlan;
            plans[position][blockIndex] = targetPlan;
            rawCounts.set(candidate.name, (rawCounts.get(candidate.name) ?? 0) + 1);
            fieldCounts.set(candidate.name, (fieldCounts.get(candidate.name) ?? 0) + 1);
            candidateHalfCounts[targetHalf] += 1;
            halfCounts.set(candidate.name, candidateHalfCounts);
            halfCounts.set(replacement.name, replacementHalfCounts);
            repaired = true;
            break;
          }
          if (repaired) break;
        }
        if (!repaired) break;
      }
    }
  }

  // If a group is still short after same-group rebalance, try one cross-group
  // exchange from an earlier block. This preserves the target formation while
  // moving capacity between positional pools.
  for (const targetPosition of positions) {
    for (let targetBlock = game.total_blocks - 1; targetBlock >= Math.max(0, startBlock - 1); targetBlock -= 1) {
      while (plans[targetPosition][targetBlock].length < formation[targetPosition]) {
        let repaired = false;
        const targetAssigned = new Set([goalkeeperNames[targetBlock], ...positions.flatMap((group) => plans[group][targetBlock])]);
        for (const sourcePosition of positions) {
          if (sourcePosition === targetPosition) continue;
          for (let sourceBlock = Math.max(1, startBlock - 1); sourceBlock < targetBlock && !repaired; sourceBlock += 1) {
            const sourceAssigned = new Set([goalkeeperNames[sourceBlock], ...positions.flatMap((group) => plans[group][sourceBlock])]);
            for (const candidateName of [...plans[sourcePosition][sourceBlock]]) {
              const candidate = playersByName.get(candidateName);
              if (!candidate || targetAssigned.has(candidateName) || !canCoverGroup(game, roster, candidateName, targetPosition)) continue;
              const targetPlan = [...plans[targetPosition][targetBlock], candidateName];
              if (targetPlan.length !== formation[targetPosition]
                || !completeExactAssignmentExists(roster, targetPlan, formationSlots(formation)[targetPosition], targetPosition)) continue;
              for (const replacement of roster) {
                if (!replacement.available || replacement.name === candidateName || sourceAssigned.has(replacement.name)
                  || replacement.name === goalkeeperNames[sourceBlock] || !canCoverGroup(game, roster, replacement.name, sourcePosition)
                  || !usable(replacement, sourcePosition, sourceBlock)) continue;
                const sourcePlan = plans[sourcePosition][sourceBlock].map((name) => name === candidateName ? replacement.name : name);
                if (!completeExactAssignmentExists(roster, sourcePlan, formationSlots(formation)[sourcePosition], sourcePosition)) continue;
                plans[targetPosition][targetBlock] = targetPlan;
                plans[sourcePosition][sourceBlock] = sourcePlan;
                const candidateSourceHalf = blockHalf(sourceBlock, game.total_blocks);
                const candidateTargetHalf = blockHalf(targetBlock, game.total_blocks);
                const candidateCounts = halfCounts.get(candidateName) ?? [0, 0] as [number, number];
                candidateCounts[candidateSourceHalf] -= 1;
                candidateCounts[candidateTargetHalf] += 1;
                halfCounts.set(candidateName, candidateCounts);
                const replacementCounts = halfCounts.get(replacement.name) ?? [0, 0] as [number, number];
                replacementCounts[candidateSourceHalf] += 1;
                halfCounts.set(replacement.name, replacementCounts);
                repaired = true;
                break;
              }
              if (repaired) break;
            }
            if (repaired) break;
          }
          if (repaired) break;
        }
        if (!repaired) break;
      }
    }
  }

  // Dual-role goalkeepers must receive their legal field minimum outside the
  // half in which they are assigned as goalkeeper.
  for (const goalkeeper of roster.filter((player) => assignedGoalkeepers.has(player.name))) {
    const goalkeeperBlock = goalkeeperNames.findIndex((name) => name === goalkeeper.name);
    const goalkeeperHalf = goalkeeperBlock < 0 ? -1 : blockHalf(goalkeeperBlock, game.total_blocks);
    while ((fieldCounts.get(goalkeeper.name) ?? 0) < goalkeeper.gk_field_minimum_blocks) {
      let repaired = false;
      for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks && !repaired; blockIndex += 1) {
        if (blockHalf(blockIndex, game.total_blocks) === goalkeeperHalf) continue;
        const assigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((group) => plans[group][blockIndex])]);
        if (assigned.has(goalkeeper.name)) continue;
        for (const position of positions) {
          if (!canCoverGroup(game, roster, goalkeeper.name, position) || !usable(goalkeeper, position, blockIndex)) continue;
          const current = plans[position][blockIndex];
          for (const donorName of current) {
            const donor = playersByName.get(donorName);
            if (!donor || assignedGoalkeepers.has(donor.name)) continue;
            const replacement = current.map((name) => name === donor.name ? goalkeeper.name : name);
            if (!completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position)) continue;
            plans[position][blockIndex] = replacement;
            const half = blockHalf(blockIndex, game.total_blocks);
            rawCounts.set(donor.name, Math.max(0, (rawCounts.get(donor.name) ?? 0) - 1));
            fieldCounts.set(donor.name, Math.max(0, (fieldCounts.get(donor.name) ?? 0) - 1));
            const donorHalfCounts = halfCounts.get(donor.name) ?? [0, 0] as [number, number];
            donorHalfCounts[half] -= 1;
            halfCounts.set(donor.name, donorHalfCounts);
            rawCounts.set(goalkeeper.name, (rawCounts.get(goalkeeper.name) ?? 0) + 1);
            fieldCounts.set(goalkeeper.name, (fieldCounts.get(goalkeeper.name) ?? 0) + 1);
            const goalkeeperHalfCounts = halfCounts.get(goalkeeper.name) ?? [0, 0] as [number, number];
            goalkeeperHalfCounts[half] += 1;
            halfCounts.set(goalkeeper.name, goalkeeperHalfCounts);
            repaired = true;
            break;
          }
          if (repaired) break;
        }
      }
      if (!repaired) break;
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
        for (let blockIndex = Math.max(1, startBlock - 1); blockIndex < game.total_blocks - 1 && !repaired; blockIndex += 1) {
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

  // Quota repairs may replace an endpoint core player. Restore every legal
  // endpoint reservation after all other repairs have finished.
  for (const player of roster) {
    rawCounts.set(player.name, player.block_count);
    fieldCounts.set(player.name, player.block_count);
    halfCounts.set(player.name, [...player.blocks_by_half] as [number, number]);
  }
  for (const [blockIndex, goalkeeperName] of goalkeeperNames.entries()) {
    if (!goalkeeperName) continue;
    rawCounts.set(goalkeeperName, (rawCounts.get(goalkeeperName) ?? 0) + 1);
    const counts = halfCounts.get(goalkeeperName) ?? [0, 0] as [number, number];
    counts[blockHalf(blockIndex, game.total_blocks)] += 1;
    halfCounts.set(goalkeeperName, counts);
  }
  for (const position of positions) {
    for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
      for (const playerName of plans[position][blockIndex]) {
        rawCounts.set(playerName, (rawCounts.get(playerName) ?? 0) + 1);
        fieldCounts.set(playerName, (fieldCounts.get(playerName) ?? 0) + 1);
        const counts = halfCounts.get(playerName) ?? [0, 0] as [number, number];
        counts[blockHalf(blockIndex, game.total_blocks)] += 1;
        halfCounts.set(playerName, counts);
      }
    }
  }
  repairCoreReservations(0, game.total_blocks);

  // Endpoint lineups are solved as one locked unit after all ordinary repairs.
  // This prevents quota and rescue passes from undoing primary/general/backup
  // priority while still allowing non-core players to fill leftover slots.
  const endpointBlocks = [...new Set([0, game.total_blocks - 1])];
  const endpointSolutions = new Map<number, EndpointLineup>();
  for (const blockIndex of endpointBlocks) {
    if (blockIndex < Math.max(0, startBlock - 1) || blockIndex >= game.total_blocks) continue;
    const preferredNames = new Set(positions.flatMap((position) => plans[position][blockIndex]));
    const solved = solveEndpointLineup(roster, formation, goalkeeperNames[blockIndex], game.season_position_starts, preferredNames);
    endpointSolutions.set(blockIndex, solved);
    plans.D[blockIndex] = solved.groups.D;
    plans.M[blockIndex] = solved.groups.M;
    plans.F[blockIndex] = solved.groups.F;
  }
  for (const [blockIndex, solved] of endpointSolutions) {
    for (const coreName of solved.assignedCore) {
      const core = playersByName.get(coreName);
      if (!core) continue;
      const endpointCount = endpointBlocks.filter((endpoint) => positions.some((position) => plans[position][endpoint].includes(coreName))).length;
      let countOutsideEndpoint = positions.reduce((total, position) => total + plans[position]
        .filter((plan, planIndex) => !endpointBlocks.includes(planIndex) && plan.includes(coreName)).length, 0);
      const excess = Math.max(0, countOutsideEndpoint - (core.hard_maximum_blocks - endpointCount));
      for (let removed = 0; removed < excess; removed += 1) {
        let replaced = false;
        for (let priorBlock = 1; priorBlock < game.total_blocks - 1 && !replaced; priorBlock += 1) {
          const assigned = new Set([goalkeeperNames[priorBlock], ...positions.flatMap((position) => plans[position][priorBlock])]);
          for (const position of positions) {
            const coreIndex = plans[position][priorBlock].indexOf(coreName);
            if (coreIndex < 0) continue;
            const liveCount = (name: string): number => positions.reduce((total, candidatePosition) => total
              + plans[candidatePosition].filter((plan) => plan.includes(name)).length, 0);
            const replacement = roster
              .filter((player) => player.available
                && player.name !== goalkeeperNames[priorBlock] && !assigned.has(player.name)
                && liveCount(player.name) < player.hard_maximum_blocks
                && canCoverGroup(game, roster, player.name, position))
              .sort((left, right) => liveCount(left.name) - liveCount(right.name)
                || positionalPriority(left, position) - positionalPriority(right, position)
                || left.name.localeCompare(right.name))[0];
            if (replacement) {
              const replacementPlan = [...plans[position][priorBlock]];
              replacementPlan[coreIndex] = replacement.name;
              if (completeExactAssignmentExists(roster, replacementPlan, formationSlots(formation)[position], position)) {
                plans[position][priorBlock] = replacementPlan;
                countOutsideEndpoint -= 1;
                replaced = true;
                break;
              }
            }
            for (const otherPosition of positions) {
              if (otherPosition === position) continue;
              for (const candidateName of plans[otherPosition][priorBlock]) {
                const candidate = playersByName.get(candidateName);
                if (!candidate || candidate.name === coreName || !canCoverGroup(game, roster, candidate.name, position)) continue;
                const sourceIndex = plans[otherPosition][priorBlock].indexOf(candidate.name);
                const sourceAssigned = new Set([goalkeeperNames[priorBlock], ...positions.flatMap((candidatePosition) => plans[candidatePosition][priorBlock])]);
                const sourceReplacement = roster
                  .filter((player) => player.available && player.name !== candidate.name
                    && player.name !== goalkeeperNames[priorBlock] && !sourceAssigned.has(player.name)
                    && liveCount(player.name) < player.hard_maximum_blocks
                    && canCoverGroup(game, roster, player.name, otherPosition))
                  .sort((left, right) => liveCount(left.name) - liveCount(right.name)
                    || positionalPriority(left, otherPosition) - positionalPriority(right, otherPosition)
                    || left.name.localeCompare(right.name))[0];
                if (!sourceReplacement) continue;
                const targetPlan = [...plans[position][priorBlock]];
                targetPlan[coreIndex] = candidate.name;
                const sourcePlan = [...plans[otherPosition][priorBlock]];
                sourcePlan[sourceIndex] = sourceReplacement.name;
                if (!completeExactAssignmentExists(roster, targetPlan, formationSlots(formation)[position], position)
                  || !completeExactAssignmentExists(roster, sourcePlan, formationSlots(formation)[otherPosition], otherPosition)) continue;
                plans[position][priorBlock] = targetPlan;
                plans[otherPosition][priorBlock] = sourcePlan;
                countOutsideEndpoint -= 1;
                replaced = true;
                break;
              }
              if (replaced) break;
            }
            if (replaced) break;
          }
        }
        if (!replaced) break;
      }
    }
  }

  // Final quota repair runs after endpoint locking. Only middle blocks may be
  // changed, so endpoint core protection cannot be undone by balancing.
  const liveCount = (name: string): number => positions.reduce((total, position) => total
    + plans[position].filter((plan) => plan.includes(name)).length, 0);
  const liveHalfCount = (name: string, half: 0 | 1): number => positions.reduce((total, position) => total
    + plans[position].filter((plan, index) => blockHalf(index, game.total_blocks) === half && plan.includes(name)).length, 0);
  const middleBlocks = Array.from({ length: Math.max(0, game.total_blocks - 2) }, (_, index) => index + 1);
  const replaceMiddleAssignment = (donorName: string, half: 0 | 1 | null): boolean => {
    for (const blockIndex of middleBlocks) {
      if (half !== null && blockHalf(blockIndex, game.total_blocks) !== half) continue;
      const assigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((position) => plans[position][blockIndex])]);
      for (const position of positions) {
        const donorIndex = plans[position][blockIndex].indexOf(donorName);
        if (donorIndex < 0) continue;
        const direct = roster
          .filter((player) => player.available && !assignedGoalkeepers.has(player.name) && player.name !== goalkeeperNames[blockIndex] && !assigned.has(player.name)
            && liveCount(player.name) < player.hard_maximum_blocks && canCoverGroup(game, roster, player.name, position))
          .sort((left, right) => liveCount(left.name) - liveCount(right.name)
            || positionalPriority(left, position) - positionalPriority(right, position)
            || left.name.localeCompare(right.name))[0];
        if (direct) {
          const replacementPlan = [...plans[position][blockIndex]];
          replacementPlan[donorIndex] = direct.name;
          const replacementSlots = assignExactSlots(roster, replacementPlan, formationSlots(formation)[position], position, {});
          if (!Object.values(replacementSlots).includes('UNASSIGNED')) {
            plans[position][blockIndex] = replacementPlan;
            return true;
          }
        }
        for (const otherPosition of positions) {
          if (otherPosition === position) continue;
          for (const candidateName of plans[otherPosition][blockIndex]) {
            const candidate = playersByName.get(candidateName);
            if (!candidate || candidate.name === donorName || !canCoverGroup(game, roster, candidate.name, position)) continue;
            const sourceIndex = plans[otherPosition][blockIndex].indexOf(candidate.name);
            const sourceReplacement = roster
              .filter((player) => player.available && !assignedGoalkeepers.has(player.name) && player.name !== candidate.name && player.name !== goalkeeperNames[blockIndex]
                && !assigned.has(player.name) && liveCount(player.name) < player.hard_maximum_blocks
                && canCoverGroup(game, roster, player.name, otherPosition))
              .sort((left, right) => liveCount(left.name) - liveCount(right.name)
                || positionalPriority(left, otherPosition) - positionalPriority(right, otherPosition)
                || left.name.localeCompare(right.name))[0];
            if (!sourceReplacement) continue;
            const targetPlan = [...plans[position][blockIndex]];
            targetPlan[donorIndex] = candidate.name;
            const sourcePlan = [...plans[otherPosition][blockIndex]];
            sourcePlan[sourceIndex] = sourceReplacement.name;
            if (!completeExactAssignmentExists(roster, targetPlan, formationSlots(formation)[position], position)
              || !completeExactAssignmentExists(roster, sourcePlan, formationSlots(formation)[otherPosition], otherPosition)) continue;
            plans[position][blockIndex] = targetPlan;
            plans[otherPosition][blockIndex] = sourcePlan;
            return true;
          }
        }
      }
    }
    return false;
  };
  for (const donor of roster.filter((player) => player.available && !assignedGoalkeepers.has(player.name))) {
    while (liveCount(donor.name) > donor.hard_maximum_blocks && replaceMiddleAssignment(donor.name, null)) {}
  }
  for (const donor of roster.filter((player) => player.available && !assignedGoalkeepers.has(player.name))) {
    for (const half of [0, 1] as const) {
      while (liveHalfCount(donor.name, half) > donor.max_blocks_per_half && replaceMiddleAssignment(donor.name, half)) {}
    }
  }
  for (const deficit of roster
    .filter((player) => player.available && !assignedGoalkeepers.has(player.name))
    .sort((left, right) => (right.hard_minimum_blocks - liveCount(right.name)) - (left.hard_minimum_blocks - liveCount(left.name)) || left.name.localeCompare(right.name))) {
    while (liveCount(deficit.name) < deficit.hard_minimum_blocks) {
      let repaired = false;
      for (const blockIndex of middleBlocks) {
        const assigned = new Set([goalkeeperNames[blockIndex], ...positions.flatMap((position) => plans[position][blockIndex])]);
        if (assigned.has(deficit.name)) continue;
        for (const position of positions) {
          const current = plans[position][blockIndex];
          for (const donorName of current) {
            const donor = playersByName.get(donorName);
            if (!donor || assignedGoalkeepers.has(donor.name) || liveCount(donor.name) <= donor.hard_minimum_blocks
              || !canCoverGroup(game, roster, deficit.name, position)) continue;
            const replacement = current.map((name) => name === donor.name ? deficit.name : name);
            if (!completeExactAssignmentExists(roster, replacement, formationSlots(formation)[position], position)) continue;
            plans[position][blockIndex] = replacement;
            repaired = true;
            break;
          }
          if (repaired) break;
        }
        if (repaired) break;
      }
      if (!repaired) break;
    }
  }
  // Late cross-group repairs can move a player without removing an older
  // occurrence from another group. Normalize those duplicates before
  // materialization, where the block-wide used set would otherwise drop one.
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    const seen = new Set([goalkeeperNames[blockIndex]]);
    for (const position of positions) {
      for (let playerIndex = 0; playerIndex < plans[position][blockIndex].length; playerIndex += 1) {
        const name = plans[position][blockIndex][playerIndex];
        if (!seen.has(name)) {
          seen.add(name);
          continue;
        }
        const replacement = roster
          .filter((player) => player.available && !seen.has(player.name) && canCoverGroup(game, roster, player.name, position) && usable(player, position, blockIndex))
          .sort((left, right) => comparePlayerKeys(left, right, position, blockIndex, seen)
            || left.name.localeCompare(right.name))
          .find((player) => {
            const candidate = [...plans[position][blockIndex]];
            candidate[playerIndex] = player.name;
            return completeExactAssignmentExists(roster, candidate, formationSlots(formation)[position], position);
          });
        if (replacement) {
          plans[position][blockIndex][playerIndex] = replacement.name;
          seen.add(replacement.name);
        }
      }
    }
  }
  const acceptedFieldCounts = new Map<string, number>();
  const acceptedHalfCounts = new Map<string, [number, number]>();
  for (const player of roster) {
    acceptedFieldCounts.set(player.name, 0);
    acceptedHalfCounts.set(player.name, [0, 0]);
  }
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    const half = blockHalf(blockIndex, game.total_blocks);
    const goalkeeper = goalkeeperNames[blockIndex];
    if (goalkeeper) {
      acceptedFieldCounts.set(goalkeeper, acceptedFieldCounts.get(goalkeeper) ?? 0);
      const counts = acceptedHalfCounts.get(goalkeeper) ?? [0, 0] as [number, number];
      counts[half] += 1;
      acceptedHalfCounts.set(goalkeeper, counts);
    }
    for (const position of positions) {
      plans[position][blockIndex] = plans[position][blockIndex].filter((name) => {
        const player = playersByName.get(name);
        if (!player) return false;
        const fieldCount = acceptedFieldCounts.get(name) ?? 0;
        const halfCountsForPlayer = acceptedHalfCounts.get(name) ?? [0, 0] as [number, number];
        const totalCount = fieldCount + (goalkeeperNames.filter((value) => value === name).length);
        const allowed = game.disable_maximum_limits || (totalCount < player.hard_maximum_blocks
          && halfCountsForPlayer[half] < player.max_blocks_per_half
          && (!assignedGoalkeepers.has(name) || fieldCount < player.gk_field_maximum_blocks));
        if (!allowed) return false;
        acceptedFieldCounts.set(name, fieldCount + 1);
        halfCountsForPlayer[half] += 1;
        acceptedHalfCounts.set(name, halfCountsForPlayer);
        return true;
      });
    }
  }
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) {
    reserved[blockIndex].clear();
    if (goalkeeperNames[blockIndex]) reserved[blockIndex].add(goalkeeperNames[blockIndex]);
    for (const position of positions) plans[position][blockIndex].forEach((name) => reserved[blockIndex].add(name));
  }
  refreshPlanningCounts();
  for (let blockIndex = Math.max(0, startBlock - 1); blockIndex < game.total_blocks; blockIndex += 1) repairShortBlock(blockIndex);
  return plans;
}

export function buildTimeline(game: Game, roster: Player[], startBlock = 1, frozenTimeline: ScheduleBlock[] = [], quotaFeasibility?: QuotaFeasibilityMetadata): RotationResult {
  game.quota_feasibility = quotaFeasibility;
  const result: RotationResult = { timeline: [...frozenTimeline], block_counts: {}, gk_summary: {}, position_summary: {}, warnings: [], errors: [], metadata: { total_blocks: game.total_blocks, formation: game.formation, gk_assignment: game.gk_assignment } };
  result.errors.push(...goalkeeperSelectionErrors(game, roster));
  const formation = parseFormation(game.formation); const slots = formationSlots(formation); const goalkeepers: Array<Player | null> = [];
  for (let block = 1; block <= game.total_blocks; block++) {
    const goalkeeper = game.has_goalkeeper === false
      ? null
      : block < startBlock ? roster.find((player) => player.name === frozenTimeline[block - 1]?.GK) ?? null : chooseGk(game, roster, block);
    goalkeepers.push(goalkeeper);
  }
  const planned = planPositionGroups(game, roster, formation, goalkeepers.map((player) => player?.name ?? ''), startBlock);
  optimizeGlobalPositionSwitches(game, roster, formation, planned, startBlock);
  if (game.disable_maximum_limits) {
    const plannedCount = (name: string): number => FIELD_GROUPS.reduce((total, group) => total + planned[group].filter((players) => players.includes(name)).length, 0);
    for (let blockIndex = 0; blockIndex < game.total_blocks; blockIndex += 1) {
      const used = new Set([goalkeepers[blockIndex]?.name]);
      for (const group of FIELD_GROUPS) {
        const slots = formationSlots(formation)[group];
        for (let playerIndex = 0; playerIndex < planned[group][blockIndex].length; playerIndex += 1) {
          const currentName = planned[group][blockIndex][playerIndex];
          if (!used.has(currentName)) {
            used.add(currentName);
            continue;
          }
          const replacement = roster
            .filter((player) => player.available && !used.has(player.name) && player.name !== goalkeepers[blockIndex]?.name && canCoverGroup(game, roster, player.name, group))
            .sort((left, right) => plannedCount(left.name) - plannedCount(right.name) || left.name.localeCompare(right.name))
            .find((player) => {
              const candidate = [...planned[group][blockIndex]];
              candidate[playerIndex] = player.name;
              return completeExactAssignmentExists(roster, candidate, slots, group);
            });
          if (replacement) {
            planned[group][blockIndex][playerIndex] = replacement.name;
            used.add(replacement.name);
          }
        }
      }
    }
    const fieldNames = roster.filter((player) => player.available && !goalkeepers.some((goalkeeper) => goalkeeper?.name === player.name)).map((player) => player.name);
    const overridePhase = (player: Player, count: number): number => count < Math.floor(game.total_blocks * 0.7) ? 0
      : count < Math.floor(game.total_blocks * 0.8) ? 1
        : CORE_GROUPS.has(player.group) && count < Math.floor(game.total_blocks * 0.9) ? 2
          : player.group === 'rotational' && count < Math.floor(game.total_blocks * 0.9) ? 3
            : ['developing', 'developmental'].includes(player.group) && count < Math.floor(game.total_blocks * 0.9) ? 4
              : count < game.total_blocks ? 5 : 6;
    let changed = true;
    let swapBudget = fieldNames.length * game.total_blocks * 4;
    while (changed && swapBudget > 0) {
      changed = false;
      const lowPlayers = fieldNames.filter((name) => plannedCount(name) < game.total_blocks).sort((left, right) => {
        const leftPlayer = roster.find((player) => player.name === left);
        const rightPlayer = roster.find((player) => player.name === right);
        return overridePhase(leftPlayer!, plannedCount(left)) - overridePhase(rightPlayer!, plannedCount(right))
          || plannedCount(left) - plannedCount(right) || left.localeCompare(right);
      });
      const highPlayers = fieldNames.filter((name) => plannedCount(name) > 0).sort((left, right) => {
        const leftPlayer = roster.find((player) => player.name === left);
        const rightPlayer = roster.find((player) => player.name === right);
        return overridePhase(rightPlayer!, plannedCount(right)) - overridePhase(leftPlayer!, plannedCount(left))
          || plannedCount(right) - plannedCount(left) || left.localeCompare(right);
      });
      for (const lowName of lowPlayers) {
        for (const highName of highPlayers) {
          const lowPlayer = roster.find((player) => player.name === lowName);
          const highPlayer = roster.find((player) => player.name === highName);
          if (!lowPlayer || !highPlayer || (overridePhase(lowPlayer, plannedCount(lowName)) >= overridePhase(highPlayer, plannedCount(highName))
            && plannedCount(lowName) >= plannedCount(highName))) continue;
          for (const group of FIELD_GROUPS) {
            if (!canCoverGroup(game, roster, lowName, group)) continue;
            for (let blockIndex = 0; blockIndex < game.total_blocks; blockIndex += 1) {
              const lowPlayer = roster.find((player) => player.name === lowName);
              const highPlayer = roster.find((player) => player.name === highName);
              const isEndpoint = blockIndex === 0 || blockIndex === game.total_blocks - 1;
              if (isEndpoint && (!lowPlayer || !highPlayer || !CORE_GROUPS.has(lowPlayer.group) || CORE_GROUPS.has(highPlayer.group))) continue;
              const current = planned[group][blockIndex];
              const blockAssigned = new Set(FIELD_GROUPS.flatMap((candidateGroup) => planned[candidateGroup][blockIndex]));
              if (!current.includes(highName) || blockAssigned.has(lowName)) continue;
              const replacement = current.map((name) => name === highName ? lowName : name);
              if (!completeExactAssignmentExists(roster, replacement, formationSlots(formation)[group], group)) continue;
              planned[group][blockIndex] = replacement;
              swapBudget -= 1;
              changed = true;
              break;
            }
            if (changed) break;
          }
          if (changed) break;
        }
        if (changed) break;
      }
    }
  }
  const plannedFieldCount = (name: string): number => FIELD_GROUPS.reduce((total, group) => total + planned[group].filter((players) => players.includes(name)).length, 0);
  const plannedHalfCount = (name: string, half: 0 | 1): number => FIELD_GROUPS.reduce((total, group) => total + planned[group].filter((players, index) => blockHalf(index, game.total_blocks) === half && players.includes(name)).length, 0);
  const materializedCount = (name: string): number => result.timeline.reduce((total, block) => total + (block.GK === name || FIELD_GROUPS.some((group) => block[group].includes(name)) ? 1 : 0), 0);
  const materializedHalfCount = (name: string, half: 0 | 1): number => result.timeline.reduce((total, block, index) => total + (blockHalf(index, game.total_blocks) === half && (block.GK === name || FIELD_GROUPS.some((group) => block[group].includes(name)) ? 1 : 0)), 0);
  let previousPositions: Record<string, string> = startBlock > 1 ? { ...(frozenTimeline[startBlock - 2]?.positions ?? {}) } : {};
  for (let block = startBlock; block <= game.total_blocks; block++) {
    const half: 0 | 1 = block <= Math.ceil(game.total_blocks / 2) ? 0 : 1; const gk = goalkeepers[block - 1]; const used = new Set(gk ? [gk.name] : []);
    const missingGoalkeeper = game.has_goalkeeper === false ? '' : 'NO GK AVAILABLE';
    const assignment = { GK: gk?.name ?? missingGoalkeeper, D: [] as string[], M: [] as string[], F: [] as string[], bench: [] as string[], positions: (gk ? { GK: gk.name } : game.has_goalkeeper === false ? {} : { GK: missingGoalkeeper }) as Record<string, string> };
    for (const group of ['D', 'M', 'F'] as const) {
      let chosen = planned[group][block - 1]
        .map((name) => roster.find((player) => player.name === name))
        .filter((player): player is Player => player !== undefined
          && !used.has(player.name)
          && (game.disable_maximum_limits
            || (player.block_count < player.hard_maximum_blocks
              && player.blocks_by_half[half] < player.max_blocks_per_half
              && (!goalkeepers.some((goalkeeper) => goalkeeper?.name === player.name)
                || player.field_blocks < player.gk_field_maximum_blocks))));
      const emergency = needsEmergencyFieldAssignment(game, roster, formation, gk?.name ?? '');
      if (chosen.length < formation[group]) {
        const slotsForGroup = slots[group];
        const candidates = roster.filter((player) => player.available && !used.has(player.name) && !player.excluded_positions.includes(group)
          && (emergency
            ? player.name !== gk?.name && !player.primary_positions.some((position) => position.toUpperCase() === 'GK')
            : eligiblePlayers(roster, group).some((candidate) => candidate.name === player.name)
              || backupEligiblePlayers(roster, group).some((candidate) => candidate.name === player.name)));
        const quotaCandidates = candidates.filter((player) => game.disable_maximum_limits
          || (materializedCount(player.name) < player.hard_maximum_blocks
            && materializedHalfCount(player.name, half) < player.max_blocks_per_half
            && (!goalkeepers.some((goalkeeper) => goalkeeper?.name === player.name)
              || result.timeline.reduce((total, block) => total + (block.D.includes(player.name) || block.M.includes(player.name) || block.F.includes(player.name) ? 1 : 0), 0) < player.gk_field_maximum_blocks)));
        const candidatePools = game.disable_maximum_limits ? [candidates] : [quotaCandidates];
        const validChoice = emergency ? undefined : candidatePools
          .map((pool) => findCombination(
            pool,
            formation[group] - chosen.length,
            (choice) => completeExactAssignmentExists(roster, [...chosen, ...choice].map((player) => player.name), slotsForGroup, group),
            4096,
          ))
          .find((choice) => choice !== undefined);
        const additional = emergency
          ? [...chosen, ...(candidatePools[0] ?? []).slice(0, formation[group] - chosen.length)]
          : validChoice ? [...chosen, ...validChoice] : undefined;
        if (additional) chosen = additional;
      }
      assignment[group] = chosen.map((player) => player.name); chosen.forEach((player) => used.add(player.name));
      const exactAssignment = assignExactSlots(roster, assignment[group], slots[group], group, previousPositions, game.season_position_starts, emergency);
      Object.assign(assignment.positions, exactAssignment);
      if (Object.values(exactAssignment).some((name) => name === 'UNASSIGNED')) result.errors.push(`Block ${block}: ${group} players cannot form a complete legal exact-slot assignment.`);
      if (chosen.length < formation[group]) result.errors.push(`Block ${block}: ${group} requires ${formation[group]} players but only ${chosen.length} were assigned.`);
    }
    for (const player of roster) if (!used.has(player.name)) assignment.bench.push(player.name);
    previousPositions = { ...assignment.positions };
    applyBlockToStats(roster, assignment, half); if (game.has_goalkeeper !== false && !gk) result.errors.push(`Block ${block}: no goalkeeper was assigned.`);
    result.timeline.push(assignment);
  }
  for (const blockIndex of new Set([0, game.total_blocks - 1])) {
    const assignedFieldPlayers = new Set([
      ...result.timeline[blockIndex].D,
      ...result.timeline[blockIndex].M,
      ...result.timeline[blockIndex].F,
    ]);
    const endpointFieldCapacity = formation.D + formation.M + formation.F;
    const endpointCorePlayers = roster.filter((player) => player.available
      && CORE_GROUPS.has(player.group)
      && player.name !== goalkeepers[blockIndex]?.name
      && player.general_positions.some((position) => ['ANY', 'D', 'M', 'F'].includes(position)));
    if (endpointCorePlayers.length > endpointFieldCapacity) continue;
    roster
      .filter((player) => player.available && CORE_GROUPS.has(player.group)
        && player.name !== goalkeepers[blockIndex]?.name
        && player.general_positions.some((position) => ['ANY', 'D', 'M', 'F'].includes(position)))
      .filter((player) => !assignedFieldPlayers.has(player.name))
      .forEach((player) => result.errors.push(`Block ${blockIndex + 1}: core player ${player.name} could not be assigned to the ${blockIndex === 0 ? 'first' : 'last'} block endpoint; no legal endpoint lineup was available.`));
  }
  result.errors = [...new Set([...result.errors, ...validateTimeline(roster, result.timeline, formation, slots, game.total_blocks)])];
  const firstBlockLocked = startBlock === 1 && result.timeline[0]
    ? { ...result.timeline[0], D: [...result.timeline[0].D], M: [...result.timeline[0].M], F: [...result.timeline[0].F], bench: [...result.timeline[0].bench], positions: { ...result.timeline[0].positions } }
    : null;
  if (firstBlockLocked) {
    const firstBlockErrors = validateTimeline(roster, [firstBlockLocked], formation, slots, 1)
      .filter((error) => !error.includes('exceeds hard maximum') && !error.includes('exceeds the half'));
    if (firstBlockErrors.length) result.errors.push(...firstBlockErrors.map((error) => `First block: ${error}`));
  }
  optimizeExactSlotSwitches(game, roster, result.timeline, slots, firstBlockLocked ? 2 : startBlock);
  if (firstBlockLocked) result.timeline[0] = firstBlockLocked;
  if (game.disable_maximum_limits) {
    const fieldNames = roster
      .filter((player) => player.available && !goalkeepers.some((goalkeeper) => goalkeeper?.name === player.name))
      .map((player) => player.name);
    const fieldCount = (name: string): number => result.timeline.reduce((total, block) => total
      + (FIELD_GROUPS.some((group) => block[group].includes(name)) ? 1 : 0), 0);
    const overridePhase = (player: Player, count: number): number => count < Math.floor(game.total_blocks * 0.7) ? 0
      : count < Math.floor(game.total_blocks * 0.8) ? 1
        : CORE_GROUPS.has(player.group) && count < Math.floor(game.total_blocks * 0.9) ? 2
          : player.group === 'rotational' && count < Math.floor(game.total_blocks * 0.9) ? 3
            : ['developing', 'developmental'].includes(player.group) && count < Math.floor(game.total_blocks * 0.9) ? 4
              : count < game.total_blocks ? 5 : 6;
    let changed = true;
    let swapBudget = fieldNames.length * game.total_blocks * 4;
    while (changed && swapBudget > 0) {
      changed = false;
      const orderedPlayers = fieldNames
        .map((name) => roster.find((player) => player.name === name))
        .filter((player): player is Player => player !== undefined)
        .sort((left, right) => overridePhase(left, fieldCount(left.name)) - overridePhase(right, fieldCount(right.name))
          || fieldCount(left.name) - fieldCount(right.name)
          || left.name.localeCompare(right.name));
      for (const low of orderedPlayers) {
        const lowCount = fieldCount(low.name);
        const donors = [...orderedPlayers].reverse().filter((high) => {
          const highCount = fieldCount(high.name);
          return high.name !== low.name
            && (overridePhase(low, lowCount) < overridePhase(high, highCount)
              || (overridePhase(low, lowCount) === overridePhase(high, highCount) && lowCount < highCount));
        });
        for (const high of donors) {
          for (let blockIndex = 0; blockIndex < result.timeline.length; blockIndex += 1) {
            const block = result.timeline[blockIndex];
            const fieldAssigned = new Set(FIELD_GROUPS.flatMap((group) => block[group]));
            if (fieldAssigned.has(low.name)) continue;
            const group = FIELD_GROUPS.find((candidateGroup) => block[candidateGroup].includes(high.name));
            if (!group || !canCoverGroup(game, roster, low.name, group)) continue;
            const isEndpoint = blockIndex === 0 || blockIndex === result.timeline.length - 1;
            if (isEndpoint && (!CORE_GROUPS.has(low.group) || CORE_GROUPS.has(high.group))) continue;
            const slot = slots[group].find((slotName) => block.positions[slotName] === high.name);
            if (!slot) continue;
            const replacement = block[group].map((name) => name === high.name ? low.name : name);
            if (!completeExactAssignmentExists(roster, replacement, slots[group], group)) continue;
            block[group] = replacement;
            block.positions[slot] = low.name;
            block.bench = block.bench.filter((name) => name !== low.name);
            if (!block.bench.includes(high.name)) block.bench.push(high.name);
            const half = blockHalf(blockIndex, game.total_blocks);
            high.block_count -= 1; high.field_blocks -= 1; high.blocks_by_half[half] -= 1; high.position_usage[group] -= 1;
            low.block_count += 1; low.field_blocks += 1; low.blocks_by_half[half] += 1; low.position_usage[group] += 1;
            swapBudget -= 1;
            changed = true;
            break;
          }
          if (changed) break;
        }
        if (changed) break;
      }
    }
  }
  result.movement_metrics = calculateMovementMetrics(result.timeline, game.total_blocks, roster, slots, game.allow_emergency_assignments);
  result.errors = [...new Set([...result.errors, ...validateTimeline(roster, result.timeline, formation, slots, game.total_blocks)])];
  return result;
}
