import { blockStartMinutes, SeasonSetup } from '@/engine/season';
import { formationSlots, parseFormation } from '@/engine/timeline';
import type { LiveSchedule, ScheduleBlock, SeasonRosterPlayer } from '@/engine/models';
import { assignQuotas, buildDemandModel, checkRosterFeasibility, normalizeGame, positionTier, runStages3And4 } from '@/engine-redesign';
import type { RedesignPlayerInput } from '@/engine-redesign/model';
import { replanLateArrival } from '@/engine-redesign/stage5';
import { offerForFailure } from '@/engine-redesign/stage6';
import type { Stage6Offer } from '@/engine-redesign/stage6';
import type { FrozenBlock } from '@/engine-redesign/stage3';
import { getLocalTeam, getRoster, getSeasonSettings } from './team-service';
import { getSavedReports } from './report-service';

export class RedesignOfferError extends Error {
  constructor(public readonly offer: ReturnType<typeof offerForFailure>) {
    super(offer.message);
    this.name = 'RedesignOfferError';
  }
}

function generationFailureOffer(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>, allowRelaxedMinimums = false): Stage6Offer {
  const firstHalfAssigned = Boolean(game.firstHalfKeeper);
  const secondHalfAssigned = Boolean(game.secondHalfKeeper);
  const keepers = game.players.filter((player) => player.available && player.keeperEligible);
  if (!firstHalfAssigned || !secondHalfAssigned) {
    if (keepers.length === 0) {
      return {
        kind: 'keeper-issue',
        message: 'No keeper is available for this game.',
        buttons: [{ label: 'Pick Keeper', action: 'pick-keeper' }, { label: 'Cancel', action: 'cancel' }],
        context: { failureType: 'keeper-issue', keeperNames: [] },
      };
    }
    return {
      kind: 'keeper-issue',
      message: `Only 1 keeper is available (${keepers[0].name}).`,
      buttons: [
        { label: `${keepers[0].name} plays full game`, action: 'full-game-keeper' },
        { label: 'Pick backup keeper', action: 'pick-keeper' },
        { label: 'Cancel', action: 'cancel' },
      ],
      context: { failureType: 'keeper-issue', keeperNames: keepers.map((player) => player.name) },
    };
  }
  const groups = ['D', 'M', 'F'] as const;
  const feasibilityIssue = checkRosterFeasibility(game, demand);
  const quotas = assignQuotas(game, demand).quotas;
  const groupLabel = (group: typeof groups[number]): string => group === 'D' ? 'defenders' : group === 'M' ? 'midfielders' : 'forwards';
  const minimumForPlayer = (player: typeof game.players[number]): number => {
    const percentage = player.group === 'core' ? 0.7 : player.group === 'rotational' ? 0.6 : 0.5;
    return Math.max(0, Math.min(game.totalBlocks, Math.round(game.totalBlocks * percentage)));
  };
  const playersForGroup = (group: typeof groups[number]) => game.players.filter((player) => player.available && !player.keeper
    && demand.fieldSlots.filter((slot) => slot.group === group).some((slot) => positionTier(player, slot.slot) > 0));
  const eligibleCounts = Object.fromEntries(groups.map((group) => [group, playersForGroup(group).length])) as Record<typeof groups[number], number>;
  const fieldPlayers = game.players.filter((player) => player.available && !player.keeper);
  const totalMinimum = fieldPlayers.reduce((total, player) => total + minimumForPlayer(player), 0);
  if (totalMinimum > demand.fieldSlots.length * game.totalBlocks && !allowRelaxedMinimums) {
    let remainingReduction = totalMinimum - demand.fieldSlots.length * game.totalBlocks;
    const reductions: string[] = [];
    for (const group of ['developing', 'rotational', 'core'] as const) {
      const groupPlayers = fieldPlayers.filter((player) => player.group === group);
      const groupMinimum = groupPlayers.reduce((total, player) => total + minimumForPlayer(player), 0);
      const reduction = Math.min(remainingReduction, groupMinimum);
      if (reduction > 0 && groupPlayers.length) {
        const perPlayer = Math.ceil(reduction / groupPlayers.length);
        const label = group === 'core' ? 'core' : group === 'rotational' ? 'rotational' : 'developing';
        reductions.push(`${Math.min(groupPlayers.length, reduction)} ${label} players: ${minimumForPlayer(groupPlayers[0])} blocks → ${Math.max(0, minimumForPlayer(groupPlayers[0]) - perPlayer)} blocks`);
        remainingReduction -= reduction;
      }
      if (!remainingReduction) break;
    }
    return {
      kind: 'position-shortage',
      message: `Can't fit everyone's minimum playing time.\n\nTo generate a schedule for ${game.players.length} players, these minimums would need to be reduced:\n- ${reductions.join('\n- ')}\n\nOr add backup positions to increase the roster's flexibility.`,
      buttons: [{ label: 'Generate', action: 'allow-relaxed' }, { label: 'Add Backup Positions', action: 'go-to-builder' }, { label: 'Cancel', action: 'cancel' }],
      context: { failureType: 'total-minimums' },
    };
  }
  const endpointPinned = (player: typeof game.players[number]): number => {
    if (player.group !== 'core' || !player.available) return 0;
    const hasBlockOnePin = game.pins.some((pin) => pin.block === 1 && pin.player === player.name);
    return game.lateArrival?.player === player.name || (!hasBlockOnePin && game.pins.length > 0) ? 1 : 2;
  };
  const diagnoses: Array<{ group: typeof groups[number]; names: string[]; target: string }> = [];
  for (const group of groups) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    const singleGroupPlayers = playersForGroup(group).filter((player) => groups.filter((candidate) => playersForGroup(candidate).some((eligible) => eligible.name === player.name)).length === 1);
    const minimums = singleGroupPlayers
      .map((player) => ({ name: player.name, minimum: minimumForPlayer(player) }))
      .filter((player) => player.minimum > 0)
      .sort((left, right) => right.minimum - left.minimum || left.name.localeCompare(right.name));
    const pinnedSlots = playersForGroup(group).reduce((total, player) => total + endpointPinned(player), 0);
    const minimumExcess = minimums.reduce((total, player) => total + player.minimum, 0) - Math.max(0, slots.length * game.totalBlocks - pinnedSlots);
    if (minimumExcess <= 0 || !minimums.length) continue;
    const crossTraining = [...minimums].sort((left, right) => {
      const leftPlayer = game.players.find((player) => player.name === left.name);
      const rightPlayer = game.players.find((player) => player.name === right.name);
      const tier = (player: typeof game.players[number] | undefined): number => player?.group === 'rotational' ? 0 : player?.group === 'developing' ? 1 : 2;
      return tier(leftPlayer) - tier(rightPlayer) || right.minimum - left.minimum || left.name.localeCompare(right.name);
    }).slice(0, Math.max(1, minimums.findIndex((_, index) => minimums.slice(0, index + 1).reduce((total, player) => total + player.minimum, 0) >= minimumExcess * 1.5) + 1));
    const targetGroup = groups
      .filter((candidate) => candidate !== group)
      .sort((left, right) => (eligibleCounts[right] - demand.fieldSlots.filter((slot) => slot.group === right).length)
        - (eligibleCounts[left] - demand.fieldSlots.filter((slot) => slot.group === left).length))[0];
    const targetLabel = targetGroup === 'D' ? 'defense' : targetGroup === 'M' ? 'midfield' : 'forward';
    diagnoses.push({ group, names: crossTraining.map((player) => player.name), target: targetLabel });
  }
  if (diagnoses.length) {
    const message = diagnoses.map(({ group, names, target }) =>
      `Your ${groupLabel(group)} are overloaded — too many can only play ${groupLabel(group).replace(/s$/, '')}.\n\nTo fix: give a ${target} backup to ${names.length} of these players:\n${names.join(', ')}.`).join('\n\n');
    return {
      kind: 'position-shortage',
      message,
      buttons: [{ label: 'Review Players', action: 'go-to-roster' }, { label: 'Cancel', action: 'cancel' }],
      context: { failureType: 'position-shortage', positionGroup: diagnoses[0].group, suggestions: diagnoses.flatMap(({ names }) => names) },
    };
  }
  const shortages = groups.map((group) => {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    const eligible = game.players.filter((player) => player.available && !player.keeper
      && slots.some((slot) => positionTier(player, slot.slot) > 0)).length;
    return { group, have: eligible, need: slots.length };
  }).filter((entry) => entry.have < entry.need).sort((left, right) => left.have - left.need - (right.have - right.need));
  const shortage = shortages[0];
  if (shortage) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === shortage.group);
    const suggestions = game.players
      .filter((player) => player.available && !player.keeper && !slots.some((slot) => positionTier(player, slot.slot) > 0))
      .sort((left, right) => (left.backupPositions.length ? 1 : 0) - (right.backupPositions.length ? 1 : 0)
        || left.name.localeCompare(right.name))
      .slice(0, 3)
      .map((player) => player.name);
    const label = groupLabel(shortage.group);
    return {
      kind: 'position-shortage',
      message: `You need ${Math.max(1, shortage.need - shortage.have)} more ${label}.\n\nYour roster doesn't have enough players who can play ${label.slice(0, -1)} to cover the formation.`,
      buttons: suggestions.length
        ? suggestions.map((player) => ({ label: `Add ${label.slice(0, -1)} backup for ${player}`, action: 'choose-player' as const }))
        : [{ label: 'Go to Roster', action: 'go-to-roster' as const }],
      context: { failureType: 'position-shortage', positionGroup: shortage.group, have: shortage.have, need: shortage.need, suggestions },
    };
  }
  for (const group of groups) {
    const slots = demand.fieldSlots.filter((slot) => slot.group === group);
    const eligible = game.players.filter((player) => player.available && !player.keeper
      && slots.some((slot) => positionTier(player, slot.slot) > 0));
    const capacityHave = eligible.reduce((total, player) => total + (quotas.find((quota) => quota.player === player.name)?.fieldMax ?? 0), 0);
    const capacityNeed = slots.length * game.totalBlocks;
    if (capacityHave >= capacityNeed) continue;
    const suggestions = game.players
      .filter((player) => player.available && !player.keeper && !slots.some((slot) => positionTier(player, slot.slot) > 0))
      .sort((left, right) => (left.backupPositions.length ? 1 : 0) - (right.backupPositions.length ? 1 : 0)
        || left.name.localeCompare(right.name))
      .slice(0, 3)
      .map((player) => player.name);
    const label = groupLabel(group);
    return {
      kind: 'position-shortage',
      message: `You need ${Math.max(1, slots.length - eligible.length)} more ${label}.\n\nYour roster doesn't have enough players who can play ${label.slice(0, -1)} to cover the formation.`,
      buttons: suggestions.length
        ? suggestions.map((player) => ({ label: `Add ${label.slice(0, -1)} backup for ${player}`, action: 'choose-player' as const }))
        : [{ label: 'Go to Roster', action: 'go-to-roster' as const }],
      context: { failureType: 'position-shortage', positionGroup: group, have: eligible.length, need: slots.length, capacityHave, capacityNeed, suggestions },
    };
  }
  return {
    kind: 'impossible',
    message: feasibilityIssue?.message ?? 'Can\'t generate a schedule with the current roster setup.\n\nThis is unexpected — the roster looks complete. Try adding more backup flexibility, or generate with relaxed minimums.',
    buttons: [
      { label: 'Add Backup Positions', action: 'go-to-builder' },
      { label: 'Generate Anyway', action: 'allow-relaxed' },
      { label: 'Cancel', action: 'cancel' },
    ],
    context: { failureType: 'impossible', feasibility: feasibilityIssue },
  };
}

