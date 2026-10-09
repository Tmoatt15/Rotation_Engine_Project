import type { AvailabilityChange, Game, GameInput, LateArrivalApprovalRequest, LateArrivalApprovalResult, Player, PlayerInput, PositionGroup, RotationResult, ScheduleBlock } from './models';
import { computeBlockTargets } from './quotas';
import { assignExactSlots, buildTimeline, calculateMovementMetrics, completeExactAssignmentExists, estimateAdditionalPlayersNeeded, formationSlots, parseFormation, replayTimeline, validateTimeline } from './timeline';
import { computeSurplus } from './surplus';
import { eligiblePlayers } from './positional';
import { GAME_FORMATS } from './season';

const emptyUsage = () => ({ GK: 0, D: 0, M: 0, F: 0 });

function positionList(value: string | string[] | undefined): string[] {
  return value == null ? [] : (Array.isArray(value) ? value : [value]);
}

export function createPlayer(input: PlayerInput): Player {
  const generalPositions = positionList(input.general_positions ?? input.general_position ?? input.primary_position).map((position) => position.toUpperCase());
  const primaryPositions = positionList(input.primary_positions ?? input.primary_position).map((position) => position.toUpperCase());
  const backupPositions = positionList(input.backup_positions).map((position) => position.toUpperCase());
  const excludedPositions = positionList(input.excluded_positions ?? input.forbidden_positions).map((position) => position.toUpperCase());
  return {
    ...input, group: String(input.group ?? 'rotational').toLowerCase() as Player['group'], core_tier: null, general_positions: generalPositions, primary_positions: primaryPositions.length ? primaryPositions : generalPositions, backup_positions: backupPositions, excluded_positions: excludedPositions, general_position: generalPositions[0] ?? '', primary_position: primaryPositions[0] ?? generalPositions[0] ?? '', forbidden_positions: excludedPositions, positional_group: null, available: true, target_blocks: 0, minimum_blocks: 0, maximum_blocks: 0, hard_minimum_blocks: 0, hard_maximum_blocks: 0, max_blocks_per_half: 1, gk_field_minimum_blocks: 0, gk_field_maximum_blocks: 0, blocks_by_half: [0, 0], block_count: 0, bench_count: 0, position_usage: emptyUsage(), gk_blocks: 0, field_blocks: 0, max_gk_blocks: 5, gk_field_targets_by_half: [0, 0], last_two: [],
  };
}

function prepareGame(input: Game | GameInput): Game {
  const game = input as Game;
  const formatGoalkeeperSetting = game.game_format === undefined ? undefined : GAME_FORMATS[game.game_format]?.has_goalkeeper;
  if (game.game_format !== undefined && formatGoalkeeperSetting === undefined) throw new Error(`Unknown game format: ${game.game_format}.`);
  if (formatGoalkeeperSetting !== undefined && game.has_goalkeeper !== undefined && formatGoalkeeperSetting !== game.has_goalkeeper) {
    throw new Error(`has_goalkeeper conflicts with game_format ${game.game_format}.`);
  }
  const hasGoalkeeper = game.has_goalkeeper ?? formatGoalkeeperSetting ?? true;
  return {
    ...game, game_format: game.game_format, has_goalkeeper: hasGoalkeeper, gk_assignment: game.gk_assignment ?? null, first_half_gk: game.first_half_gk ?? null, second_half_gk: game.second_half_gk ?? null, season_total_games: game.season_total_games ?? 1, season_game_number: game.season_game_number ?? 1, season_seed: game.season_seed ?? 2026, allow_emergency_assignments: game.allow_emergency_assignments ?? game.allow_emergency_positions ?? false, disable_maximum_limits: game.disable_maximum_limits ?? false, is_late_arrival_regen: game.is_late_arrival_regen ?? false, season_player_blocks: game.season_player_blocks ?? {}, season_position_starts: game.season_position_starts ?? {}, season_goalkeeper_starts: game.season_goalkeeper_starts ?? {}, core_high_names: game.core_high_names ?? null, replacement_credits: game.replacement_credits ?? [], replacement_bonuses: game.replacement_bonuses ?? {}, availability_changes: game.availability_changes ?? [], quota_exempt_players: game.quota_exempt_players ?? new Set<string>(), timeline: game.timeline ?? [],
  };
}

