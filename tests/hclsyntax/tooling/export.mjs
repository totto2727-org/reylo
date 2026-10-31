// Development-only: Go is never needed by the maintained TypeScript tests.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function copyLicense(source, target) {
  if (existsSync(target)) chmodSync(target, 0o644);
  writeFileSync(target, readFileSync(source), { mode: 0o644 });
}
const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '..');
const root = resolve(output, '../..');
const upstream = resolve(process.argv[2] ?? join(root, 'tmp/direct-hcl/upstream'));
const go = process.env.GO ?? join(process.env.HOME, '.nix-profile/bin/go');
const revision = '00057cf06d7b38a3f89e6e54d622eee98322b314';
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (actual !== revision) throw new Error(`Expected upstream ${revision}, found ${actual}`);
mkdirSync(join(root, 'tmp/direct-hcl'), { recursive: true });
const work = mkdtempSync(join(root, 'tmp/direct-hcl/test-export-'));
const raw = join(work, 'raw.jsonl');
execFileSync(go, ['run', join(here, 'instrument.go'), upstream, work, join(here, 'oracle.go.txt')], { stdio: 'inherit' });
execFileSync(go, ['test', '-overlay', join(work, 'overlay.json'), './hclsyntax', '-count=1'], { cwd: upstream, env: { ...process.env, HCL_ORACLE_OUTPUT: raw }, stdio: 'inherit' });
const fixtures = readFileSync(raw, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
fixtures.sort((a, b) => `${a.name}\0${a.api}\0${a.source}`.localeCompare(`${b.name}\0${b.api}\0${b.source}`, 'en'));
const counts = {};
for (const fixture of fixtures) {
  const name = fixture.name.split('/')[0];
  const count = counts[name] ??= { calls: 0, apis: {}, cases: new Set() };
  count.calls++;
  count.apis[fixture.api] = (count.apis[fixture.api] ?? 0) + 1;
  count.cases.add(fixture.name);
}
const functions = JSON.parse(readFileSync(join(work, 'functions.json'), 'utf8'));
const textseg = JSON.parse(execFileSync(go, ['list', '-m', '-json', 'github.com/apparentlymart/go-textseg/v15'], { cwd: upstream, encoding: 'utf8' }));
const textsegSum = 'h1:uYvfpb3DyLSCGWnctWKGj857c6ew1u1fNQOlOtuGxQY=';
if (textseg.Version !== 'v15.0.0' || textseg.Sum !== textsegSum) throw new Error('Unexpected upstream grapheme module revision');
execFileSync(go, ['test', './textseg', '-count=1'], { cwd: textseg.Dir, stdio: 'inherit' });
const graphemes = JSON.parse(execFileSync(go, ['run', join(here, 'graphemes.go'), '--', join(textseg.Dir, 'textseg/tables_test.go')], { encoding: 'utf8' }));
const manifest = {
  upstream: { repository: 'https://github.com/hashicorp/hcl', tag: 'v2.25.0', revision, license: 'MPL-2.0', go: execFileSync(go, ['version'], { encoding: 'utf8' }).trim() },
  oracle: 'Unchanged upstream test assertions execute through a Go AST call-wrapper overlay. Expected values are serialized exclusively from the pinned Go implementation, never from the TypeScript port.',
  fixtures: fixtures.length,
  graphemes: { module: textseg.Path, version: textseg.Version, checksum: textsegSum, unicode: '15.0.0', license: 'MIT', file: 'textseg/tables_test.go', function: 'TestScanGraphemeClusters', cases: graphemes.length, coverage: 'Complete unicodeGraphemeTests table extracted from Go AST, preserving every input byte and expected cluster. Generic AllTokens/bufio.ScanWords tests excluded because that API is not ported.' },
  functions: Object.fromEntries(Object.entries(functions).map(([file, names]) => [file, names.map(name => ({ name, calls: counts[name]?.calls ?? 0, cases: counts[name]?.cases.size ?? 0, apis: counts[name]?.apis ?? {}, coverage: counts[name] ? (file.startsWith('expression') ? 'Parsing result, complete AST and parsing diagnostics only. Evaluation assertions execute in Go but are not claimed as ported.' : 'Every original table input with complete oracle result and diagnostics.') : 'Excluded: evaluation or static AST helper API not included in the native parser scope.' }))])),
  peeker: { file: 'peeker_test.go', function: 'TestPeeker', cases: 3, coverage: 'All three original scenarios transcribed directly with Peek/Read equality and exact token sequences.' },
  corpus: { cases: counts.TestReyloOfficialCorpus?.cases.size ?? 0, nativeSpecFiles: 15, fuzzConfig: 7, fuzzExpression: 10, fuzzTemplate: 8, excludedTraversalSeeds: 4, coverage: 'Pinned Go parser AST and diagnostics, not hcldec evaluation parity.' },
  exclusions: ['Expression.Value and cty evaluation assertions', 'Standalone traversal parsing, JSON parsing, hcldec body decoding, navigation, variable enumeration, walking', 'BenchmarkLexConfig performance benchmark, which has no correctness assertions', 'pos_test.go helpers not copied into the parser are outside scope'],
};
writeFileSync(join(output, 'grapheme-fixtures.json'), JSON.stringify(graphemes) + '\n');
copyLicense(join(textseg.Dir, 'LICENSE'), join(output, 'textseg.LICENSE'));
writeFileSync(join(output, 'fixtures.jsonl'), fixtures.map(fixture => JSON.stringify(fixture)).join('\n') + '\n');
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyLicense(join(upstream, 'LICENSE'), join(output, 'LICENSE'));
console.log(`Exported ${fixtures.length} official Go fixtures to ${output}`);
