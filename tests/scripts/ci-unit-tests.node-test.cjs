const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '../..');
const script = path.join(root, 'scripts/ci-unit-tests.sh');
const slow = 'tests/storage/rdf/PostgresRdf*,tests/runtime/XpodRuntime.integration.test.ts';

/** Run the scope script in a scratch repo whose PR changed `changed`; return each `bun` invocation. */
function scope(mode, { event = 'push', changed = 'src/a.ts' } = {}) {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data', 'ci-unit-scope-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'README'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    fs.mkdirSync(path.dirname(path.join(dir, changed)), { recursive: true });
    fs.writeFileSync(path.join(dir, changed), 'change'); git('add', '.'); git('commit', '-qm', 'change');
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const log = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'bun'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
    execFileSync('bash', [script, mode], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      EVENT_NAME: event, BASE_SHA: event === 'pull_request' ? base : '', GITHUB_STEP_SUMMARY: '' } });
    return fs.readFileSync(log, 'utf8').trim().split('\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('slow mode runs only the slow group', () => {
  assert.deepEqual(scope('slow'), ['run test:run tests/storage/rdf/PostgresRdf tests/runtime/XpodRuntime.integration.test.ts']);
});

test('pushes run the whole unit suite except the slow group', () => {
  assert.deepEqual(scope('main'), [`run test:run --exclude {${slow}}`]);
});

test('a pull request that changes pipeline files runs every contract test', () => {
  for (const changed of ['.github/workflows/ci.yml', 'scripts/x.ts', 'tests/scripts/y.test.ts', 'package.json', 'bun.lock']) {
    assert.deepEqual(scope('main', { event: 'pull_request', changed }), [`run test:run --exclude {${slow}}`], changed);
  }
});

test('a product-only pull request runs tests/scripts only where imports reach', () => {
  const calls = scope('main', { event: 'pull_request', changed: 'src/api/x.ts' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], `run test:run --exclude {${slow},tests/scripts/**}`);
  assert.match(calls[1], /^run test:run --changed [0-9a-f]{40} --passWithNoTests tests\/scripts$/);
});
