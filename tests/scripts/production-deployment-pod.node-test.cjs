const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { selectReadyPod, targetDigest } = require('../../scripts/lib/production-deployment-pod.cjs');

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'scripts/lib/production-deployment-pod.cjs');
const TARGET = `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OLD_IMAGE = `ghcr.io/undefinedsco/xpod@sha256:${'b'.repeat(64)}`;
const OLD_DIGEST = `sha256:${'b'.repeat(64)}`;
const SERVICE_CONTAINER = 'xpod-co';

function pod(name, { image = TARGET, imageID = `docker-pullable://${TARGET}`, ready = true,
  phase = 'Running', deleting = false, container = SERVICE_CONTAINER, createdAt = '2026-11-16T10:00:00Z' } = {}) {
  const metadata = { name, creationTimestamp: createdAt };
  if (deleting) {
    metadata.deletionTimestamp = '2026-11-16T10:49:56Z';
  }
  return {
    metadata,
    spec: {
      containers: [
        { name: container, image },
        { name: 'sidecar', image: 'ghcr.io/undefinedsco/inngest:1.2.3' },
      ],
    },
    status: {
      phase,
      conditions: [ { type: 'Ready', status: ready ? 'True' : 'False' } ],
      containerStatuses: [
        { name: container, ready, imageID },
        { name: 'sidecar', ready: true, imageID: 'docker-pullable://ghcr.io/undefinedsco/inngest:1.2.3' },
      ],
    },
  };
}

function list(...pods) {
  return { items: pods };
}

test('selects the new Ready Pod while the old Pod is still Running and Ready but terminating', () => {
  // Regression for run 43840236666: the terminating old Pod was listed first.
  const selection = selectReadyPod(list(
    pod('xpod-co-old', { image: OLD_IMAGE, imageID: `docker-pullable://${OLD_IMAGE}`, deleting: true }),
    pod('xpod-co-new', { createdAt: '2026-11-16T10:49:00Z' }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER });
  assert.deepEqual(selection, {
    podName: 'xpod-co-new',
    imageID: `docker-pullable://${TARGET}`,
    serviceContainer: SERVICE_CONTAINER,
    digest: DIGEST,
  });
});

test('excludes a Ready old Pod that runs a different image even without a deletionTimestamp', () => {
  const selection = selectReadyPod(list(
    pod('xpod-co-old', { image: OLD_IMAGE, imageID: `docker-pullable://${OLD_IMAGE}` }),
    pod('xpod-co-new', { createdAt: '2026-11-16T10:49:00Z' }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER });
  assert.equal(selection.podName, 'xpod-co-new');
});

test('fails explicitly when the only target Pod is not Ready', () => {
  assert.throws(() => selectReadyPod(list(
    pod('xpod-co-new', { ready: false }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /no eligible pod.*not Ready/);
});

test('fails explicitly when the Pod is Ready but the service container status is not', () => {
  const notReadyContainer = pod('xpod-co-new');
  notReadyContainer.status.containerStatuses.find(
    (status) => status.name === SERVICE_CONTAINER,
  ).ready = false;
  assert.throws(() => selectReadyPod(list(notReadyContainer),
    { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /service container xpod-co is not Ready/);
});

test('fails explicitly when the target Pod is Pending or its service container status is absent', () => {
  assert.throws(() => selectReadyPod(list(
    pod('xpod-co-pending', { phase: 'Pending' }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /no eligible pod.*phase Pending/);

  const missingStatus = pod('xpod-co-new');
  missingStatus.status.containerStatuses = missingStatus.status.containerStatuses.filter(
    (status) => status.name !== SERVICE_CONTAINER,
  );
  assert.throws(() => selectReadyPod(list(missingStatus),
    { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /has no container status/);
});

test('fails explicitly on the wrong service container or a mismatched actual imageID digest', () => {
  assert.throws(() => selectReadyPod(list(
    pod('xpod-co-new', { container: 'xpod' }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /missing from the pod spec/);

  // Spec still names the target image, but the runtime never pulled that digest.
  assert.throws(() => selectReadyPod(list(
    pod('xpod-co-new', { imageID: `docker-pullable://${OLD_IMAGE}` }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /imageID does not contain/);
});

test('fails explicitly when no Pod is eligible and lists bounded rejection reasons', () => {
  assert.throws(() => selectReadyPod(list(),
    { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /no eligible pod.*empty/);
  assert.throws(() => selectReadyPod(list(
    pod('xpod-co-old', { image: OLD_IMAGE, imageID: `docker-pullable://${OLD_IMAGE}`, deleting: true }),
  ), { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /no eligible pod.*terminating/);
});

test('rejects malformed pod lists, service containers, and target image references', () => {
  assert.throws(() => selectReadyPod({}, { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /malformed pod list/);
  assert.throws(() => selectReadyPod(list(pod('xpod-co-new')),
    { targetImageReference: TARGET, serviceContainer: '' }), /malformed service container/);
  assert.throws(() => targetDigest('ghcr.io/undefinedsco/xpod:0.4.32'), /expected repository@sha256/);
  assert.throws(() => targetDigest('ghcr.io/undefinedsco/xpod@sha256:abc'), /malformed target image digest/);
  assert.throws(() => selectReadyPod(list({ metadata: {} }),
    { targetImageReference: TARGET, serviceContainer: SERVICE_CONTAINER }), /metadata.name/);
});

test('the CLI reads the pod list from stdin and reports the selected Pod', () => {
  const output = execFileSync(process.execPath, [
    helper, '--target-image', TARGET, '--service-container', SERVICE_CONTAINER,
  ], {
    input: JSON.stringify(list(
      pod('xpod-co-old', { image: OLD_IMAGE, imageID: `docker-pullable://${OLD_IMAGE}`, deleting: true }),
      pod('xpod-co-new', { createdAt: '2026-11-16T10:49:00Z' }),
    )),
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(output).podName, 'xpod-co-new');

  const failure = spawnSync(process.execPath, [
    helper, '--target-image', TARGET, '--service-container', SERVICE_CONTAINER,
  ], { input: JSON.stringify(list()), encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /::error::production-deployment-pod: no eligible pod/);
});

test('both deploy jobs use the shared selector and keep every production gate', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.equal((workflow.match(/scripts\/lib\/production-deployment-pod\.cjs/g) ?? []).length, 2);
  assert.equal((workflow.match(/--service-container "\$service_container"/g) ?? []).length, 2);
  assert.equal(workflow.includes('@.status.phase=="Running"'), false);
  assert.equal(workflow.includes('| awk'), false);
  assert.equal((workflow.match(/deployment image does not match requested digest/g) ?? []).length, 2);
  assert.equal((workflow.match(/ready pod imageID does not contain requested digest/g) ?? []).length, 2);
  assert.equal((workflow.match(/exec "\$ready_pod" -c "\$service_container"/g) ?? []).length, 2);
  assert.equal((workflow.match(/scripts\/lib\/production-deployment-pod\.cjs/g) ?? []).length,
    (workflow.match(/Verify production gates/g) ?? []).length);
});
