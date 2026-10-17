import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { inspectPhysicalLegalMaterials } from '../../scripts/lib/independent-admission/legal-material-inventory';
import { registryLegalLockEntries, registryLegalOriginalView, observeRegistryLegalOriginal } from '../../scripts/lib/independent-admission/legal-registry-originals';
import type { CollectedArtifactView } from '../../scripts/lib/independent-admission/artifact-contract';
function fixture(missing = false) {
  const files: Record<string, Buffer> = {
    'node_modules/example/package.json': Buffer.from(JSON.stringify({ name: 'example', version: '1.0.0' })),
    'node_modules/example/index.js': Buffer.from('export const x=1;'),
  };
  if (!missing) files['node_modules/example/LICENSE'] = Buffer.from('original named terms');
  const rows = Object.entries(files).map(([name, bytes]) => ({ path: name.slice('node_modules/example/'.length), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  files['provenance/packages/example.json'] = Buffer.from(JSON.stringify({ name: 'example', version: '1.0.0', path: 'node_modules/example', files: rows }));
  const entry = { name: 'example', version: '1.0.0', placements: ['node_modules/example'], originals: rows.filter(row => row.path === 'LICENSE').map(row => ({ ...row, path: 'node_modules/example/' + row.path })), supplements: [] };
  files['provenance/terms/index.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'original-material-collection', legalClearance: false, entries: [entry], missingNamedOriginalTerms: missing ? [{ name: entry.name, version: entry.version }] : [] }));
  const view = (): CollectedArtifactView => ({ identity: { sourceSha: 'a'.repeat(40) } as any, producerOriginals: [],
    members: Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 })),
    readMember(name, maximum) { if (files[name]!.length > maximum) throw Error('budget'); return Buffer.from(files[name]!); }, readProducerOriginal() { throw Error('unused'); } });
  return { files, view };
}
test('real packed members establish material integrity, never an issuer from approval JSON', () => {
  const f = fixture();
  expect(inspectPhysicalLegalMaterials(f.view(), [{ status: 'verified', name: 'example', version: '1.0.0' }])?.pending).toEqual(['Immutable registry/source issuer required: example@1.0.0']);
  expect(registryLegalOriginalView({ status: 'verified' })).toBeUndefined();
});
test('missing named terms are rederived from physical original files', () => {
  const f = fixture(true);
  expect(inspectPhysicalLegalMaterials(f.view())?.pending).toContain('Original terms missing: example@1.0.0');
  const index = JSON.parse(f.files['provenance/terms/index.json']!.toString()); index.missingNamedOriginalTerms = [];
  f.files['provenance/terms/index.json'] = Buffer.from(JSON.stringify(index));
  expect(() => inspectPhysicalLegalMaterials(f.view())).toThrow('missing original inventory differs');
});
test('unlisted files and changed notice bytes cannot escape physical inventory', () => {
  const f = fixture(); f.files['node_modules/example/hidden.js'] = Buffer.from('hidden');
  expect(() => inspectPhysicalLegalMaterials(f.view())).toThrow('unlisted original package member');
  delete f.files['node_modules/example/hidden.js']; f.files['node_modules/example/LICENSE'] = Buffer.from('changed terms');
  expect(() => inspectPhysicalLegalMaterials(f.view())).toThrow('original package member differs');
});
test('immutable Bun lock SRI is parsed as data with trailing commas and conflicting identities rejected', () => {
  const sri = 'sha512-' + Buffer.alloc(64).toString('base64');
  const bytes = Buffer.from('{"lockfileVersion":1,"packages":{"example":["example@1.0.0","",{},"' + sri + '"],},}');
  expect(registryLegalLockEntries(bytes).get('example@1.0.0')).toBe(sri);
  expect(() => registryLegalLockEntries(Buffer.from('{"lockfileVersion":0,"packages":{}}'))).toThrow('unsupported immutable Bun lock');
  const conflict = { lockfileVersion: 1, packages: { a: ['example@1.0.0', '', {}, sri], b: ['example@1.0.0', '', {}, 'sha512-' + Buffer.alloc(64, 1).toString('base64')] } };
  expect(() => registryLegalLockEntries(Buffer.from(JSON.stringify(conflict)))).toThrow('conflicting lock identities');
});
test('registry observation rejects fabricated capabilities before network access', async () => {
  await expect(observeRegistryLegalOriginal({ artifact: fixture().view(), source: { sourceSha: 'a'.repeat(40) }, name: 'example', version: '1.0.0' })).rejects.toThrow('bound collected archive');
});

test('legacy physical packages without a terms index remain explicitly pending', () => {
  const f = fixture(); delete f.files['provenance/terms/index.json'];
  expect(inspectPhysicalLegalMaterials(f.view())?.pending).toEqual(['Physical package original terms index missing: provenance/terms/index.json']);
});

test('actual official ms@2.1.3 tar fixture binds immutable lock SRI, manifest, and original MIT text without issuing capability', async () => {
  const { readFileSync } = await import('node:fs');
  const { inspectRegistryLegalArchive } = await import('../../scripts/lib/independent-admission/legal-registry-originals');
  const { verifyMitGrantText } = await import('../../scripts/lib/independent-admission/legal-admission');
  const metadata = readFileSync(new URL('../fixtures/legal-originals/ms-2.1.3.metadata.json', import.meta.url));
  const archive = readFileSync(new URL('../fixtures/legal-originals/ms-2.1.3.tgz', import.meta.url));
  const lock = registryLegalLockEntries(readFileSync(new URL('../../bun.lock', import.meta.url)));
  const identity = { name: 'ms', version: '2.1.3', integrity: lock.get('ms@2.1.3')! };
  const original = inspectRegistryLegalArchive(identity, metadata, archive);
  const license = original.entries.find(row => row.path === 'package/license.md');
  const template = readFileSync(new URL('../../packages/xpod-cli/licenses/native/declarations/objects/b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5.txt', import.meta.url));
  expect(verifyMitGrantText(license.content, template)).toBe(true);
  expect(registryLegalOriginalView(original)).toBeUndefined();
  const changed = Buffer.from(archive); changed[20] = changed[20]! ^ 1;
  expect(() => inspectRegistryLegalArchive(identity, metadata, changed)).toThrow('original archive SRI differs');
});

test('legacy archive still rederives each missing original without trusting a missing terms index', () => {
  const f = fixture(true); delete f.files['provenance/terms/index.json'];
  expect(inspectPhysicalLegalMaterials(f.view())?.pending).toContain('Original terms missing: example@1.0.0');
});
