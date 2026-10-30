/**
 * Integration test for the real Bun test entry (`scripts/run-bun-tests.ts`).
 *
 * These cases drive the ACTUAL entry script and the ACTUAL discovery helper, copied byte-for-byte
 * into a small private fixture project, so they exercise the shipped process boundary instead of
 * re-implementing it. The fixture's own `bun:test` files are tiny and offline.
 *
 * Regression meaning: a per-file runner must give each discovered file a distinct process (the
 * monolithic form ran them in one process), keep running later files after an ordinary failure, and
 * fail the whole run on a signalled child even when its stdout had already printed a passing summary.
 */
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const ENTRY = path.join(ROOT, 'scripts/run-bun-tests.ts');
const DISCOVERY = path.join(ROOT, 'scripts/bun-test-discovery.cjs');
// The real discovery helper imports these siblings; copy the actual modules, never stubs.
const DISCOVERY_SUPPORT = [
  'scripts/test-runner-ownership.cjs',
  'scripts/test-runner-ownership.json',
  'scripts/test-file-names.json',
];
const SUITE = path.join(ROOT, '.test-data/bun-test-runner-integration');

const bun = () => {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, `bun must be available for the Bun entry integration tests: ${probe.error?.message ?? probe.stderr}`);
  return 'bun';
};

/** Build a private fixture project containing the real entry + real discovery helper. */
function fixture(name, files) {
  mkdirSync(SUITE, { recursive: true, mode: 0o700 });
  const project = mkdtempSync(path.join(SUITE, `${name}-`));
  mkdirSync(path.join(project, 'scripts'), { recursive: true });
  copyFileSync(ENTRY, path.join(project, 'scripts/run-bun-tests.ts'));
  copyFileSync(DISCOVERY, path.join(project, 'scripts/bun-test-discovery.cjs'));
  for (const support of DISCOVERY_SUPPORT) {
    copyFileSync(path.join(ROOT, support), path.join(project, support));
  }
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(project, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return project;
}

function runEntry(project, args = []) {
  const result = spawnSync(bun(), ['scripts/run-bun-tests.ts', ...args], { cwd: project, encoding: 'utf8', env: process.env });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('each discovered file runs in its own Bun process with independent module state', () => {
  const project = fixture('pids', {
    'tests/bun/alpha.test.ts': [
      "import {test, expect} from 'bun:test';",
      "import {writeFileSync} from 'node:fs';",
      "test('alpha records its pid', () => {",
      "  writeFileSync('alpha.pid', String(process.pid));",
      "  globalThis.__xpodSharedState = 1;",
      "  expect(process.pid).toBeGreaterThan(0);",
      "});",
    ].join('\n'),
    'tests/bun/beta.test.ts': [
      "import {test, expect} from 'bun:test';",
      "import {writeFileSync} from 'node:fs';",
      "test('beta records its pid and cannot see alpha global state', () => {",
      "  writeFileSync('beta.pid', String(process.pid));",
      "  expect(globalThis.__xpodSharedState).toBeUndefined();",
      "});",
    ].join('\n'),
  });
  try {
    const result = runEntry(project);
    assert.equal(result.status, 0, `entry must succeed: ${result.stderr}`);
    const alpha = Number(readFileSync(path.join(project, 'alpha.pid'), 'utf8'));
    const beta = Number(readFileSync(path.join(project, 'beta.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(alpha) && alpha > 0, 'alpha pid must be recorded');
    assert.ok(Number.isSafeInteger(beta) && beta > 0, 'beta pid must be recorded');
    assert.notEqual(alpha, beta, 'each file must run in a distinct Bun process');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a failing file does not stop later files and the run exits nonzero', () => {
  const project = fixture('failure', {
    'tests/bun/one-fails.test.ts': "import {test, expect} from 'bun:test';\ntest('fails', () => { expect(1).toBe(2); });\n",
    'tests/bun/two-runs.test.ts': "import {test, expect} from 'bun:test';\nimport {writeFileSync} from 'node:fs';\ntest('later file still runs', () => { writeFileSync('later.ran', 'yes'); expect(1).toBe(1); });\n",
  });
  try {
    const result = runEntry(project);
    assert.equal(result.status, 1, 'an ordinary completed test failure must make the entry exit nonzero');
    assert.equal(readFileSync(path.join(project, 'later.ran'), 'utf8'), 'yes', 'later files must still run after a failure');
    assert.match(result.stderr, /one-fails\.test\.ts/, 'the failing file must be named');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('a signalled child fails the run even though it printed a passing summary', () => {
  const project = fixture('signal', {
    // Prints a real pass-shaped summary, then dies by signal: stdout alone would look green,
    // so this is exactly the case a stdout-parsing gate would wrongly accept.
    'tests/bun/a-signals.test.ts': [
      "import {test, expect} from 'bun:test';",
      "test('prints a pass-like summary then signals', () => {",
      "  expect(1).toBe(1);",
      "  console.log(' 1 pass');",
      "  console.log('Ran 1 test across 1 file. [1.00ms]');",
      "  process.kill(process.pid, 'SIGTERM');",
      "});",
    ].join('\n'),
    'tests/bun/z-after-signal.test.ts': "import {test, expect} from 'bun:test';\nimport {writeFileSync} from 'node:fs';\ntest('still runs after the signal', () => { writeFileSync('after-signal.ran', 'yes'); expect(1).toBe(1); });\n",
  });
  try {
    const result = runEntry(project);
    assert.equal(result.status, 1, 'a signalled child must make the entry exit nonzero');
    assert.equal(readFileSync(path.join(project, 'after-signal.ran'), 'utf8'), 'yes', 'the later file must still run after a signalled child');
    assert.match(result.stderr, /a-signals\.test\.ts/, 'the signalled file must be named');
    assert.match(result.stderr, /was terminated by/, 'the signal must be reported');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('an empty discovery fails and --list keeps its existing contract', () => {
  const empty = fixture('empty', {});
  try {
    const result = runEntry(empty);
    assert.equal(result.status, 1, 'empty discovery must fail rather than silently pass');
    assert.match(result.stderr, /no Bun-only test files found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  const listed = fixture('list', {
    'tests/bun/listed.test.ts': "import {test, expect} from 'bun:test';\ntest('ok', () => { expect(1).toBe(1); });\n",
  });
  try {
    const result = runEntry(listed, ['--list']);
    assert.equal(result.status, 0, '--list must succeed');
    assert.equal(result.stdout.trim().split('\n').at(-1), '1 Bun-only test file(s)', 'summary line must be preserved');
    assert.equal(result.stdout.trim().split('\n')[0], 'tests/bun/listed.test.ts', 'relative path per file must be preserved');
  } finally {
    rmSync(listed, { recursive: true, force: true });
  }
});
