import cases from '../src/engine/__tests__/fixtures/rotation_fingerprint_cases.json';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { ScheduleBlock } from '../src/engine/models';
import { assignQuotas, buildDemandModel, normalizeGame, placeStage3, polishStage4, positionTier, runStages3And4 } from '../src/engine-redesign';
import type { RedesignGameInput, RedesignPlayerInput } from '../src/engine-redesign/model';

function formatFor(formation: string, explicit?: string): RedesignGameInput['format'] | '5v5' {
  if (explicit) return explicit as RedesignGameInput['format'] | '5v5';
  if (formation === '2-3-1') return '7v7';
  if (formation === '3-3-2') return '9v9';
  if (formation === '4-4-2' || formation === '4-3-3') return '11v11';
  return '4v4';
}

function counts(blocks: { assignments: Map<string, string> }[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const block of blocks) for (const player of block.assignments.values()) result.set(player, (result.get(player) ?? 0) + 1);
  return result;
}

function qualityMetrics(
  blocks: Array<{ assignments: Map<string, string> }>,
  coreNames: Set<string>,
  players: Map<string, ReturnType<typeof normalizeGame>['players'][number]>,
): { primaryCentralRate: number; maxCoreBenches: number } {
  let primarySlots = 0;
  let fieldSlots = 0;
  let maxCoreBenches = 0;
  for (const block of blocks) {
    const playing = new Set<string>();
    for (const [slot, name] of block.assignments) {
      if (slot === 'GK') continue;
      fieldSlots += 1;
      if (positionTier(players.get(name)!, slot) === 2) primarySlots += 1;
      playing.add(name);
    }
    maxCoreBenches = Math.max(maxCoreBenches, [...coreNames].filter((name) => !playing.has(name)).length);
  }
  return { primaryCentralRate: fieldSlots ? primarySlots / fieldSlots : 0, maxCoreBenches };
}

function currentQuality(fixtureId: string): { primaryCentralRate: number; maxCoreBenches: number } | null {
  try {
    const output = execFileSync(process.execPath, [
      resolve('node_modules/tsx/dist/cli.mjs'),
      'scripts/current-fixture-quality.ts',
      fixtureId,
    ], { encoding: 'utf8', timeout: 10000 });
    const result = output.trim().split(/\r?\n/).reverse().find((line) => line.startsWith('{'));
    return result ? JSON.parse(result) as { primaryCentralRate: number; maxCoreBenches: number } : null;
  } catch (error) {
    console.log(`[${fixtureId}] current engine measurement unavailable: ${(error as Error).message}`);
    return null;
  }
}

const largestFixture = cases.find((fixture) => fixture.id === '11v11-4-3-3-balanced');

for (const fixture of cases) {
  const format = formatFor(fixture.game.formation, fixture.game.game_format);
  if (format === '5v5') {
    console.log(`[${fixture.id}] skipped: 5v5 outside scope`);
    continue;
  }
  try {
    const game = normalizeGame({
      format,
      formation: fixture.game.formation,
      totalBlocks: fixture.game.total_blocks,
      firstHalfKeeper: fixture.game.first_half_gk ?? null,
      secondHalfKeeper: fixture.game.second_half_gk ?? null,
    }, fixture.players as RedesignPlayerInput[]);
    const demand = buildDemandModel(game);
    const quotas = assignQuotas(game, demand);
    const hardPlacement = placeStage3(game, demand, quotas);
    const polished = hardPlacement.complete
      ? polishStage4(game, demand, quotas, hardPlacement)
      : runStages3And4(game, demand, quotas);
    const coreNames = new Set(game.players.filter((player) => player.group === 'core').map((player) => player.name));
    const playersByName = new Map(game.players.map((player) => [player.name, player]));
    const redesignedQuality = qualityMetrics(polished.blocks, coreNames, playersByName);
    const current = currentQuality(fixture.id);
    const quality = current && redesignedQuality.primaryCentralRate >= current.primaryCentralRate
      && redesignedQuality.maxCoreBenches <= current.maxCoreBenches ? 'ok' : current ? 'REGRESSION' : 'unavailable';
    if (hardPlacement.complete) {
      const before = counts(hardPlacement.blocks);
      const after = counts(polished.blocks);
      const sortedCounts = (value: Map<string, number>) => [...value.entries()].sort(([left], [right]) => left.localeCompare(right));
      if (JSON.stringify(sortedCounts(before)) !== JSON.stringify(sortedCounts(after))) {
        throw new Error('post-polish quota preservation invariant violated');
      }
    }
    console.log(`[${fixture.id}] complete=${polished.complete} blocks=${polished.blocks.length} errors=${polished.audit.errors.join(';') || '-'} restFallback=${polished.audit.softRestFallback} metrics=${JSON.stringify(polished.metrics)} quality=${quality} newQuality=${JSON.stringify(redesignedQuality)} currentQuality=${JSON.stringify(current)}`);
  } catch (error) {
    console.log(`[${fixture.id}] rejected=${(error as Error).message}`);
  }

}

if (largestFixture) {
  const format = formatFor(largestFixture.game.formation, largestFixture.game.game_format);
  const started = performance.now();
  const game = normalizeGame({
    format,
    formation: largestFixture.game.formation,
    totalBlocks: largestFixture.game.total_blocks,
    firstHalfKeeper: largestFixture.game.first_half_gk ?? null,
    secondHalfKeeper: largestFixture.game.second_half_gk ?? null,
  }, largestFixture.players as RedesignPlayerInput[]);
  const demand = buildDemandModel(game);
  const quotas = assignQuotas(game, demand);
  const result = runStages3And4(game, demand, quotas);
  const elapsedSeconds = (performance.now() - started) / 1000;
  console.log(`[performance] fixture=${largestFixture.id} seconds=${elapsedSeconds.toFixed(3)} complete=${result.complete} softRestFallback=${result.audit.softRestFallback}`);
}