function relaxedGenerationFailureOffer(): Stage6Offer {
  return {
    kind: 'impossible',
    message: "Even with relaxed minimums, a schedule couldn't be generated. Try adding more backup positions.",
    buttons: [
      { label: 'Add Backup Positions', action: 'go-to-builder' },
      { label: 'Cancel', action: 'cancel' },
    ],
    context: { failureType: 'relaxed-impossible' },
  };
}

function rosterInput(player: SeasonRosterPlayer): RedesignPlayerInput {
  return {
    name: player.name,
    group: player.group,
    general_positions: player.general_positions ?? [],
    primary_positions: player.primary_positions ?? [],
    backup_positions: player.backup_positions ?? [],
    excluded_positions: player.excluded_positions ?? [],
    keeper_eligible: player.keeper_eligible === true,
    keeper: player.keeper_eligible === true && !(player.general_positions ?? []).length,
  };
}

function formatFor(format: string): '4v4' | '7v7' | '9v9' | '11v11' {
  if (format === '4v4' || format === '7v7' || format === '9v9' || format === '11v11') return format;
  throw new Error(`Unsupported redesign game format: ${format}.`);
}

function positionRows(formation: string) {
  const slots = formationSlots(parseFormation(formation));
  return [
    { label: 'FORWARDS', positions: slots.F },
    { label: 'MIDFIELDERS', positions: slots.M },
    { label: 'DEFENDERS', positions: slots.D },
    { label: 'GOALKEEPER', positions: ['GK'] },
  ].filter((row) => row.positions.length);
}

