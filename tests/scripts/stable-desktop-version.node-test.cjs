const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const repo = path.resolve(__dirname, '../..');
const workflow = yaml.load(fs.readFileSync(path.join(repo, '.github/workflows/release-desktop.yml'), 'utf8'));
const steps = workflow.jobs.build_desktop_macos.steps;
const versionStep = steps.find(step => /^(Apply and validate stable desktop version|Validate desktop version)$/.test(step.name));

function withFixture(rootVersion, desktopVersion, check) {
  const parent = path.join(repo, '.test-data/stable-desktop-version');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'case-'));
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.mkdirSync(path.join(directory, 'desktop'));
    for (const name of ['release-candidate.cjs', 'platform-binaries.cjs', 'sync-platform-package-version.cjs']) {
      fs.copyFileSync(path.join(repo, 'scripts', name), path.join(directory, 'scripts', name));
    }
    write('package.json', { name: '@undefineds.co/xpod', version: rootVersion,
      optionalDependencies: { '@undefineds.co/xpod-darwin-arm64': rootVersion }, marker: 'root source' });
    write('desktop/package.json', { name: 'xpod-desktop', version: desktopVersion, marker: 'desktop source' });
    const run = expectedVersion => spawnSync('bash', ['-c', `set -euo pipefail\n${versionStep.run}`], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, RELEASE_VERSION: expectedVersion },
    });
    check({ read, run });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('stable derives a stale desktop manifest from the accepted root version using the real workflow command', () => {
  withFixture('0.4.33', '0.4.32', ({ read, run }) => {
    const result = run('0.4.33');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(read('package.json'), { name: '@undefineds.co/xpod', version: '0.4.33',
      optionalDependencies: { '@undefineds.co/xpod-darwin-arm64': '0.4.33' }, marker: 'root source' });
    assert.deepEqual(read('desktop/package.json'), { name: 'xpod-desktop', version: '0.4.33', marker: 'desktop source' });
    assert.equal(run('0.4.33').status, 0, 'applying the same derived version is idempotent');
  });
});

test('a tag/root version mismatch fails before changing either manifest', () => {
  withFixture('0.4.32', '0.4.31', ({ read, run }) => {
    const before = [read('package.json'), read('desktop/package.json')];
    const result = run('0.4.33');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /root version 0\.4\.32 does not match 0\.4\.33/);
    assert.deepEqual([read('package.json'), read('desktop/package.json')], before);
  });
});

test('the manifest transform follows clean API production and precedes packaging', () => {
  const at = steps.indexOf(versionStep);
  const api = steps.findIndex(step => step.name === 'Produce the API capability from clean source');
  const restore = steps.findIndex(step => step.name === 'Restore the normal full-frozen root dependency tree');
  const build = steps.findIndex(step => step.name === 'Build DMG and ZIP');
  assert.ok(api >= 0 && restore > api && at > restore && build > at);
  assert.match(versionStep.run, /applyRootVersion\(process\.cwd\(\), root\.version\)/);
  assert.equal(versionStep['continue-on-error'], undefined);
});
