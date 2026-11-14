import { describe, expect, test } from 'bun:test';
import { planIndependentPublication } from '../../scripts/lib/independent-admission/publication';

describe('independent publication boundaries', () => {
  test('serialized passed records do not issue artifact or publication authority', () => {
    const fake = { identity: { package: '@undefineds.co/xpod-client', version: '1.0.0' }, status: 'verified', sourceQualified: true, registryConsumer: 'passed' };
    expect(() => planIndependentPublication({ client: fake, cli: fake, clientSource: fake, cliSource: fake })).toThrow('real central');
    expect(() => planIndependentPublication({ client: {}, cli: {}, clientSource: {}, cliSource: {} })).toThrow('real central');
  });
});

import { validatePublicationCohort, normalizePublicationInput, readPublicationManifest } from '../../scripts/lib/independent-admission/publication';
import type { PublicationProductDescriptor } from '../../scripts/lib/independent-admission/publication';
import { MODULE_TARGETS, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';

function portable(name: string, version = '1.0.0', source = 'a'.repeat(40), dependencies = {}): PublicationProductDescriptor {
  return { identity: { package: name, version, sourceSha: source, archiveBytes: 1, archiveSha256: 'b'.repeat(64), integrity: 'sha512-fixture' },
    manifest: { name, version, dependencies } };
}
function family(id: 'api' | 'css' | 'afs', version = '1.0.0-rc.1', source = 'a'.repeat(40)) {
  return MODULE_TARGETS.map(target => {
    const row = portable(modulePackageName(id, target.platform, target.arch)!, version, source);
    return { identity: { ...row.identity, target: `${target.platform}-${target.arch}` },
      manifest: { ...row.manifest, xpodModule: { id, ...target } } };
  });
}

test('complete family coverage is derived from actual manifest targets and canonical catalog', () => {
  for (const id of ['api', 'css', 'afs'] as const) {
    const rows = family(id); const result = validatePublicationCohort(rows);
    expect(result.mutationAllowed).toBe(false);
    expect(result.groups).toEqual([{ family: id, version: '1.0.0-rc.1', sourceSha: 'a'.repeat(40), channel: 'next',
      targets: MODULE_TARGETS.map(target => `${target.platform}-${target.arch}`).sort() }]);
    expect(() => validatePublicationCohort(rows.slice(0, -1))).toThrow('every canonical target');
    expect(() => validatePublicationCohort([...rows, rows[0]])).toThrow('duplicate');
    const wrongVersion = rows.map((row, i) => i ? row : { identity: { ...row.identity, version: '2.0.0' }, manifest: { ...row.manifest, version: '2.0.0' } });
    expect(() => validatePublicationCohort(wrongVersion)).toThrow('share exact version and source');
    const wrongSource = rows.map((row, i) => i ? row : { ...row, identity: { ...row.identity, sourceSha: 'c'.repeat(40) } });
    expect(() => validatePublicationCohort(wrongSource)).toThrow('share exact version and source');
    const wrongTarget = rows.map((row, i) => i ? row : { ...row, manifest: { ...row.manifest, xpodModule: { id, platform: 'linux', arch: 'wrong' } } });
    expect(() => validatePublicationCohort(wrongTarget)).toThrow('manifest/target mismatch');
  }
});

test('exact manifest dependencies derive deterministic DAG while independent portable source versions remain valid', () => {
  const client = portable('@undefineds.co/xpod-client', '1.2.3', 'a'.repeat(40));
  const cli = portable('@undefineds.co/xpod-cli', '2.0.0', 'c'.repeat(40), { '@undefineds.co/xpod-client': '1.2.3' });
  const products = [...family('api').map(row => ({ ...row, manifest: { ...row.manifest, dependencies: { '@undefineds.co/xpod-cli': '2.0.0' } } })), cli, client];
  const plan = validatePublicationCohort(products);
  expect(plan.order.slice(0, 2)).toEqual([client.identity.package, cli.identity.package]);
  expect(validatePublicationCohort([...products].reverse()).order).toEqual(plan.order);
  expect(() => validatePublicationCohort([cli])).toThrow('missing or incompatible exact dependency');
  expect(() => validatePublicationCohort([client, { ...cli, manifest: { ...cli.manifest, dependencies: { '@undefineds.co/xpod-client': '^1.2.3' } } }])).toThrow('exact dependency');
  const cycle = { ...client, manifest: { ...client.manifest, dependencies: { '@undefineds.co/xpod-cli': '2.0.0' } } };
  expect(() => validatePublicationCohort([cycle, cli])).toThrow('dependency cycle');
  expect(validatePublicationCohort([cli], [client]).order).toEqual([cli.identity.package]);
});

test('manifest optional dependencies and required peers participate without inventing third party publisher nodes', () => {
  const client = portable('@undefineds.co/xpod-client');
  const cli = portable('@undefineds.co/xpod-cli', '1.0.0', 'a'.repeat(40), { '@undefineds.co/xpod-client': '1.0.0', semver: '^7.0.0' });
  const peer = { ...cli, manifest: { ...cli.manifest, peerDependencies: { '@undefineds.co/unknown': '1.0.0' } } };
  expect(() => validatePublicationCohort([client, peer])).toThrow('missing or incompatible');
  expect(validatePublicationCohort([client, { ...peer, manifest: { ...peer.manifest, peerDependenciesMeta: { '@undefineds.co/unknown': { optional: true } } } }]).order).toHaveLength(2);
  expect(() => validatePublicationCohort([client, { ...cli, manifest: { ...cli.manifest, optionalDependencies: { '@undefineds.co/unknown': '1.0.0' } } }])).toThrow('missing or incompatible');
});

test('metadata success never accepts JSON as central product/source/registry capability', () => {
  const fake: any = portable('@undefineds.co/xpod-client');
  expect(validatePublicationCohort([fake]).mutationAllowed).toBe(false);
  expect(() => normalizePublicationInput({ schemaVersion: 2, products: [{ artifact: fake, source: fake }] })).toThrow('real central');
  expect(() => planIndependentPublication({ schemaVersion: 2, products: [{ artifact: fake, source: fake, prepublishConsumer: { passed: true } as any }] })).toThrow('real central');
  expect(() => normalizePublicationInput({ schemaVersion: 2, products: [] })).toThrow('cohort size');
});


test('CSS-sized real inventory manifest uses the central archive reader limit without issuing authority', () => {
  const { MANIFEST_MAX_BYTES } = require('../../scripts/workspace-package-payload.cjs');
  // Large xpodModule inventories are real product data, not an oversized description string.
  const files = Array.from({ length: 45000 }, (_, index) => ({
    path: `runtime/node_modules/fixture-module-${index}/dist/retained-original-resource-file.js`,
    sha256: 'b'.repeat(64), size: index, mode: 420,
  }));
  const bytes = Buffer.from(JSON.stringify({ name: '@undefineds.co/xpod-css-linux-x64', version: '1.0.0',
    xpodModule: { id: 'css', platform: 'linux', arch: 'x64', files } }));
  expect(bytes.length > 8 * 1024 ** 2).toBe(true);
  expect(bytes.length < MANIFEST_MAX_BYTES).toBe(true);
  const manifest = readPublicationManifest({ readMember(member, maximumBytes) {
    expect(member).toBe('package.json');
    expect(maximumBytes).toBe(MANIFEST_MAX_BYTES);
    if (bytes.length > maximumBytes) throw Error('member exceeds budget');
    return bytes;
  } });
  expect(manifest.xpodModule.files).toHaveLength(45000);
  expect(manifest.xpodModule.files[44999].path).toBe(files[44999].path);
  expect(manifest.name).toBe('@undefineds.co/xpod-css-linux-x64');
  expect(() => readPublicationManifest({ readMember: () => Buffer.from('[]') })).toThrow('manifest object');
  expect(() => normalizePublicationInput({ schemaVersion: 2, products: [{ artifact: manifest as any, source: manifest as any }] })).toThrow('real central');
});


test('fixed public CLI consumer prerequisites precede platform products even without manifest CLI dependencies', () => {
  const client = portable('@undefineds.co/xpod-client');
  const cli = portable('@undefineds.co/xpod-cli', '1.0.0', 'a'.repeat(40), { '@undefineds.co/xpod-client': '1.0.0' });
  const platforms = family('afs');
  const edges = new Map(platforms.map(row => [row.identity.package, [cli.identity.package, client.identity.package]]));
  const cohort = validatePublicationCohort([...platforms, cli, client], [], edges);
  expect(cohort.order.slice(0, 2)).toEqual([client.identity.package, cli.identity.package]);
  for (const row of platforms) expect(cohort.dependencies[row.identity.package]).toEqual([client.identity.package, cli.identity.package].sort());
  edges.clear();
  expect(cohort.dependencies[platforms[0].identity.package]).toHaveLength(2);
  expect(Object.isFrozen(cohort.dependencies[platforms[0].identity.package])).toBe(true);
  const cycle = { ...client, manifest: { ...client.manifest, dependencies: { [platforms[0].identity.package]: platforms[0].identity.version } } };
  expect(() => validatePublicationCohort([...platforms, cli, cycle], [], new Map(platforms.map(row => [row.identity.package, [cli.identity.package]]))))
    .toThrow('dependency cycle');
  expect(() => validatePublicationCohort(platforms, [], new Map(platforms.map(row => [row.identity.package, [cli.identity.package]]))))
    .toThrow('not in cohort or admitted registry');
  expect(validatePublicationCohort(platforms, [client, cli], new Map(platforms.map(row => [row.identity.package, [cli.identity.package, client.identity.package]]))).order)
    .toHaveLength(4);
});
