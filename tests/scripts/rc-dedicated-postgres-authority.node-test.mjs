/**
 * Registry pull-authority selection for the immutable PG17 images.
 *
 * The REAL scripts/select-pg-registry-authority.ts is imported as an ES module
 * (Node 22 strips types) and driven with synthetic workload objects. The
 * workload is a credential source only; it must match one of the two digests
 * the workflow declares, never a live or arbitrary image.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { repoRoot, syntheticDigest } from './rc-dedicated-postgres-fixture.mjs';

const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts/select-pg-registry-authority.ts')).href;
const { selectPgRegistryAuthority, parseAuthorityDeclarations } = await import(moduleUrl);

const CURRENT = syntheticDigest('1');
const TARGET = syntheticDigest('2');
const declarations = parseAuthorityDeclarations(CURRENT, TARGET);

const workload = (image, { secrets = [{ name: 'tcr-creds' }], kind = 'StatefulSet',
  containers = null } = {}) => ({
  kind,
  spec: { template: { spec: {
    containers: containers ?? [{ name: 'postgres', image }],
    imagePullSecrets: secrets,
  } } },
});

test('the declared current and target digests must be distinct immutable references', () => {
  assert.throws(() => parseAuthorityDeclarations(CURRENT, CURRENT), /must be distinct/);
  assert.throws(() => parseAuthorityDeclarations('pkg:latest', TARGET), /immutable sha256/);
  assert.throws(() => parseAuthorityDeclarations(CURRENT, `${TARGET} `), /immutable sha256/);
  assert.throws(() => parseAuthorityDeclarations(CURRENT, 'sha256:' + 'a'.repeat(64)), /immutable sha256/);
});

test('the workload authorises its own imagePullSecret (credential source, not target)', () => {
  const result = selectPgRegistryAuthority(workload(CURRENT), declarations);
  assert.equal(result.secretName, 'tcr-creds');
  assert.equal(result.role, 'current');
  assert.equal(result.authorisedImage, CURRENT);

  // After promotion the same workload legitimately runs the former target.
  assert.equal(selectPgRegistryAuthority(workload(TARGET), declarations).role, 'target');
});

test('an unbound third digest is rejected', () => {
  assert.throws(() => selectPgRegistryAuthority(workload(syntheticDigest('9')), declarations),
    /not one of the declared current\/target digests/);
});

test('wildcard, latest, untagged and bare-sha forms are rejected', () => {
  for (const bad of [ '*', `${CURRENT.split('@')[0]}:latest`, CURRENT.split('@')[0],
    'sha256:' + 'a'.repeat(64) ]) {
    assert.throws(() => selectPgRegistryAuthority(workload(bad), declarations),
      /immutable digest reference/, bad);
  }
});

test('zero, multiple or invalid pull secrets are rejected', () => {
  for (const secrets of [ [], [ { name: 'a' }, { name: 'b' } ], [ { name: 'Bad_Name' } ],
    [ { name: '' } ] ]) {
    assert.throws(() => selectPgRegistryAuthority(workload(CURRENT, { secrets }), declarations),
      /exactly one valid imagePullSecret/);
  }
});

test('non-workload kinds and multi-container pods are rejected', () => {
  assert.throws(() => selectPgRegistryAuthority(workload(CURRENT, { kind: 'Pod' }), declarations),
    /StatefulSet or Deployment/);
  assert.throws(() => selectPgRegistryAuthority(workload(CURRENT, {
    containers: [ { name: 'postgres', image: CURRENT }, { name: 'sidecar', image: CURRENT } ],
  }), declarations), /exactly one container/);
  assert.throws(() => selectPgRegistryAuthority({}, declarations), /missing kind/);
  // A Deployment is a valid authority workload shape.
  assert.doesNotThrow(() => selectPgRegistryAuthority(workload(CURRENT, { kind: 'Deployment' }), declarations));
});
