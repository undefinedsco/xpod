const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownsRcDeployment, ownsRcPostgres } = require('../../scripts/rc-cleanup-ownership.cjs');
test('cleanup requires this run seed volume on the exact RC deployment and namespace', () => {
  const seed = 'xpod-rc-seed-123-1';
  const owned = { metadata: { name: 'xpod-rc', namespace: 'test-namespace' },
    spec: { template: { spec: { volumes: [{ name: 'acceptance-seed', secret: { secretName: seed } }] } } } };
  assert.equal(ownsRcDeployment(owned, 'test-namespace', seed), true);
  assert.equal(ownsRcDeployment(owned, 'test-namespace', 'xpod-rc-seed-124-1'), false);
  assert.equal(ownsRcDeployment(owned, 'another-namespace', seed), false);
  assert.equal(ownsRcDeployment({ ...owned, metadata: { ...owned.metadata, name: 'xpod-cloud' } }, 'test-namespace', seed), false);
  assert.equal(ownsRcDeployment({ ...owned, spec: {} }, 'test-namespace', seed), false);
  assert.equal(ownsRcDeployment(null, 'test-namespace', seed), false);
});

test('partial deployment cleanup independently requires this run marker on the RC Postgres', () => {
  const seed = 'xpod-rc-seed-123-1';
  const owned = { metadata: { name: 'xpod-rc-postgres', namespace: 'test-namespace',
    annotations: { 'xpod.undefineds.co/rc-owner-seed': seed } } };
  assert.equal(ownsRcPostgres(owned, 'test-namespace', seed), true);
  assert.equal(ownsRcPostgres(owned, 'test-namespace', 'xpod-rc-seed-124-1'), false);
  assert.equal(ownsRcPostgres(owned, 'other-namespace', seed), false);
  assert.equal(ownsRcPostgres({ ...owned, metadata: { ...owned.metadata, name: 'production-postgres' } }, 'test-namespace', seed), false);
  assert.equal(ownsRcPostgres({ metadata: { name: 'xpod-rc-postgres', namespace: 'test-namespace' } }, 'test-namespace', seed), false);
  assert.equal(ownsRcPostgres(null, 'test-namespace', seed), false);
});

test('a re-run attempt owns the RC its own run deployed, never another run', () => {
  const { runSeedOfRcDeployment } = require('../../scripts/rc-cleanup-ownership.cjs');
  const deployment = { metadata: { name: 'xpod-rc', namespace: 'ns' },
    spec: { template: { spec: { volumes: [{ secret: { secretName: 'xpod-rc-seed-123-1' } }] } } } };
  assert.equal(runSeedOfRcDeployment(deployment, 'ns', '123'), 'xpod-rc-seed-123-1');
  assert.equal(runSeedOfRcDeployment(deployment, 'ns', '12'), undefined);
  assert.equal(runSeedOfRcDeployment(deployment, 'other', '123'), undefined);
  assert.equal(runSeedOfRcDeployment(deployment, 'ns', '1.*'), undefined);
});

test('only an RC whose retained marker names its own mounted seed counts as retained', () => {
  const { retainedRcSeed, RETAINED_ANNOTATION } = require('../../scripts/rc-cleanup-ownership.cjs');
  const deployment = seed => ({ metadata: { name: 'xpod-rc', namespace: 'ns', annotations: { [RETAINED_ANNOTATION]: 'xpod-rc-seed-123-1' } },
    spec: { template: { spec: { volumes: [{ secret: { secretName: seed } }] } } } });
  assert.equal(retainedRcSeed(deployment('xpod-rc-seed-123-1'), 'ns'), 'xpod-rc-seed-123-1');
  // A later candidate re-applied the RC: the stale marker no longer matches.
  assert.equal(retainedRcSeed(deployment('xpod-rc-seed-124-1'), 'ns'), undefined);
  assert.equal(retainedRcSeed({ ...deployment('xpod-rc-seed-123-1'), metadata: { name: 'xpod-rc', namespace: 'ns' } }, 'ns'), undefined);
  assert.equal(retainedRcSeed(null, 'ns'), undefined);
});