function scheduleBlocks(game: ReturnType<typeof normalizeGame>, placement: ReturnType<typeof runStages3And4>): ScheduleBlock[] {
  return placement.blocks.map((block) => {
    const positions: Record<string, string> = {};
    if (game.firstHalfKeeper && block.block <= game.totalBlocks / 2) positions.GK = game.firstHalfKeeper;
    if (game.secondHalfKeeper && block.block > game.totalBlocks / 2) positions.GK = game.secondHalfKeeper;
    for (const [slot, player] of block.assignments) positions[slot] = player;
    const playing = new Set(Object.values(positions));
    return {
      GK: positions.GK ?? '',
      D: Object.entries(positions).filter(([slot]) => /^D|^(LB|LCB|CB|RCB|RB)/.test(slot)).map(([, player]) => player),
      M: Object.entries(positions).filter(([slot]) => /^M|^(LM|LCM|CM|RCM|RM|CDM|CAM)/.test(slot)).map(([, player]) => player),
      F: Object.entries(positions).filter(([slot]) => /^F|^(LF|CF|RF|ST)/.test(slot)).map(([, player]) => player),
      bench: game.players.filter((player) => player.available && !playing.has(player.name)).map((player) => player.name),
      positions,
    };
  });
}

function placementWithTierFallback(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>, allowRelaxedMinimums = false) {
  let last: { placement: ReturnType<typeof runStages3And4>; quotas: ReturnType<typeof assignQuotas>; tier: number } | null = null;
  for (let tier = 0; tier <= 3; tier += 1) {
    const quotas = assignQuotas(game, demand, tier, allowRelaxedMinimums);
    const placement = runStages3And4(game, demand, quotas);
    placement.audit.relaxationTier = tier;
    last = { placement, quotas, tier };
    if (placement.complete) return last;
  }
  return last!;
}