function approvalResult(request: LateArrivalApprovalRequest, timeline: ScheduleBlock[], errors: string[], roster: Player[]): LateArrivalApprovalResult {
  const halfLength = Math.ceil(timeline.length / 2);
  const affectedBlocks = request.scope === 'one_block'
    ? (request.block ? [request.block] : [])
    : Array.from({ length: halfLength }, (_, index) => (request.half ?? 0) * halfLength + index + 1)
      .filter((block) => block <= timeline.length);
  const playerAppears = affectedBlocks.filter((blockNumber) => {
    const block = timeline[blockNumber - 1];
    return Boolean(block && [block.GK, ...block.D, ...block.M, ...block.F].includes(request.player));
  });
  const warnings = errors.filter((error) => error.toLowerCase().includes(request.player.toLowerCase()));
  const candidates = [...new Set(affectedBlocks.flatMap((blockNumber) => {
    const block = timeline[blockNumber - 1];
    return block ? [block.GK, ...block.D, ...block.M, ...block.F] : [];
  }))].filter((name) => name && name !== request.player && roster.some((player) => player.name === name));
  if (playerAppears.length !== affectedBlocks.length) {
    warnings.push(`${request.player} is not assigned in every approved ${request.scope === 'one_block' ? 'block' : 'half'} block.`);
  }

  const uniqueWarnings = [...new Set(warnings)];
  return {
    request,
    approved: affectedBlocks.length > 0 && playerAppears.length === affectedBlocks.length && uniqueWarnings.length === 0,
    affected_blocks: affectedBlocks,
    warnings: uniqueWarnings,
    ...(uniqueWarnings.length ? { candidates, prompt: `Review the ${request.scope === 'one_block' ? 'block' : 'half'} exception before applying it.` } : {}),
  };
}

function approvalCandidates(roster: Player[], timeline: ScheduleBlock[], arrival: AvailabilityChange): string[] {
  const halfStart = arrival.block < Math.ceil(timeline.length / 2) ? 0 : Math.ceil(timeline.length / 2);
  const halfEnd = arrival.block < Math.ceil(timeline.length / 2) ? Math.ceil(timeline.length / 2) : timeline.length;
  const approvalBlock = timeline[arrival.block];
  const assignedInApprovalBlock = new Set(approvalBlock ? [approvalBlock.GK, ...approvalBlock.D, ...approvalBlock.M, ...approvalBlock.F] : []);
  return roster
    .filter((player) => player.available && player.name !== arrival.player && !player.primary_positions.includes('GK') && !assignedInApprovalBlock.has(player.name))
    .map((player) => ({
      name: player.name,
      appearances: timeline.slice(halfStart, halfEnd).filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(player.name)).length,
    }))
    .sort((left, right) => left.appearances - right.appearances || left.name.localeCompare(right.name))
    .map((candidate) => candidate.name);
}

function shouldPreflightApproval(game: Game, roster: Player[], arrival: AvailabilityChange, approvedPlayerName?: string): boolean {
  if (!game.is_late_arrival_regen || approvedPlayerName || game.late_arrival_approval) return false;
  if (arrival.block !== 4 || arrival.target_blocks !== 3) return false;
  const player = roster.find((candidate) => candidate.name === arrival.player);
  return player?.group === 'core'
    && player.general_positions.length === 1
    && player.backup_positions.length > 0
    && !player.primary_positions.some((position) => position.toUpperCase() === 'GK');
}

function prepareRoster(roster: Player[]): Player[] { return roster.map((player) => player.position_usage && player.blocks_by_half ? player : createPlayer(player)); }

function startingPositionCounts(timeline: ScheduleBlock[]): Record<string, Record<string, number>> {
  const starts: Record<string, Record<string, number>> = {};
  for (const [position, player] of Object.entries(timeline[0]?.positions ?? {})) {
    starts[player] = { ...(starts[player] ?? {}), [position]: (starts[player]?.[position] ?? 0) + 1 };
  }
  return starts;
}

function finalizeResult(game: Game, roster: Player[], timeline: RotationResult): RotationResult {
  const formation = parseFormation(game.formation);
  const slots = formationSlots(formation);
  const validationErrors = validateTimeline(roster, timeline.timeline, formation, slots, game.total_blocks, game)
    .filter((error) => !game.disable_maximum_limits
      || error.includes('total blocks')
      || error.includes('GK field maximum'));
  return {
    ...timeline,
    errors: [...new Set([...timeline.errors, ...validationErrors])],
    warnings: [...new Set([...timeline.warnings, ...estimateAdditionalPlayersNeeded(timeline.timeline, formation, game.total_blocks)])],
    movement_metrics: calculateMovementMetrics(timeline.timeline, game.total_blocks, roster, slots, game.allow_emergency_assignments),
    starting_position_counts: startingPositionCounts(timeline.timeline),
  };
}

