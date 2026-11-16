const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/candidate.yml'), 'utf8'));
const step = workflow.jobs.metadata.steps.find(item => item.id === 'candidate');
const guardStart = step.run.indexOf('target="$(node -e');
const guard = step.run.slice(guardStart);

const source = 'a'.repeat(40);
const other = 'b'.repeat(40);

/** Runs the real guard with a fake `git ls-remote` printing the given lines. */
function runGuard(lsRemote) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nprintf '%s' '${lsRemote}'\n`, { mode: 0o755 });
    const script = `set -euo pipefail\nmetadata='{"targetVersion":"0.4.31"}'\n${guard}`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SOURCE_SHA: source } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the guard runs before any RC work and stays the last part of metadata resolution', () => {
  assert.ok(guardStart > step.run.indexOf('scripts/release-candidate.cjs'));
  assert.match(guard, /git ls-remote --tags origin "refs\/tags\/v\$\{target\}" "refs\/tags\/v\$\{target\}\^\{\}"/);
});

test('an unreleased version passes', () => {
  assert.equal(runGuard('').status, 0);
});

test('a version already released from another commit fails fast, using the peeled annotated tag', () => {
  const result = runGuard(`${'c'.repeat(40)}\trefs/tags/v0.4.31\n${other}\trefs/tags/v0.4.31^{}\n`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /v0\.4\.31 is already released from b{40}; bump the root package\.json version/);
});

test('re-qualifying the tagged commit itself is allowed', () => {
  assert.equal(runGuard(`${'c'.repeat(40)}\trefs/tags/v0.4.31\n${source}\trefs/tags/v0.4.31^{}\n`).status, 0);
  assert.equal(runGuard(`${source}\trefs/tags/v0.4.31\n`).status, 0);
});
