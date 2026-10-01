import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import cases from '../src/engine/__tests__/fixtures/rotation_fingerprint_cases.json';
import { createPlayer, generateSchedule } from '../src/engine/rotation';

const fixturePath = resolve(import.meta.dirname, '../src/engine/__tests__/fixtures/rotation_fingerprint_cases.json');
type FingerprintCase = (typeof cases)[number];

function fingerprint(result: ReturnType<typeof generateSchedule>): string {
  return createHash('sha256').update(JSON.stringify({
    timeline: result.timeline,
    block_counts: result.block_counts,
    gk_summary: result.gk_summary,
    position_summary: result.position_summary,
    metadata: result.metadata,
    warnings: result.warnings,
    errors: result.errors,
  })).digest('hex');
}

function argumentValue(name: string): string | undefined {
  const argumentIndex = process.argv.indexOf(name);
  if (argumentIndex >= 0) return process.argv[argumentIndex + 1];
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  return argument?.slice(name.length + 1);
}

const caseId = argumentValue('--case');
const updateAllUnverified = process.argv.includes('--all-unverified');
const reviewedByTim = process.argv.includes('--reviewed-by-tim');

if ((caseId === undefined && !updateAllUnverified) || (caseId !== undefined && updateAllUnverified)) {
  throw new Error('Choose exactly one selector: --case <id> or --all-unverified.');
}

const selectedCases = cases.filter((testCase) => updateAllUnverified ? !testCase.spec_verified : testCase.id === caseId);
if (selectedCases.length === 0) throw new Error('No matching fingerprint cases selected.');
if (selectedCases.some((testCase) => testCase.spec_verified) && !reviewedByTim) {
  throw new Error('Updating a spec-verified fingerprint requires --reviewed-by-tim.');
}

const originalFingerprints = new Map(cases.map((testCase) => [testCase.id, testCase.fingerprint]));
const selectedIds = new Set(selectedCases.map((testCase) => testCase.id));
const updatedCases = cases.map((testCase) => {
  if (!selectedIds.has(testCase.id)) return testCase;
  const result = generateSchedule(testCase.game, testCase.players.map((player) => createPlayer(player)));
  return { ...testCase, fingerprint: fingerprint(result) };
});

for (const testCase of updatedCases) {
  if (!selectedIds.has(testCase.id) && testCase.fingerprint !== originalFingerprints.get(testCase.id)) {
    throw new Error(`Unselected fingerprint changed: ${testCase.id}.`);
  }
}

writeFileSync(fixturePath, `${JSON.stringify(updatedCases, null, 2)}\n`, 'utf8');
for (const testCase of selectedCases) {
  const updated = updatedCases.find((candidate) => candidate.id === testCase.id);
  console.log(`${testCase.id}: ${testCase.fingerprint} -> ${updated?.fingerprint}`);
}
