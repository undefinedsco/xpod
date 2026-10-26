/**
 * RC-dedicated PostgreSQL quiescence and bootstrap-Job ownership.
 *
 * These drive the REAL scripts/rc-bootstrap-ownership.cjs with synthetic
 * Kubernetes objects. Quiescence must fail closed (never scale an active
 * candidate) and a same-name Job may be deleted only with this run's nonce AND
 * its live UID.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { requireRepoModule } from './rc-dedicated-postgres-fixture.mjs';

const helper = requireRepoModule('scripts/rc-bootstrap-ownership.cjs');
const NONCE = 'xpod-rc-postgres-bootstrap-1-1';

const deployment = (replicas, status = {}) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'xpod-rc' },
  spec: replicas === undefined ? {} : { replicas },
  status,
});
const pod = (name, phase, terminating = false) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name, ...(terminating ? { deletionTimestamp: '2026-01-01T00:00:00Z' } : {}) },
  status: { phase },
});
const podList = (...items) => ({ apiVersion: 'v1', kind: 'List', items });
const ownedJob = (uid, owner = NONCE) => ({
  apiVersion: 'batch/v1',
  kind: 'Job',
  metadata: { name: NONCE, uid, annotations: { [helper.OWNER_ANNOTATION]: owner } },
});

test('absent app and no pods is quiescent', () => {
  assert.equal(helper.quiescent(null, podList()).quiescent, true);
});

test('app at zero with only finished pods is quiescent', () => {
  const result = helper.quiescent(
    deployment(0, { replicas: 0, readyReplicas: 0, availableReplicas: 0 }),
    podList(pod('xpod-rc-old', 'Succeeded')),
  );
  assert.equal(result.quiescent, true);
});

test('a running, pending, terminating or unknown-phase pod blocks', () => {
  for (const [phase, terminating] of [ [ 'Running', false ], [ 'Pending', false ],
    [ 'Running', true ], [ 'Unknown', false ], [ undefined, false ] ]) {
    assert.throws(
      () => helper.quiescent(null, podList(pod('xpod-rc-abc', phase, terminating))),
      /not quiescent|terminating|phase/,
      `${phase}/${terminating}`,
    );
  }
});

test('non-zero spec.replicas or observed status blocks even with no pods', () => {
  assert.throws(() => helper.quiescent(deployment(1, {}), podList()), /spec.replicas is 1/);
  assert.throws(() => helper.quiescent(deployment(undefined, {}), podList()), /spec.replicas is 1/);
  assert.throws(
    () => helper.quiescent(deployment(0, { replicas: 1, readyReplicas: 0, availableReplicas: 0 }), podList()),
    /status.replicas is 1/,
  );
});

test('malformed deployment or pod input is rejected, never read as empty', () => {
  assert.throws(() => helper.quiescent({ metadata: {} }, podList()), /deployment|Deployment/);
  assert.throws(() => helper.quiescent(null, null), /pod list/);
  assert.throws(() => helper.quiescent(null, { items: 'nope' }), /items/);
});

test('quiescence never mutates the deployment (no scale-to-zero)', () => {
  const input = deployment(1, { replicas: 1 });
  const snapshot = JSON.stringify(input);
  assert.throws(() => helper.quiescent(input, podList()), /quiescent/);
  assert.equal(JSON.stringify(input), snapshot, 'quiescence must never scale an active candidate');
});

test('annotate stamps only the Job and requires a bounded nonce', () => {
  const job = { kind: 'Job', metadata: { name: 'j' }, spec: {} };
  const stamped = helper.annotate(job, NONCE);
  assert.equal(stamped.metadata.annotations[helper.OWNER_ANNOTATION], NONCE);
  assert.equal(job.metadata.annotations, undefined, 'input must not be mutated');
  assert.throws(() => helper.annotate(job, 'short'), /bounded ownership nonce/);
  assert.throws(() => helper.annotate(job, 'bad nonce with spaces'), /bounded ownership nonce/);
});

test('delete-options refuses a foreign owner, a missing UID and a malformed Job', () => {
  assert.throws(() => helper.deleteOptions(ownedJob('uid-1', 'other-run'), NONCE), /not owned by this run/);
  const noUid = ownedJob('uid-1');
  delete noUid.metadata.uid;
  assert.throws(() => helper.deleteOptions(noUid, NONCE), /no UID/);
  assert.throws(() => helper.deleteOptions({ metadata: {} }, NONCE), /malformed/);
});

test('delete-options pins the exact live UID', () => {
  assert.deepEqual(helper.deleteOptions(ownedJob('uid-42'), NONCE), {
    apiVersion: 'v1',
    kind: 'DeleteOptions',
    preconditions: { uid: 'uid-42' },
  });
});

test('a replaced Job at the same name yields a different precondition', () => {
  assert.notDeepEqual(
    helper.deleteOptions(ownedJob('uid-new'), NONCE),
    helper.deleteOptions(ownedJob('uid-old'), NONCE),
  );
});
