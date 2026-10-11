import type { LineupPin, NormalizedGame, NormalizedPlayer, RedesignGameInput, RedesignPlayerInput, RedesignFormat } from './model';

const FORMATS: Record<RedesignFormat, { fieldPlayers: number; goalkeeper: boolean }> = {
  '4v4': { fieldPlayers: 4, goalkeeper: false },
  '7v7': { fieldPlayers: 6, goalkeeper: true },
  '9v9': { fieldPlayers: 8, goalkeeper: true },
  '11v11': { fieldPlayers: 10, goalkeeper: true },
};

const FORMATIONS: Record<RedesignFormat, string[]> = {
  '4v4': ['1-2-1', '2-0-2'],
  '7v7': ['2-3-1', '3-2-1', '2-1-2-1'],
  '9v9': ['3-3-2', '3-4-1', '4-3-1'],
  '11v11': ['4-3-3', '4-4-2', '4-2-3-1', '3-4-3'],
};

function positions(value: string | string[] | undefined): string[] {
  return (value == null ? [] : Array.isArray(value) ? value : [value]).map((item) => item.toUpperCase());
}

function normalizeGroup(group: string): NormalizedPlayer['group'] {
  const normalized = group.toLowerCase();
  if (normalized === 'core' || normalized === 'core_a' || normalized === 'core_b') return 'core';
  if (normalized === 'developing' || normalized === 'developmental') return 'developing';
  if (normalized === 'rotational' || normalized === 'rotational_gk') return 'rotational';
  throw new Error(`Unknown player group: ${group}.`);
}

function normalizePlayer(input: RedesignPlayerInput, game: RedesignGameInput): NormalizedPlayer {
  const generalPositions = positions(input.general_positions ?? input.general_position);
  const primaryPositions = positions(input.primary_positions ?? input.primary_position);
  const excludedPositions = positions(input.excluded_positions ?? input.forbidden_positions);
  const history = game.seasonHistory?.[input.name];
  return {
    name: input.name,
    group: normalizeGroup(input.group),
    generalPositions,
    primaryPositions: primaryPositions.length ? primaryPositions : generalPositions,
    backupPositions: positions(input.backup_positions),
    excludedPositions,
    available: input.available ?? true,
    keeper: input.keeper ?? (primaryPositions.includes('GK') || generalPositions.includes('GK')),
    emergencyKeeper: false,
    restPreset: input.rest_preset ?? 'none',
    history: history ?? {
      historicalFieldBlocks: input.historicalFieldBlocks ?? 0,
      historicalGkBlocks: input.historicalGkBlocks ?? 0,
      historicalStarts: input.historicalStarts ?? 0,
    },
  };
}

function formationSlots(formation: string): Set<string> {
  if (formation === '2-1-2-1') return new Set(['LB', 'RB', 'CM', 'LW', 'RW', 'ST']);
  if (formation === '4-2-3-1') return new Set(['LB', 'LCB', 'RCB', 'RB', 'CDM', 'CM', 'LW', 'CAM', 'RW', 'ST']);
  const numbers = formation.split('-').map(Number);
  if (numbers.length === 2) return new Set([...Array.from({ length: numbers[0] }, (_, index) => `D${index + 1}`), ...Array.from({ length: numbers[1] }, (_, index) => `F${index + 1}`)]);
  const [defenders, midfielders, forwards] = numbers;
  const defense = defenders === 4 ? ['LB', 'LCB', 'RCB', 'RB'] : defenders === 3 ? ['LCB', 'CB', 'RCB'] : Array.from({ length: defenders }, (_, index) => `D${index + 1}`);
  const midfield = midfielders === 4 ? ['LM', 'LCM', 'RCM', 'RM'] : midfielders === 3 ? ['LM', 'CM', 'RM'] : Array.from({ length: midfielders }, (_, index) => `M${index + 1}`);
  const attack = forwards === 3 ? ['LF', 'CF', 'RF'] : forwards === 2 ? ['LF', 'RF'] : forwards === 1 ? ['ST'] : Array.from({ length: forwards }, (_, index) => `F${index + 1}`);
  return new Set([...defense, ...midfield, ...attack]);
}

function validatePins(pins: LineupPin[], players: Map<string, NormalizedPlayer>, game: RedesignGameInput, goalkeeperRequired: boolean): void {
  const slots = formationSlots(game.formation);
  if (goalkeeperRequired) slots.add('GK');
  for (const pin of pins) {
    if (pin.block !== 1) throw new Error('Lineup pins are only supported for block 1.');
    if (!slots.has(pin.slot.toUpperCase())) throw new Error(`Lineup pin references unknown slot: ${pin.slot}.`);
    const player = players.get(pin.player);
    if (!player || !player.available) throw new Error(`Lineup pin references unavailable player: ${pin.player}.`);
    if (pin.slot.toUpperCase() === 'GK' && (!goalkeeperRequired || pin.player !== game.firstHalfKeeper)) {
      throw new Error('The block-1 GK pin must equal the first-half keeper.');
    }
    if (pin.slot.toUpperCase() !== 'GK' && player.excludedPositions.includes(pin.slot.toUpperCase())) {
      throw new Error(`Lineup pin places ${pin.player} in excluded slot ${pin.slot}.`);
    }
  }
}