async function context(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null }) {
  const settings = await getSeasonSettings(input.teamId);
  const team = await getLocalTeam(input.teamId);
  const roster = (await getRoster(input.teamId)).players.map(rosterInput);
  const reports = await getSavedReports(input.teamId);
  const history: Record<string, { historicalFieldBlocks: number; historicalGkBlocks: number; historicalStarts: number }> = {};
  reports.filter((report) => report.game_number < input.gameNumber).forEach((report) => report.players.forEach((player) => {
    history[player.player] = { historicalFieldBlocks: (history[player.player]?.historicalFieldBlocks ?? 0) + player.blocksPlayed, historicalGkBlocks: 0, historicalStarts: 0 };
  }));
  const game = normalizeGame({
    format: formatFor(settings.game_format),
    formation: settings.formation,
    totalBlocks: settings.total_blocks,
    availablePlayerNames: input.availablePlayerNames,
    firstHalfKeeper: input.firstHalfGk ?? null,
    secondHalfKeeper: input.secondHalfGk ?? null,
    seasonHistory: history,
  }, roster);
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  return { settings, team, game, demand, quotas };
}

type RedesignSchedule = LiveSchedule & { warnings: string[]; errors: string[]; available_player_names: string[]; engine_source: 'redesign' };

export async function generateRedesignSchedule(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null; allowRelaxedMinimums?: boolean }): Promise<RedesignSchedule> {
  const { settings, team, game, demand } = await context(input);
  const { placement, quotas } = placementWithTierFallback(game, demand, input.allowRelaxedMinimums);
  if (!placement.complete) {
    const offer = generationFailureOffer(game, demand, input.allowRelaxedMinimums);
    if (input.allowRelaxedMinimums && offer.kind === 'impossible') throw new RedesignOfferError(relaxedGenerationFailureOffer());
    throw new RedesignOfferError(offer);
  }
  const blockLengths = new SeasonSetup({ ...settings, block_length_minutes: undefined }).block_lengths_minutes;
  const relaxedWarnings = input.allowRelaxedMinimums && quotas.audit.relaxedPlayers?.length
    ? [`Minimums relaxed for: ${quotas.audit.relaxedPlayers.map((entry) => `${entry.player} (${entry.before} -> ${entry.after} blocks)`).join(', ')}.`]
    : [];
  return {
    team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null,
    available_player_names: input.availablePlayerNames, core_player_names: game.players.filter((player) => player.group === 'core').map((player) => player.name),
    block_start_minutes: blockStartMinutes(blockLengths), block_lengths_minutes: blockLengths, position_rows: positionRows(game.formation),
    blocks: scheduleBlocks(game, placement), warnings: ['Engine: redesign (Stages 0–6)', ...relaxedWarnings], errors: [], structural_errors: [], review_status: 'generated', engine_source: 'redesign',
  };
}

