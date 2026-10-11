import cases from '../src/engine/__tests__/fixtures/rotation_fingerprint_cases.json';
import { createPlayer } from '../src/engine/rotation';
import { computeBlockTargets } from '../src/engine/quotas';
import { assignQuotas, buildDemandModel, normalizeGame } from '../src/engine-redesign';
import type { GameInput, PlayerInput } from '../src/engine/models';
import type { RedesignGameInput, RedesignPlayerInput } from '../src/engine-redesign/model';

function formatFor(formation: string, explicit?: string): RedesignGameInput['format'] | '5v5' {
  if (explicit) return explicit as RedesignGameInput['format'] | '5v5';
  if (formation === '2-3-1') return '7v7';
  if (formation === '3-3-2') return '9v9';
  if (formation === '4-4-2' || formation === '4-3-3') return '11v11';
  return '4v4';
}

function currentQuota(fixture: typeof cases[number]): Map<string, { min: number; max: number }> {
  const roster = fixture.players.map((input) => createPlayer(input as PlayerInput));
  const game: GameInput & { quota_exempt_players: Set<string>; replacement_bonuses: Record<string, number> } = {
    total_blocks: fixture.game.total_blocks,
    formation: fixture.game.formation,
    game_format: fixture.game.game_format,
    has_goalkeeper: fixture.game.has_goalkeeper,
    first_half_gk: fixture.game.first_half_gk ?? null,
    second_half_gk: fixture.game.second_half_gk ?? null,
    quota_exempt_players: new Set(),
    replacement_bonuses: {},
  };
  computeBlockTargets(game as never, roster);
  return new Map(roster.map((player) => [player.name, {
    min: player.minimum_blocks,
    max: player.maximum_blocks,
  }]));
}

for (const fixture of cases) {
  const format = formatFor(fixture.game.formation, fixture.game.game_format);
  const current = currentQuota(fixture);
  if (format === '5v5') {
    console.log(`\n[${fixture.id}] skipped: 5v5 is outside Stages 0-2 spec scope`);
    continue;
  }
  const input: RedesignGameInput = {
    format,
    formation: fixture.game.formation,
    totalBlocks: fixture.game.total_blocks,
    firstHalfKeeper: fixture.game.first_half_gk ?? null,
    secondHalfKeeper: fixture.game.second_half_gk ?? null,
  };
  try {
    const normalized = normalizeGame(input, fixture.players as RedesignPlayerInput[]);
    const quotas = assignQuotas(normalized, buildDemandModel(normalized));
    console.log(`\n[${fixture.id}] ${format} N=${fixture.game.total_blocks}`);
    console.log('player | new min/max remainingMin/remainingMax pins | current min/max | delta min/max');
    for (const quota of quotas.quotas) {
      const old = current.get(quota.player);
      const oldMin = old?.min ?? 0;
      const oldMax = old?.max ?? 0;
      console.log(`${quota.player} | ${quota.totalMin}/${quota.totalMax} ${quota.remainingMin}/${quota.remainingMax} ${quota.pinnedBlocks.join(',') || '-'} | ${oldMin}/${oldMax} | ${quota.totalMin - oldMin}/${quota.totalMax - oldMax}`);
    }
    console.log(`audit=${JSON.stringify(quotas.audit)}`);
  } catch (error) {
    console.log(`\n[${fixture.id}] rejected by Stage 0: ${(error as Error).message}`);
  }
}