export function normalizeGame(game: RedesignGameInput, roster: RedesignPlayerInput[]): NormalizedGame {
  const format = FORMATS[game.format];
  if (!format) throw new Error(`Unknown game format: ${game.format}.`);
  if (!Number.isInteger(game.totalBlocks) || game.totalBlocks < 4 || game.totalBlocks > 16 || game.totalBlocks % 2 !== 0) {
    throw new Error('Number of blocks must be an even number from 4 to 16.');
  }
  if (!FORMATIONS[game.format].includes(game.formation)) {
    throw new Error(`Formation ${game.formation} is not available for ${game.format}.`);
  }
  const players = roster.map((player) => normalizePlayer(player, game));
  const byName = new Map(players.map((player) => [player.name, player]));
  const availableNames = game.availablePlayerNames ? new Set(game.availablePlayerNames) : null;
  if (availableNames) players.forEach((player) => { player.available = availableNames.has(player.name); });
  const emergencyNames = new Set(game.emergencyKeepers ?? []);
  emergencyNames.forEach((name) => {
    if (byName.has(name)) throw new Error(`Emergency keeper must not already be in the roster: ${name}.`);
    players.push({
      name, group: 'rotational', generalPositions: ['GK'], primaryPositions: ['GK'], backupPositions: [], excludedPositions: [],
      available: true, keeper: true, emergencyKeeper: true, restPreset: 'none',
      history: { historicalFieldBlocks: 0, historicalGkBlocks: 0, historicalStarts: 0 },
    });
    byName.set(name, players[players.length - 1]);
  });
  const firstHalfKeeper = game.firstHalfKeeper ?? null;
  const secondHalfKeeper = game.secondHalfKeeper === undefined ? firstHalfKeeper : game.secondHalfKeeper;
  if (format.goalkeeper && (!firstHalfKeeper || !secondHalfKeeper)) {
    throw new Error('Choose a goalkeeper for both halves.');
  }
  const core = players.filter((player) => player.available && player.group === 'core');
  const coreKeepers = core.filter((player) => player.generalPositions.includes('GK') || player.primaryPositions.includes('GK'));
  const coreField = core.filter((player) => !player.generalPositions.every((position) => position === 'GK'));
  if (coreKeepers.length > 1 || coreField.length > format.fieldPlayers) {
    throw new Error(`Core is limited to ${format.fieldPlayers} field players and 1 core goalkeeper for ${game.format}; found ${coreField.length} core field players and ${coreKeepers.length} core goalkeepers.`);
  }
  for (const keeper of [firstHalfKeeper, secondHalfKeeper]) {
    if (keeper && !byName.has(keeper)) throw new Error(`Selected goalkeeper is not in the roster: ${keeper}.`);
    const selected = keeper ? byName.get(keeper) : undefined;
    if (selected && !selected.keeper) throw new Error(`Selected goalkeeper is not marked as a keeper: ${keeper}.`);
    if (selected && !selected.available) throw new Error(`Selected goalkeeper is unavailable: ${keeper}.`);
  }
  const normalizedPins = (game.pins ?? []).map((pin) => ({ ...pin, slot: pin.slot.toUpperCase() }));
  validatePins(normalizedPins, byName, game, format.goalkeeper);
  const lateArrival = game.lateArrival ?? null;
  if (lateArrival) {
    if (!byName.has(lateArrival.player)) throw new Error(`Late-arrival player is not in the roster: ${lateArrival.player}.`);
    if (lateArrival.arrivalBlock < 1 || lateArrival.arrivalBlock > game.totalBlocks) throw new Error('Late-arrival block is outside the game.');
    if (lateArrival.targetBlocks !== undefined && (!Number.isInteger(lateArrival.targetBlocks) || lateArrival.targetBlocks < 0 || lateArrival.targetBlocks > game.totalBlocks - lateArrival.arrivalBlock + 1)) {
      throw new Error('Late-arrival target must be between zero and the remaining blocks.');
    }
  }
  return {
    format: game.format,
    formation: game.formation,
    totalBlocks: game.totalBlocks,
    blockMinutes: game.blockMinutes,
    players: players.sort((left, right) => left.name.localeCompare(right.name)),
    firstHalfKeeper,
    secondHalfKeeper,
    pins: normalizedPins,
    lateArrival,
    disableMaximumLimits: game.disableMaximumLimits ?? false,
  };
}

export { FORMATS };
