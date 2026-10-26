/**
 * Executes the REAL "Validate RC runtime secret isolation" step body from
 * candidate.yml with synthetic input. The step must accept the CURRENT
 * shared-host APP_ENV_FILE credentials, preserve every non-database entry, and
 * write a temp env file whose two DSNs point at the dedicated RC PostgreSQL
 * service. No GitHub secret is read or written; the R2/seed `bun` calls are
 * replaced by no-op stubs so no network is possible.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deploySteps,
  findStep,
  repoRoot,
  runShell,
  tempDir,
} from './rc-dedicated-postgres-fixture.mjs';

const step = findStep(deploySteps(), 'Validate RC runtime secret isolation');
const NS = 'ns-iknkxtc8';
const PASSWORD = 'p%40ss%2Fw%3Ard%27%3B%24x';
const SHARED = `postgresql://xpod_rc:${PASSWORD}@xpod-rdf-postgres.${NS}.svc:5432/xpod_rc`;
const RC = 'xpod-rc-rdf-postgres';

function runStep(t) {
  const directory = tempDir(t, 'xpod-rc-runtime-env-');
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  for (const tool of [ 'bun' ]) {
    writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(path.join(bin, tool), 0o700);
  }
  const envText = [
    `CSS_IDENTITY_DB_URL=${SHARED}`,
    `CSS_SPARQL_ENDPOINT=${SHARED}`,
    'CSS_REDIS_CLIENT=redis://cache:6379/7',
    'CSS_MINIO_ENDPOINT=https://bucket.r2.cloudflarestorage.com',
    'CSS_MINIO_BUCKET_NAME=xpod-rc',
    'CSS_MINIO_ACCESS_KEY=AKIATEST',
    'CSS_MINIO_SECRET_KEY=secretvalue',
    'XPOD_INNGEST_EVENT_KEY=eventkey',
    'XPOD_INNGEST_SIGNING_KEY=signingkey',
    'UNRELATED_SETTING=keep-me',
  ].join('\n') + '\n';
  const seedText = JSON.stringify([
    { email: 'alice@example.test', pods: [ { name: 'alice-pod' } ] },
    { email: 'bob@example.test', pods: [ { name: 'bob-pod' } ] },
  ]);
  const script = path.join(directory, 'step.sh');
  writeFileSync(script, step.run);
  const result = runShell('bash', [ '-e' ], script, {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      SEALOS_NAMESPACE: NS,
      APP_ENV_FILE: envText,
      XPOD_RC_SEED_CONFIG: seedText,
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '3',
    },
    timeout: 120_000,
  });
  const envFile = path.join(directory, 'xpod-rc.env');
  const written = readFileSync(envFile, 'utf8');
  const map = new Map();
  for (const line of written.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) map.set(match[1], match[2]);
  }
  return { result, written, map, mode: statSync(envFile).mode & 0o777 };
}

test('the real step accepts the current shared-host APP_ENV_FILE credentials', (t) => {
  const { result, written } = runStep(t);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(written.includes('xpod-rdf-postgres'), false,
    'the shared service host must not survive materialization');
});

test('only the hostname is derived; credentials and other fields are unchanged', (t) => {
  const { map } = runStep(t);
  const expected = `postgresql://xpod_rc:${PASSWORD}@${RC}:5432/xpod_rc`;
  assert.equal(map.get('CSS_IDENTITY_DB_URL'), expected);
  assert.equal(map.get('CSS_SPARQL_ENDPOINT'), expected);
  for (const [ key, value ] of [
    [ 'UNRELATED_SETTING', 'keep-me' ],
    [ 'CSS_REDIS_CLIENT', 'redis://cache:6379/7' ],
    [ 'CSS_MINIO_BUCKET_NAME', 'xpod-rc' ],
    [ 'XPOD_INNGEST_SIGNING_KEY', 'signingkey' ],
  ]) assert.equal(map.get(key), value, key);
});

test('the rendered env file is private to the runner', (t) => {
  assert.equal(runStep(t).mode, 0o600);
});

test('production hosts/roles and conflicting aliases are rejected by the step', (t) => {
  for (const replacement of [
    `postgresql://xpod_rc:${PASSWORD}@production-postgres:5432/xpod_rc`,
    `postgresql://postgres:${PASSWORD}@xpod-rdf-postgres.${NS}.svc:5432/xpod_rc`,
    `postgresql://xpod_rc:${PASSWORD}@xpod-rdf-postgres.${NS}.svc:5432/xpod_cn`,
  ]) {
    const directory = tempDir(t, 'xpod-rc-runtime-reject-');
    const bin = path.join(directory, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const script = path.join(directory, 'step.sh');
    writeFileSync(script, step.run);
    const envText = [
      `CSS_IDENTITY_DB_URL=${replacement}`,
      `CSS_SPARQL_ENDPOINT=${replacement}`,
      'CSS_REDIS_CLIENT=redis://cache:6379/7',
      'CSS_MINIO_ENDPOINT=https://bucket.r2.cloudflarestorage.com',
      'CSS_MINIO_BUCKET_NAME=xpod-rc',
      'CSS_MINIO_ACCESS_KEY=AKIATEST',
      'CSS_MINIO_SECRET_KEY=secretvalue',
      'XPOD_INNGEST_EVENT_KEY=eventkey',
      'XPOD_INNGEST_SIGNING_KEY=signingkey',
    ].join('\n') + '\n';
    const result = runShell('bash', [ '-e' ], script, {
      cwd: repoRoot,
      env: {
        PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory,
        SEALOS_NAMESPACE: NS, APP_ENV_FILE: envText,
        XPOD_RC_SEED_CONFIG: JSON.stringify([ { email: 'alice@x' }, { email: 'bob@x' } ]),
        GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
      },
    });
    assert.notEqual(result.status, 0, replacement);
    assert.match(`${result.stdout}${result.stderr}`, /RC database configuration rejected/);
  }
});
