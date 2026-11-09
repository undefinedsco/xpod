/**
 * Behavioural execution of the REAL workflow shell fragments.
 *
 * The quiescence gate and the cleanup Job block are extracted from
 * candidate.yml at run time (never retyped) and executed with `bash -e` against
 * a fake `kubectl` that records calls and can fail specific verbs. These tests
 * prove the observable behaviour: an active app blocks the reset, an API error
 * aborts instead of reading as "absent", owned Jobs are deleted only with the
 * UID precondition, and foreign Jobs are retained.
 *
 * No cluster, Docker, network or credential is touched.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupSteps,
  deploySteps,
  findStep,
  repoRoot,
  runShell,
  tempDir,
} from './rc-dedicated-postgres-fixture.mjs';

const bootstrapStep = findStep(deploySteps(), 'Verify RC-only PostgreSQL and bootstrap');
const quiescenceStart = bootstrapStep.run.indexOf('quiesce_dir=');
// The gate ends before the run-owned Job cleanup that follows it.
const quiescenceEnd = bootstrapStep.run.indexOf('existing_dir=', quiescenceStart);
assert.ok(quiescenceStart >= 0 && quiescenceEnd > quiescenceStart, 'quiescence fragment located');
const quiescenceFragment = bootstrapStep.run.slice(quiescenceStart, quiescenceEnd);
assert.ok(quiescenceFragment.includes('rc-bootstrap-ownership.cjs quiescent'), 'gate included');

const cleanupFragment = findStep(cleanupSteps(), 'Scale RC deployments').run;

const RUN_ID = '4242';
const ATTEMPT = '3';
const JOB = `xpod-rc-postgres-bootstrap-${RUN_ID}-${ATTEMPT}`;
const NS = 'ns-iknkxtc8';

function sandbox(t, options = {}) {
  const {
    jobPresent = true, jobOwner = JOB, jobUid = 'uid-1', failGet = false,
    failDelete = false, failWait = false, deploymentPresent = true,
    deploymentReplicas = 0, podPhase = 'Succeeded', podDeleting = false,
  } = options;

  const dir = tempDir(t, 'xpod-rc-fragment-');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const log = path.join(dir, 'kubectl.log');
  writeFileSync(log, '');

  const job = { apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: JOB, uid: jobUid,
      annotations: { 'xpod.undefineds.co/bootstrap-owner': jobOwner } } };
  const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'xpod-rc' },
    spec: { replicas: deploymentReplicas },
    status: { replicas: deploymentReplicas, readyReplicas: deploymentReplicas,
      availableReplicas: deploymentReplicas } };
  const pod = { apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'xpod-rc-abc',
      ...(podDeleting ? { deletionTimestamp: '2026-01-01T00:00:00Z' } : {}) },
    status: { phase: podPhase } };

  const NL = String.fromCharCode(10);
  const stub = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + ${JSON.stringify(NL)});`,
    "const has = (v) => args.includes(v);",
    "const verb = args[0] === '-n' ? args[2] : args[0];",
    'const out = (value) => { process.stdout.write(JSON.stringify(value) + ' + JSON.stringify(NL) + '); process.exit(0); };',
    "const fail = (code, message) => { process.stderr.write(message + " + JSON.stringify(NL) + "); process.exit(code); };",
    `const JOB = ${JSON.stringify(job)};`,
    `const DEPLOYMENT = ${JSON.stringify(deployment)};`,
    `const POD = ${JSON.stringify(pod)};`,
    "if (verb === 'wait') {",
    `  if (${failWait} === true) fail(7, 'simulated wait failure');`,
    '  process.exit(0);',
    '}',
    "if (verb === 'config' && has('view')) {",
    "  out({'current-context':'ctx',contexts:[{name:'ctx',context:{cluster:'c',user:'u'}}],",
    "    clusters:[{name:'c',cluster:{server:'https://gzg.sealos.run:6443'}}],users:[{name:'u',user:{}}]});",
    '}',
    "if (verb === 'get' && args.includes('deployment') && has('xpod-rc')) {",
    `  if (${failGet} === true) fail(5, 'simulated API failure');`,
    `  if (${deploymentPresent} === false) process.exit(0);`,
    '  out(DEPLOYMENT);',
    '}',
    "if (verb === 'get' && args.includes('pods')) {",
    `  if (${failGet} === true) fail(5, 'simulated API failure');`,
    "  out({apiVersion:'v1', kind:'List', items: [POD]});",
    '}',
    "if (verb === 'get' && args.includes('job')) {",
    `  if (${failGet} === true) fail(5, 'simulated API failure');`,
    `  if (${jobPresent} === false) process.exit(0);`,
    '  out(JOB);',
    '}',
    "if (has('--raw')) {",
    "  const idx = args.indexOf('-f');",
    "  if (idx < 0) fail(2, 'no delete options file');",
    "  const doc = JSON.parse(fs.readFileSync(args[idx + 1], 'utf8'));",
    `  if (${failDelete} === true) fail(5, 'simulated delete failure');`,
    "  if (!doc.preconditions || !doc.preconditions.uid) fail(6, 'missing uid precondition');",
    `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({deletedWithUid: doc.preconditions.uid}) + ${JSON.stringify(NL)});`,
    '  process.exit(0);',
    '}',
    'process.exit(0);',
    '',
  ].join(NL);
  writeFileSync(path.join(bin, 'kubectl'), stub);
  chmodSync(path.join(bin, 'kubectl'), 0o700);
  // The consuming step re-derives the validated env file (W1 fail-closed).
  writeFileSync(path.join(dir, 'xpod-rc.env'),
    'CSS_IDENTITY_DB_URL=postgresql://xpod_rc:synthetic@xpod-rc-rdf-postgres:5432/xpod_rc\n', { mode: 0o600 });
  return { dir, bin, log };
}

function runFragment(t, fragment, box) {
  const script = path.join(box.dir, 'fragment.sh');
  writeFileSync(script, fragment);
  writeFileSync(path.join(box.dir, 'kubeconfig'), JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'ctx',
    contexts: [{ name: 'ctx', context: { cluster: 'c', user: 'u' } }],
    clusters: [{ name: 'c', cluster: { server: 'https://gzg.sealos.run:6443' } }],
    users: [{ name: 'u', user: {} }],
  }));
  return runShell('bash', [ '-e' ], script, {
    cwd: repoRoot,
    env: {
      PATH: `${box.bin}:${process.env.PATH}`,
      KUBE_CONFIG_DATA: Buffer.from('apiVersion: v1\nkind: Config\n').toString('base64'),
      XPOD_RC_SEED_SECRET_NAME: 'xpod-rc-seed-1-1',
      RUNNER_TEMP: box.dir,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_RUN_ATTEMPT: ATTEMPT,
      SEALOS_NAMESPACE: NS,
    },
    timeout: 60_000,
  });
}

// ---------------------------------------------------------------- quiescence
test('quiescence proceeds when the app is absent and no pod is running', (t) => {
  const box = sandbox(t, { deploymentPresent: false });
  const result = runFragment(t, `${quiescenceFragment}\necho QUIESCENT_OK\n`, box);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /QUIESCENT_OK/);
});

test('a running app blocks the reset before any PG mutation', (t) => {
  const box = sandbox(t, { deploymentReplicas: 1, podPhase: 'Running' });
  const result = runFragment(t, `${quiescenceFragment}\necho AFTER\n`, box);
  assert.notEqual(result.status, 0, 'an active candidate must fail closed');
  assert.equal(result.stdout.includes('AFTER'), false);
});

test('an API error aborts instead of being read as absent', (t) => {
  const box = sandbox(t, { failGet: true });
  const result = runFragment(t, `${quiescenceFragment}\necho SHOULD_NOT_RUN\n`, box);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes('SHOULD_NOT_RUN'), false);
});

test('the gate never scales the app itself', () => {
  assert.equal(/scale deployment\/xpod-rc/.test(quiescenceFragment), false);
});

// ------------------------------------------------- owned Job cleanup (cleanup step)
test('an owned Job is deleted with its live UID precondition', (t) => {
  const box = sandbox(t, {});
  const result = runFragment(t, cleanupFragment, box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(box.log, 'utf8'), /deletedWithUid/);
});

test('a foreign same-name Job is retained, never deleted', (t) => {
  const box = sandbox(t, { jobOwner: 'someone-else' });
  const result = runFragment(t, cleanupFragment, box);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not owned by this run; retained/);
  assert.equal(readFileSync(box.log, 'utf8').includes('deletedWithUid'), false);
});

test('an already-absent Job still proves its own pods are gone', (t) => {
  const box = sandbox(t, { jobPresent: false });
  const result = runFragment(t, cleanupFragment, box);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(box.log, 'utf8');
  assert.match(calls, /"wait"/);
  assert.match(calls, /--for=delete/);
  assert.match(calls, new RegExp(`job-name=${JOB}`));
  assert.equal(calls.includes('deletedWithUid'), false);
});

test('a failing pod wait on the absent-Job path propagates', (t) => {
  const box = sandbox(t, { jobPresent: false, failWait: true });
  assert.notEqual(runFragment(t, cleanupFragment, box).status, 0);
});

test('a failing delete or observation is not swallowed', (t) => {
  assert.notEqual(runFragment(t, cleanupFragment, sandbox(t, { failDelete: true })).status, 0);
  assert.notEqual(runFragment(t, cleanupFragment, sandbox(t, { failGet: true })).status, 0);
});

test('owned Job cleanup is outside the app ownership conditional', (t) => {
  const text = findStep(cleanupSteps(), 'Scale RC deployments').run;
  const bootstrapAt = text.indexOf('bootstrap_job=');
  const gateAt = text.indexOf('if [ "$ownership_status" -eq 0 ]');
  assert.ok(bootstrapAt > 0, 'owned bootstrap cleanup block present');
  assert.ok(gateAt > bootstrapAt, 'bootstrap cleanup must precede the app ownership gate');
  assert.equal(/kubectl delete --raw[\s\S]{0,300}\|\| true/.test(text), false,
    'delete failures must not be swallowed');
  assert.equal(/get job "\$bootstrap_job" -o json[^\n]*2>\/dev\/null/.test(text), false,
    'observation must not swallow API errors');
});
