/**
 * Cross-step shell isolation for the RC bootstrap consumer.
 *
 * GitHub Actions executes each `run:` block in its own shell, so a variable
 * defined by the secret-validation step is unbound in the next step. These
 * tests take the REAL consuming step from candidate.yml, split off its
 * prologue, and execute it in a clean `sh -eu` process:
 *   - the pre-fix shape (bare `$env_file`) aborts with "unbound variable";
 *   - the shipped prologue re-derives the canonical path and proceeds;
 *   - a missing env file fails closed instead of continuing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deploySteps,
  findStep,
  runShell,
  tempDir,
  writeExecutable,
} from './rc-dedicated-postgres-fixture.mjs';

const producer = findStep(deploySteps(), 'Validate RC runtime secret isolation');
const consumer = findStep(deploySteps(), 'Verify RC-only PostgreSQL and bootstrap');
const consumerScript = consumer.run;
const prologue = consumerScript.split('node scripts/render-rc-manifests.cjs')[0];

test('the producing step keeps env_file step-local (no GITHUB_ENV export)', () => {
  assert.match(producer.run, /env_file="\$\{RUNNER_TEMP\}\/xpod-rc\.env"/);
  assert.equal(/env_file.*>>\s*"?\$GITHUB_ENV/.test(producer.run), false);
});

test('the legacy cross-step reference aborts in a clean shell', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-old-');
  const result = runShell('sh', [ '-eu', '-c' ], 'set -euo pipefail\n: "$env_file"\necho reached', {
    env: { RUNNER_TEMP: directory },
  });
  assert.notEqual(result.status, 0, 'an unbound cross-step variable must fail');
  assert.match(`${result.stdout}${result.stderr}`, /env_file: (unbound variable|parameter not set)/);
  assert.equal(String(result.stdout).includes('reached'), false);
});

test('the shipped prologue re-derives env_file and proceeds', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-new-');
  const envPath = path.join(directory, 'xpod-rc.env');
  writeFileSync(envPath, 'CSS_IDENTITY_DB_URL=postgresql://xpod_rc:synthetic@xpod-rc-rdf-postgres:5432/xpod_rc\n', { mode: 0o600 });
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  writeExecutable(path.join(bin, 'kubectl'), '#!/bin/sh\nexit 0\n');

  assert.ok(prologue.includes('env_file='), 'prologue must define env_file');
  assert.equal(prologue.trimEnd().endsWith('\\'), false, 'prologue must not end on a continuation');

  const result = runShell('sh', [ '-eu', '-c' ], `${prologue}\necho ENV_FILE_BOUND:$env_file`, {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '1',
      SEALOS_NAMESPACE: 'ns-test',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(String(result.stdout).includes(`ENV_FILE_BOUND:${envPath}`), result.stdout);
});

test('a missing canonical env file fails closed', (t) => {
  const directory = tempDir(t, 'xpod-rc-step-missing-');
  const result = runShell('sh', [ '-eu', '-c' ], prologue, {
    env: { RUNNER_TEMP: directory, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', SEALOS_NAMESPACE: 'ns-test' },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /validated RC env file is missing/);
});

test('the consumer never echoes or cats the validated env file', () => {
  assert.equal(/echo.*\$env_file/.test(consumerScript), false);
  assert.equal(/cat\s+"\$env_file"/.test(consumerScript), false);
  assert.match(consumerScript, /env_file="\$\{RUNNER_TEMP\}\/xpod-rc\.env"/);
});