export function runRotationEngine(gameInput: Game | GameInput, rosterInput: Player[]): RotationResult {
  const startedAt = Date.now();
  const game = prepareGame(gameInput); const roster = prepareRoster(rosterInput);
  roster.forEach((player) => { if (!player.position_usage) player.position_usage = emptyUsage(); });
  const preparedAt = Date.now();
  const quota = computeBlockTargets(game, roster);
  const quotaAt = Date.now();
  const timeline = buildTimeline(game, roster, 1, [], quota.metadata.quota_feasibility);
  const timelineAt = Date.now();
  const surplus = computeSurplus(game, roster);
  const result = finalizeResult(game, roster, { timeline: timeline.timeline, block_counts: surplus.block_counts, gk_summary: surplus.gk_summary, position_summary: surplus.position_summary, warnings: [...quota.warnings, ...timeline.warnings, ...surplus.warnings], errors: [...quota.errors, ...timeline.errors, ...surplus.errors], metadata: { ...surplus.metadata, quota_feasibility: quota.metadata.quota_feasibility }, movement_metrics: timeline.movement_metrics });
  console.info('[rotation] initial generation timing', { players: roster.length, prepareMs: preparedAt - startedAt, quotaMs: quotaAt - preparedAt, plannerMs: timelineAt - quotaAt, finalizeMs: Date.now() - timelineAt, totalMs: Date.now() - startedAt });
  return result;
}

export const generateSchedule = runRotationEngine;

