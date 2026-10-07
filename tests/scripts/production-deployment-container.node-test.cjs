const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { parse } = require('yaml');
const {
  parseImageRepository,
  selectServiceContainer,
} = require('../../scripts/lib/production-deployment-container.cjs');

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'scripts/lib/production-deployment-container.cjs');
const TARGET = `ghcr.io/undefinedsco/xpod@sha256:${'a'.repeat(64)}`;

function overlay(env) {
  return parse(fs.readFileSync(path.join(root, 'deploy/sealos/cloud/overlays', env, 'deployment.yaml'), 'utf8'));
}

test('selects the co service container from the deployed manifest, not a fixed xpod name', () => {
  const deployment = overlay('co');
  assert.equal(deployment.spec.template.spec.containers[0].name, 'xpod-co');
  // Regression for run 37425732672: a fixed `xpod` selector matches no co container.
  assert.equal(deployment.spec.template.spec.containers.some((c) => c.name === 'xpod'), false);
  const selection = selectServiceContainer(deployment, TARGET);
  assert.equal(selection.serviceContainer, 'xpod-co');
  assert.equal(selection.previousImage, deployment.spec.template.spec.containers[0].image);
});

test('selects the cn service container and ignores init containers', () => {
  const deployment = overlay('cn');
  assert.equal(deployment.spec.template.spec.containers[0].name, 'xpod');
  assert.equal(deployment.spec.template.spec.initContainers[0].name, 'prepare-storage');
  const selection = selectServiceContainer(deployment, TARGET);
  assert.equal(selection.serviceContainer, 'xpod');
  assert.equal(selection.previousImage, deployment.spec.template.spec.containers[0].image);
});

test('allows regular sidecars and matches the image repository across tag and digest forms', () => {
  const deployment = {
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'sidecar', image: 'ghcr.io/undefinedsco/inngest:1.2.3' },
            { name: 'xpod-co', image: 'ghcr.io/undefinedsco/xpod:0.4.27' },
          ],
        },
      },
    },
  };
  const selection = selectServiceContainer(deployment, TARGET);
  assert.equal(selection.serviceContainer, 'xpod-co');
  assert.equal(selection.previousImage, 'ghcr.io/undefinedsco/xpod:0.4.27');
});

test('fails explicitly when no container uses the target image repository', () => {
  const deployment = {
    spec: { template: { spec: { containers: [ { name: 'sidecar', image: 'alpine:3.20' } ] } } },
  };
  assert.throws(() => selectServiceContainer(deployment, TARGET), /missing/);
});

test('fails explicitly when multiple containers share the target image repository', () => {
  const deployment = {
    spec: {
      template: {
        spec: {
          containers: [
            { name: 'xpod-co', image: 'ghcr.io/undefinedsco/xpod:0.4.27' },
            { name: 'xpod-shadow', image: TARGET },
          ],
        },
      },
    },
  };
  assert.throws(() => selectServiceContainer(deployment, TARGET), /ambiguous/);
});

test('fails explicitly on malformed deployments and image references', () => {
  assert.throws(() => selectServiceContainer({}, TARGET), /malformed/);
  assert.throws(() => selectServiceContainer({ spec: { template: { spec: { containers: [] } } } }, TARGET), /malformed/);
  assert.throws(
    () => selectServiceContainer({ spec: { template: { spec: { containers: [ { name: 'xpod', image: '' } ] } } } }, TARGET),
    /malformed/,
  );
  assert.throws(() => parseImageRepository(''), /malformed/);
  assert.throws(() => parseImageRepository(42), /malformed/);
});

test('derives the repository from digest, tag, plain, and port-qualified references', () => {
  assert.equal(parseImageRepository(TARGET), 'ghcr.io/undefinedsco/xpod');
  assert.equal(parseImageRepository('ghcr.io/undefinedsco/xpod:0.4.27'), 'ghcr.io/undefinedsco/xpod');
  assert.equal(parseImageRepository('ghcr.io/undefinedsco/xpod'), 'ghcr.io/undefinedsco/xpod');
  assert.equal(parseImageRepository('localhost:5000/xpod@sha256:abc'), 'localhost:5000/xpod');
});

test('the CLI reads the deployment JSON from stdin and reports the selected container', () => {
  const output = execFileSync(process.execPath, [ helper, '--target-image', TARGET ], {
    input: JSON.stringify(overlay('co')),
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), {
    serviceContainer: 'xpod-co',
    previousImage: overlay('co').spec.template.spec.containers[0].image,
    repository: 'ghcr.io/undefinedsco/xpod',
  });
});

test('the deploy workflow references the helper and never hardcodes the xpod container name', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /scripts\/lib\/production-deployment-container\.cjs/);
  assert.ok(workflow.includes('--target-image "$TARGET_IMAGE"'));
  assert.equal(workflow.includes('containers[?(@.name=="xpod")]'), false);
});
