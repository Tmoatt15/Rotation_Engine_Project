import cases from '../src/engine/__tests__/fixtures/rotation_fingerprint_cases.json';
import { createPlayer, runRotationEngine } from '../src/engine/rotation';
import type { PlayerInput } from '../src/engine/models';
import { normalizeGame, positionTier } from '../src/engine-redesign';
import type { RedesignGameInput, RedesignPlayerInput } from '../src/engine-redesign/model';

const fixture = cases.find((candidate) => candidate.id === process.argv[2]);
if (!fixture) throw new Error(`Unknown fixture: ${process.argv[2]}`);

function formatFor(formation: string, explicit?: string): RedesignGameInput['format'] {
  if (explicit) return explicit as RedesignGameInput['format'];
  if (formation === '2-3-1') return '7v7';
  if (formation === '3-3-2') return '9v9';
  if (formation === '4-4-2' || formation === '4-3-3') return '11v11';
  return '4v4';
}

const format = formatFor(fixture.game.formation, fixture.game.game_format);
const game = normalizeGame({
  format,
  formation: fixture.game.formation,
  totalBlocks: fixture.game.total_blocks,
  firstHalfKeeper: fixture.game.first_half_gk ?? null,
  secondHalfKeeper: fixture.game.second_half_gk ?? null,
}, fixture.players as RedesignPlayerInput[]);
const players = new Map(game.players.map((player) => [player.name, player]));
const coreNames = new Set(game.players.filter((player) => player.group === 'core').map((player) => player.name));
const result = runRotationEngine({
  total_blocks: fixture.game.total_blocks,
  formation: fixture.game.formation,
  game_format: format,
  has_goalkeeper: fixture.game.has_goalkeeper,
  first_half_gk: fixture.game.first_half_gk ?? null,
  second_half_gk: fixture.game.second_half_gk ?? null,
}, fixture.players as PlayerInput[]);

let primarySlots = 0;
let fieldSlots = 0;
let maxCoreBenches = 0;
for (const block of result.timeline) {
  const playing = new Set<string>();
  for (const [slot, name] of Object.entries(block.positions)) {
    if (slot === 'GK') continue;
    fieldSlots += 1;
    if (positionTier(players.get(name)!, slot) === 2) primarySlots += 1;
    playing.add(name);
  }
  maxCoreBenches = Math.max(maxCoreBenches, [...coreNames].filter((name) => !playing.has(name)).length);
}
console.log(JSON.stringify({
  primaryCentralRate: fieldSlots ? primarySlots / fieldSlots : 0,
  maxCoreBenches,
}));