export function regenerateSchedule(gameInput: Game | GameInput, rosterInput: Player[], previousTimeline: ScheduleBlock[], changes: AvailabilityChange[], availablePlayerNames?: string[], isLateArrivalRegen = false, approvedPlayerName?: string): RotationResult {
  const game = prepareGame({ ...gameInput, is_late_arrival_regen: isLateArrivalRegen, approved_player_name: approvedPlayerName }); const roster = prepareRoster(rosterInput); const byName = new Map(roster.map((player) => [player.name, player]));
  const approvedBeforeCount = approvedPlayerName
    ? previousTimeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(approvedPlayerName)).length
    : null;
  if (approvedPlayerName) console.info('[rotation] approved-player regen input', { approvedPlayerName, approvedBeforeCount, hasApprovalRequest: Boolean(game.late_arrival_approval) });
  if (availablePlayerNames) {
    const availableNames = new Set(availablePlayerNames);
    roster.forEach((player) => { player.available = availableNames.has(player.name); });
  }
  const updatedTimeline = previousTimeline.map((block) => ({ ...block, D: [...block.D], M: [...block.M], F: [...block.F], bench: [...block.bench], positions: { ...block.positions } }));
  const previousTotalBlocks = new Map(roster.map((player) => [
    player.name,
    previousTimeline.filter((block) => block.GK === player.name || [...block.D, ...block.M, ...block.F].includes(player.name)).length,
  ]));
  const recordAvailabilityChange = (change: AvailabilityChange): void => {
    if (!game.availability_changes.some((existing) => existing.player === change.player && existing.action === change.action && existing.block === change.block)) {
      game.availability_changes.push(change);
    }
  };
  let earliest = game.total_blocks + 1;
  for (const change of changes) {
    const player = byName.get(change.player); if (!player) continue;
    if (change.action === 'unavailable') {
      if (change.block < 1 || change.block > updatedTimeline.length) throw new Error('Unavailable block must already exist in the timeline.');
      const block = updatedTimeline[change.block - 1];
      const position: PositionGroup | undefined = block.GK === player.name ? 'GK' : (['D', 'M', 'F'] as const).find((group) => block[group].includes(player.name));
      if (!position) throw new Error(`${player.name} is not playing in block ${change.block}.`);
      player.available = false; game.quota_exempt_players.add(player.name); recordAvailabilityChange(change);
      replayTimeline(roster, updatedTimeline.slice(0, change.block - 1), game);
      computeBlockTargets(game, roster);
      const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]); const bench = new Set(block.bench);
      const candidates = roster.filter((candidate) => candidate.available && !assigned.has(candidate.name) && (position === 'GK'
        ? candidate.primary_positions.some((value) => value.toUpperCase() === 'GK')
        : eligiblePlayers(roster, position).some((item) => item.name === candidate.name)));
      candidates.sort((left, right) => (bench.has(left.name) ? 0 : 1) - (bench.has(right.name) ? 0 : 1) || left.block_count - right.block_count || Math.max(0, left.target_blocks - left.block_count) - Math.max(0, right.target_blocks - right.block_count) || left.name.localeCompare(right.name));
      const replacement = candidates[0];
      if (!replacement) { player.available = true; throw new Error(`No available replacement can cover ${position} in block ${change.block}.`); }
      if (position === 'GK') {
        block.GK = replacement.name;
        block.positions.GK = replacement.name;
      } else {
        const replacementGroup = block[position].filter((name) => name !== player.name).concat(replacement.name);
        const replacementSlots = formationSlots(parseFormation(game.formation))[position];
        if (!completeExactAssignmentExists(roster, replacementGroup, replacementSlots, position)) {
          player.available = true;
          throw new Error(`No available replacement can cover the exact ${position} slot in block ${change.block}.`);
        }
        block[position] = replacementGroup;
        Object.assign(block.positions, assignExactSlots(roster, replacementGroup, replacementSlots, position, block.positions, game.season_position_starts));
      }
      block.bench = block.bench.filter((name) => name !== replacement.name); if (!block.bench.includes(player.name)) block.bench.push(player.name);
      if (!game.replacement_credits.some((credit) => credit.player === player.name && credit.block === change.block)) { game.replacement_credits.push({ player: player.name, block: change.block, position, half_index: change.block <= Math.ceil(game.total_blocks / 2) ? 0 : 1, replacement: replacement.name }); game.replacement_bonuses[replacement.name] = (game.replacement_bonuses[replacement.name] ?? 0) + 1; }
      earliest = Math.min(earliest, change.block + 1);
    } else {
      player.available = true;
      if (change.target_blocks !== undefined) {
        player.target_blocks = change.target_blocks;
        player.minimum_blocks = change.target_blocks;
        player.hard_minimum_blocks = player.minimum_blocks;
        player.maximum_blocks = change.maximum_blocks ?? game.total_blocks;
        player.hard_maximum_blocks = player.maximum_blocks;
        player.max_blocks_per_half = Math.max(1, player.maximum_blocks);
      }
      game.quota_exempt_players.add(player.name); recordAvailabilityChange(change); earliest = Math.min(earliest, change.block + 1);
    }
  }
  const frozen = updatedTimeline.slice(0, Math.max(0, earliest - 1)); replayTimeline(roster, frozen, game); const quota = computeBlockTargets(game, roster);
  for (const change of changes) {
    if (change.action !== 'available' || change.target_blocks === undefined) continue;
    const player = byName.get(change.player);
    if (!player) continue;
    player.target_blocks = change.target_blocks;
    player.minimum_blocks = change.target_blocks;
    player.hard_minimum_blocks = change.target_blocks;
    player.maximum_blocks = change.maximum_blocks ?? game.total_blocks;
    player.hard_maximum_blocks = player.maximum_blocks;
    player.max_blocks_per_half = Math.max(1, player.maximum_blocks);
  }
  const arrival = changes.find((change) => change.action === 'available' && change.target_blocks !== undefined);
  const preflightApproval = arrival ? shouldPreflightApproval(game, roster, arrival, approvedPlayerName) : false;
  const approvedFastPath = Boolean(approvedPlayerName && game.late_arrival_approval);
  const timeline = approvedFastPath
    ? (() => {
      const surplus = computeSurplus(game, roster);
      return {
        timeline: updatedTimeline,
        block_counts: surplus.block_counts,
        gk_summary: surplus.gk_summary,
        position_summary: surplus.position_summary,
        warnings: surplus.warnings,
        errors: surplus.errors,
        metadata: { ...surplus.metadata, quota_feasibility: quota.metadata.quota_feasibility },
        movement_metrics: calculateMovementMetrics(updatedTimeline, game.total_blocks, roster, formationSlots(parseFormation(game.formation)), game.allow_emergency_assignments),
      };
    })()
    : preflightApproval
    ? (() => {
      const surplus = computeSurplus(game, roster);
      return {
        timeline: updatedTimeline,
        block_counts: surplus.block_counts,
        gk_summary: surplus.gk_summary,
        position_summary: surplus.position_summary,
        warnings: surplus.warnings,
        errors: surplus.errors,
        metadata: { ...surplus.metadata, quota_feasibility: quota.metadata.quota_feasibility },
        movement_metrics: calculateMovementMetrics(updatedTimeline, game.total_blocks, roster, formationSlots(parseFormation(game.formation)), game.allow_emergency_assignments),
      };
    })()
    : buildTimeline(game, roster, Math.max(1, earliest), frozen, quota.metadata.quota_feasibility, previousTotalBlocks);
  for (const change of changes.filter((candidate) => candidate.action === 'available' && candidate.target_blocks !== undefined)) {
    const player = byName.get(change.player);
    if (!player) continue;
    const appearances = (): number => timeline.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(player.name)).length;
    const blockCount = (name: string): number => timeline.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(name)).length;
    while (appearances() > change.target_blocks!) {
      let replaced = false;
      for (let blockIndex = 0; blockIndex < timeline.timeline.length && !replaced; blockIndex += 1) {
        if (blockIndex === change.block) continue;
        const block = timeline.timeline[blockIndex];
        const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]);
        for (const group of ['D', 'M', 'F'] as const) {
          const playerIndex = block[group].indexOf(player.name);
          if (playerIndex < 0) continue;
          const replacement = roster
            .filter((candidate) => candidate.available && !assigned.has(candidate.name) && candidate.name !== player.name
              && blockCount(candidate.name) > candidate.minimum_blocks
              && blockCount(candidate.name) < candidate.hard_maximum_blocks
              && eligiblePlayers(roster, group).some((item) => item.name === candidate.name))
            .sort((left, right) => left.field_blocks - right.field_blocks || left.name.localeCompare(right.name))
            .find((candidate) => {
              const next = block[group].map((name, index) => index === playerIndex ? candidate.name : name);
              return completeExactAssignmentExists(roster, next, formationSlots(parseFormation(game.formation))[group], group);
            });
          if (!replacement) continue;
          block[group][playerIndex] = replacement.name;
          Object.assign(block.positions, assignExactSlots(roster, block[group], formationSlots(parseFormation(game.formation))[group], group, block.positions, game.season_position_starts));
          replaced = true;
          break;
        }
      }
      if (!replaced) break;
    }
    while (appearances() < change.target_blocks!) {
      let placed = false;
      for (let blockIndex = Math.max(0, change.block); blockIndex < timeline.timeline.length && !placed; blockIndex += 1) {
        const block = timeline.timeline[blockIndex];
        const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]);
        if (assigned.has(player.name) || block.GK === player.name) continue;
        for (const group of ['D', 'M', 'F'] as const) {
          const replacementCandidates = block[group]
            .map((name, index) => ({ name, index }))
            .filter(({ name }) => name !== player.name
              && name !== approvedPlayerName
              && (() => {
                const donor = byName.get(name);
                return donor !== undefined && blockCount(name) > donor.minimum_blocks;
              })()
              && !changes.some((candidate) => candidate.action === 'available' && candidate.block === blockIndex && candidate.player === name))
            .sort((left, right) => {
              if (!approvedPlayerName) return left.index - right.index;
              const leftPlayer = byName.get(left.name);
              const rightPlayer = byName.get(right.name);
              const leftCount = timeline.timeline.filter((candidateBlock) => [candidateBlock.GK, ...candidateBlock.D, ...candidateBlock.M, ...candidateBlock.F].includes(left.name)).length;
              const rightCount = timeline.timeline.filter((candidateBlock) => [candidateBlock.GK, ...candidateBlock.D, ...candidateBlock.M, ...candidateBlock.F].includes(right.name)).length;
              const leftSurplus = leftPlayer ? leftCount - leftPlayer.target_blocks : leftCount;
              const rightSurplus = rightPlayer ? rightCount - rightPlayer.target_blocks : rightCount;
              return leftSurplus - rightSurplus || leftCount - rightCount || left.name.localeCompare(right.name);
            });
          const replacementIndex = replacementCandidates.find(({ index }) => {
            const next = block[group].map((name, candidateIndex) => candidateIndex === index ? player.name : name);
            return completeExactAssignmentExists(roster, next, formationSlots(parseFormation(game.formation))[group], group);
          })?.index ?? -1;
          if (replacementIndex < 0 || !eligiblePlayers(roster, group).some((item) => item.name === player.name)) continue;
          const next = block[group].map((name, index) => index === replacementIndex ? player.name : name);
          if (!completeExactAssignmentExists(roster, next, formationSlots(parseFormation(game.formation))[group], group)) continue;
          block[group] = next;
          Object.assign(block.positions, assignExactSlots(roster, next, formationSlots(parseFormation(game.formation))[group], group, block.positions, game.season_position_starts));
          placed = true;
          break;
        }
      }
      if (!placed) break;
    }
  }
  if (approvedPlayerName && game.late_arrival_approval) {
    const request = game.late_arrival_approval;
    const arrivingPlayerName = changes.find((change) => change.action === 'available' && change.target_blocks !== undefined)?.player;
    const halfLength = Math.ceil(game.total_blocks / 2);
    const targetBlocks = request.scope === 'one_block'
      ? (request.block ? [request.block] : [])
      : Array.from({ length: halfLength }, (_, index) => (request.half ?? 0) * halfLength + index + 1)
        .filter((block) => block <= timeline.timeline.length);
    const approvedPlayer = roster.find((player) => player.name === approvedPlayerName);
    if (approvedPlayer) {
      for (const blockNumber of targetBlocks) {
        const block = timeline.timeline[blockNumber - 1];
        if (!block || [block.GK, ...block.D, ...block.M, ...block.F].includes(approvedPlayerName)) continue;
        const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]);
        let applied = false;
        for (const group of ['D', 'M', 'F'] as const) {
          if (!eligiblePlayers(roster, group).some((item) => item.name === approvedPlayerName)) continue;
          const count = (name: string): number => timeline.timeline.filter((candidateBlock) => [candidateBlock.GK, ...candidateBlock.D, ...candidateBlock.M, ...candidateBlock.F].includes(name)).length;
          const replacementCandidates = block[group]
            .map((name, index) => ({ name, index }))
            .filter(({ name }) => {
              const donor = roster.find((player) => player.name === name);
              return name !== approvedPlayerName
                && name !== arrivingPlayerName
                && donor !== undefined
                && count(name) > donor.minimum_blocks
                && !assigned.has(approvedPlayerName);
            })
            .sort((left, right) => {
              const leftPlayer = roster.find((player) => player.name === left.name);
              const rightPlayer = roster.find((player) => player.name === right.name);
              const leftCount = count(left.name);
              const rightCount = count(right.name);
              const leftTarget = leftPlayer?.target_blocks ?? leftPlayer?.hard_minimum_blocks ?? 0;
              const rightTarget = rightPlayer?.target_blocks ?? rightPlayer?.hard_minimum_blocks ?? 0;
              return (rightCount - rightTarget) - (leftCount - leftTarget) || rightCount - leftCount || right.name.localeCompare(left.name);
            });
          const replacementIndex = replacementCandidates.find(({ name, index }) => {
            const next = block[group].map((candidate, candidateIndex) => candidateIndex === index ? approvedPlayerName : candidate);
            return completeExactAssignmentExists(roster, next, formationSlots(parseFormation(game.formation))[group], group);
          })?.index ?? -1;
          if (replacementIndex < 0) continue;
          const next = block[group].map((name, index) => index === replacementIndex ? approvedPlayerName : name);
          block[group] = next;
          Object.assign(block.positions, assignExactSlots(roster, next, formationSlots(parseFormation(game.formation))[group], group, block.positions, game.season_position_starts));
          applied = true;
          break;
        }
        if (!applied) continue;
      }
    }
  }
  const lateArrivalStartByName = new Map(changes
    .filter((change) => change.action === 'available' && change.target_blocks !== undefined)
    .map((change) => [change.player, change.block]));
  timeline.timeline.forEach((block, blockIndex) => {
    const assigned = new Set([block.GK, ...block.D, ...block.M, ...block.F]);
    block.bench = roster
      .filter((player) => player.available && !assigned.has(player.name))
      .filter((player) => (lateArrivalStartByName.get(player.name) ?? 0) <= blockIndex)
      .map((player) => player.name);
  });
  const latePlayerNames = new Set(changes.filter((change) => change.action === 'available' && change.target_blocks !== undefined).map((change) => change.player));
  replayTimeline(roster, timeline.timeline, game);
  const validationErrors = validateTimeline(
    roster,
    timeline.timeline,
    parseFormation(game.formation),
    formationSlots(parseFormation(game.formation)),
    game.total_blocks,
    game,
  );
  const approvedPlacementErrors = approvedPlayerName && approvedBeforeCount !== null
    && timeline.timeline.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(approvedPlayerName)).length !== approvedBeforeCount + 1
    ? [`${approvedPlayerName} approval could not be applied to exactly one additional block.`]
    : [];
  if (approvedPlayerName) {
    const approvedAfterCount = roster.find((player) => player.name === approvedPlayerName)?.block_count ?? 0;
    const arrivingChange = changes.find((change) => change.action === 'available' && change.target_blocks !== undefined);
    const arrivingAfterCount = arrivingChange
      ? roster.find((player) => player.name === arrivingChange.player)?.block_count ?? 0
      : null;
    console.info('[rotation] approved-player regen output', { approvedPlayerName, approvedBeforeCount, approvedAfterCount, arrivingPlayer: arrivingChange?.player, arrivingAfterCount });
  }
  const surplus = computeSurplus(game, roster);
  const timelineErrors = timeline.errors
    .filter((error) => ![...latePlayerNames].some((name) => error.startsWith(`${name} exceeds `)))
    .filter((error) => !game.disable_maximum_limits
      || error.includes('total blocks')
      || error.includes('GK field maximum'));
  const placementErrors = changes
    .filter((change) => change.action === 'available' && change.target_blocks !== undefined)
    .flatMap((change) => {
      const blocks = timeline.timeline.slice(change.block);
      const appearances = blocks.filter((block) => [block.GK, ...block.D, ...block.M, ...block.F].includes(change.player)).length;
      const errors: string[] = [];
      if (!blocks[0] || ![blocks[0].GK, ...blocks[0].D, ...blocks[0].M, ...blocks[0].F].includes(change.player)) {
        errors.push(`${change.player} could not be placed in block ${change.block + 1}.`);
      }
      if (appearances < change.target_blocks!) {
        errors.push(`${change.player} could not reach ${change.target_blocks} blocks from block ${change.block + 1}; scheduled ${appearances}.`);
      }
      return errors;
    });
  const result = finalizeResult(game, roster, {
    timeline: timeline.timeline,
    block_counts: surplus.block_counts,
    gk_summary: surplus.gk_summary,
    position_summary: surplus.position_summary,
    warnings: [...new Set([...timeline.warnings, ...surplus.warnings])],
    errors: [...new Set([...timelineErrors, ...validationErrors, ...surplus.errors, ...placementErrors, ...approvedPlacementErrors])],
    metadata: { ...surplus.metadata, quota_feasibility: quota.metadata.quota_feasibility },
    movement_metrics: timeline.movement_metrics,
  });
  if (game.late_arrival_approval) {
    result.late_arrival_approval = approvalResult(game.late_arrival_approval, result.timeline, result.errors, roster);
    result.warnings = [...new Set([...result.warnings, ...result.late_arrival_approval.warnings])];
  }
  const hasStructuralFailure = result.errors.some((error) => /requires \d+ players|unassigned|cannot form a complete|assignment is missing/i.test(error));
  const approvalFailed = result.late_arrival_approval && !result.late_arrival_approval.approved;
  const approvalRequested = Boolean(game.late_arrival_approval);
  if (game.is_late_arrival_regen && !approvedPlayerName && arrival && (preflightApproval || hasStructuralFailure || placementErrors.length > 0 || approvalFailed)) {
    const priorApprovalBlock = previousTimeline[arrival.block];
    const priorApprovalAssignments = new Set(priorApprovalBlock ? [priorApprovalBlock.GK, ...priorApprovalBlock.D, ...priorApprovalBlock.M, ...priorApprovalBlock.F] : []);
    const candidates = (result.late_arrival_approval?.candidates ?? approvalCandidates(roster, previousTimeline, arrival))
      .filter((candidate) => !priorApprovalAssignments.has(candidate));
    result.needs_coach_approval = true;
    result.approval_candidates = candidates;
    result.recommended_approval_player = candidates[0];
    result.approval_scope = hasStructuralFailure ? 'entire_half' : 'one_block';
    result.warnings = [...new Set([...result.warnings, result.late_arrival_approval?.prompt ?? 'A coach approval is needed before applying this late arrival.'])];
  }
  if (availablePlayerNames) result.available_player_names = roster.filter((player) => player.available).map((player) => player.name);
  return result;
}
