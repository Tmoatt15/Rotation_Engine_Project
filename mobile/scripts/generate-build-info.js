const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(mobileRoot, '..');
const hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim();

const outputPath = path.join(mobileRoot, 'src', 'buildInfo.ts');
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `export const buildHash = '${hash}';\n`);
console.log(`Generated ${path.relative(mobileRoot, outputPath)} for build ${hash}`);
