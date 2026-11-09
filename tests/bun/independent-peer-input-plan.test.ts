import { expect, test } from 'bun:test';
import { derivePublicationPeerInputPlan, planPublicationPeerInputs, collectPublicationPeerInputPlan, publicationPeerInputPlanView } from '../../scripts/lib/independent-admission/peer-input-plan';
const sri = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
const row = (name: string, version: string, dependencies = {}) => [name + '@' + version, '', { dependencies }, sri];
const lock = (packages: object) => Buffer.from(JSON.stringify({ lockfileVersion: 2, configVersion: 1, packages }));
test('scoped ancestor resolution retains nested versions and records multiple-version installer requirements', () => {
  const result = derivePublicationPeerInputPlan({ peerDependencies: { '@scope/root': '^1.0.0' } }, {}, lock({
    '@scope/root': row('@scope/root', '1.0.0', { nested: '^1.0.0', leaf: '^1.0.0' }),
    '@scope/root/nested': row('nested', '1.0.0', { leaf: '^2.0.0' }),
    '@scope/root/nested/leaf': row('leaf', '2.0.0'), leaf: row('leaf', '1.0.0'),
  }));
  expect(result.requests.map(value => value.package + '@' + value.version)).toEqual(['@scope/root@1.0.0', 'leaf@1.0.0', 'leaf@2.0.0', 'nested@1.0.0']);
  expect(result.edges.find(edge => edge.from === '@scope/root/nested' && edge.package === 'leaf')?.lockKey).toBe('@scope/root/nested/leaf');
  expect(result.status).toBe('collection-planned');
  expect(result.installerRequirements.multipleVersions).toEqual([{ package: 'leaf', versions: ['1.0.0', '2.0.0'] }]);
  expect(result.placements.find(value => value.lockKey === '@scope/root/nested/leaf')?.path).toBe('node_modules/@scope/root/node_modules/nested/node_modules/leaf');
});
test('unknown specs, missing SRI, and nearer range conflicts never fall back to another version', () => {
  const result = derivePublicationPeerInputPlan({ peerDependencies: { root: '^1.0.0', workspace: 'workspace:*', missing: '^1' } }, {}, lock({
    root: row('root', '1.0.0', { leaf: '^1.0.0', nohash: '^1.0.0' }),
    'root/leaf': row('leaf', '2.0.0'), leaf: row('leaf', '1.0.0'), nohash: ['nohash@1.0.0', '', {}],
  }));
  expect(result.pending.some(value => value.includes('Unknown dependency'))).toBe(true);
  expect(result.pending.some(value => value.includes('Missing locked'))).toBe(true);
  expect(result.pending.some(value => value.includes('version/specification conflict'))).toBe(true);
  expect(result.pending.some(value => value.includes('SHA512'))).toBe(true);
  expect(result.requests.some(value => value.package === 'leaf')).toBe(false);
});
test('CLI/client ranges share one exact locked request and plans grant no admission', () => {
  const result = derivePublicationPeerInputPlan({ peerDependencies: { peer: '^3.1.0' } }, { peerDependencies: { peer: '^3.1.1' } }, lock({ peer: row('peer', '3.1.1') }));
  expect(result.status).toBe('collection-planned');
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]?.registry).toBe('https://registry.npmjs.org/');
  expect(result.consumerVerified || result.sourceVerified || result.legalVerified).toBe(false);
  expect(() => planPublicationPeerInputs({ cli: {}, client: {}, source: {} })).toThrow('real collected');
});

test('workspace peer scope is checked before a globally hoisted package', () => {
  const result = derivePublicationPeerInputPlan({ peerDependencies: { peer: '^2.0.0' } }, {}, lock({
    '@undefineds.co/xpod-cli/peer': row('peer', '2.0.0'), peer: row('peer', '1.0.0'),
  }));
  expect(result.status).toBe('collection-planned');
  expect(result.edges[0]?.lockKey).toBe('@undefineds.co/xpod-cli/peer');
  expect(result.requests[0]?.version).toBe('2.0.0');
});

test('same exact identity with conflicting SRI is rejected instead of selected', () => {
  const conflicting = row('leaf', '1.0.0'); conflicting[3] = 'sha512-' + Buffer.alloc(64, 2).toString('base64');
  expect(() => derivePublicationPeerInputPlan({ peerDependencies: { root: '^1', leaf: '^1' } }, {}, lock({
    root: row('root', '1.0.0', { leaf: '^1' }), leaf: row('leaf', '1.0.0'), 'root/leaf': conflicting,
  }))).toThrow('Conflicting locked integrity');
});
test('serialized reports cannot become source-backed opaque peer plans', () => {
  expect(publicationPeerInputPlanView({ status: 'collection-planned', requests: [] })).toBeUndefined();
  expect(() => collectPublicationPeerInputPlan({ cli: {}, client: {}, source: {} })).toThrow('real collected');
});
