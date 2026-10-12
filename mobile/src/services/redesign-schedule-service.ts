import { blockStartMinutes, SeasonSetup } from '@/engine/season';
import { formationSlots, parseFormation } from '@/engine/timeline';
import type { LiveSchedule, ScheduleBlock, SeasonRosterPlayer } from '@/engine/models';
import { assignQuotas, buildDemandModel, normalizeGame, positionTier, runStages3And4 } from '@/engine-redesign';
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

function generationFailureOffer(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>): Stage6Offer {
  const firstHalfAssigned = Boolean(game.firstHalfKeeper);
  const secondHalfAssigned = Boolean(game.secondHalfKeeper);
  const keepers = game.players.filter((player) => player.available && (player.keeper || player.generalPositions.includes('GK') || player.primaryPositions.includes('GK')));
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
    const label = shortage.group === 'D' ? 'defenders' : shortage.group === 'M' ? 'midfielders' : 'forwards';
    return {
      kind: 'position-shortage',
      message: `Not enough ${label}. You have ${shortage.have} eligible players, but this formation needs ${shortage.need} for full coverage.`,
      buttons: suggestions.length
        ? suggestions.map((player) => ({ label: `Add ${label.slice(0, -1)} backup for ${player}`, action: 'choose-player' as const }))
        : [{ label: 'Go to Roster', action: 'go-to-roster' as const }],
      context: { failureType: 'position-shortage', positionGroup: shortage.group, have: shortage.have, need: shortage.need, suggestions },
    };
  }
  return {
    kind: 'impossible',
    message: 'No eligible placement can satisfy the formation and playing-time requirements.',
    buttons: [{ label: 'Cancel', action: 'cancel' }],
    context: { failureType: 'impossible' },
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
    keeper: player.primary_positions?.includes('GK') || player.general_positions?.includes('GK'),
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

function placementWithTierFallback(game: ReturnType<typeof normalizeGame>, demand: ReturnType<typeof buildDemandModel>) {
  let last: { placement: ReturnType<typeof runStages3And4>; quotas: ReturnType<typeof assignQuotas>; tier: number } | null = null;
  for (let tier = 0; tier <= 3; tier += 1) {
    const quotas = assignQuotas(game, demand, tier);
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

export async function generateRedesignSchedule(input: { teamId: string; gameNumber: number; availablePlayerNames: string[]; firstHalfGk?: string | null; secondHalfGk?: string | null }): Promise<RedesignSchedule> {
  const { settings, team, game, demand } = await context(input);
  const { placement } = placementWithTierFallback(game, demand);
  if (!placement.complete) throw new RedesignOfferError(generationFailureOffer(game, demand));
  const blockLengths = new SeasonSetup({ ...settings, block_length_minutes: undefined }).block_lengths_minutes;
  return {
    team_id: input.teamId, team_name: team.name, game_number: input.gameNumber, first_half_gk: input.firstHalfGk ?? null, second_half_gk: input.secondHalfGk ?? null,
    available_player_names: input.availablePlayerNames, core_player_names: game.players.filter((player) => player.group === 'core').map((player) => player.name),
    block_start_minutes: blockStartMinutes(blockLengths), block_lengths_minutes: blockLengths, position_rows: positionRows(game.formation),
    blocks: scheduleBlocks(game, placement), warnings: ['Engine: redesign (Stages 0–6)'], errors: [], structural_errors: [], review_status: 'generated', engine_source: 'redesign',
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
