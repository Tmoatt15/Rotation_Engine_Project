import cases from '../src/engine/__tests__/fixtures/rotation_fingerprint_cases.json';
import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '../src/engine-redesign';
import type { RedesignGameInput, RedesignPlayerInput } from '../src/engine-redesign/model';

function formatFor(formation: string, explicit?: string): RedesignGameInput['format'] | '5v5' {
  if (explicit) return explicit as RedesignGameInput['format'] | '5v5';
  if (formation === '2-3-1') return '7v7';
  if (formation === '3-3-2') return '9v9';
  if (formation === '4-4-2' || formation === '4-3-3') return '11v11';
  return '4v4';
}

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
    const polished = runStages3And4(game, demand, quotas);
    console.log(`[${fixture.id}] complete=${polished.complete} blocks=${polished.blocks.length} errors=${polished.audit.errors.join(';') || '-'} restFallback=${polished.audit.softRestFallback} metrics=${JSON.stringify(polished.metrics)}`);
  } catch (error) {
    console.log(`[${fixture.id}] rejected=${(error as Error).message}`);
  }
}