export async function regenerateRedesignLateArrival(input: { teamId: string; gameNumber: number; previousSchedule: LiveSchedule; availablePlayerNames: string[]; playerName: string; startBlock: number; targetBlocks: number; firstHalfGk?: string | null; secondHalfGk?: string | null }): Promise<RedesignSchedule> {
  const base = await context(input);
  const game = normalizeGame({
    format: base.game.format, formation: base.game.formation, totalBlocks: base.game.totalBlocks, availablePlayerNames: input.availablePlayerNames,
    firstHalfKeeper: input.firstHalfGk ?? null, secondHalfKeeper: input.secondHalfGk ?? null,
    lateArrival: { player: input.playerName, arrivalBlock: input.startBlock, targetBlocks: input.targetBlocks },
  }, base.game.players.map((player) => ({ name: player.name, group: player.group, general_positions: player.generalPositions, primary_positions: player.primaryPositions, backup_positions: player.backupPositions, excluded_positions: player.excludedPositions, keeper: player.keeper })));
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  const frozen: FrozenBlock[] = input.previousSchedule.blocks.slice(0, input.startBlock - 1).map((block, index) => ({ block: index + 1, assignments: new Map(Object.entries(block.positions).filter(([slot]) => slot !== 'GK')) }));
  const result = replanLateArrival({ game, demand, quotas, frozen, arrivalTarget: input.targetBlocks });
  if (result.kind !== 'success') throw new RedesignOfferError(offerForFailure(result.failure));
  const blockLengths = new SeasonSetup({ ...(base.settings), block_length_minutes: undefined }).block_lengths_minutes;
  return {
    team_id: input.teamId, team_name: base.team.name, game_number: input.gameNumber, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null,
    available_player_names: input.availablePlayerNames, core_player_names: game.players.filter((player) => player.group === 'core').map((player) => player.name),
    block_start_minutes: blockStartMinutes(blockLengths), block_lengths_minutes: blockLengths, position_rows: positionRows(game.formation),
    blocks: scheduleBlocks(game, result.placement), warnings: ['Engine: redesign (Stages 0–6)'], errors: [], structural_errors: [], review_status: 'generated', engine_source: 'redesign',
  };
}
