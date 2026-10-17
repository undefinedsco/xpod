import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { inspectBundleLegalMaterials } from '../../scripts/lib/independent-admission/legal-bundle-materials';
import type { CollectedArtifactView } from '../../scripts/lib/independent-admission/artifact-contract';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const prefix = Buffer.alloc(70000, 32), output = Buffer.concat([prefix, Buffer.from('export const x=1;')]);
  const index = { schemaVersion: 1, cliSha256: hash(output), inputs: [{ path: 'src/index.ts', sha256: hash(Buffer.from('const x=1;')), bytes: 10, bytesInOutput: 1 }], packages: [],
    generated: { prefixBytes: prefix.length, prefixSha256: hash(prefix), files: [{ sourcePath: 'generated-prefix.js', object: 'objects/' + hash(prefix) + '.txt', sha256: hash(prefix) }] } };
  const files: Record<string, Buffer> = { 'dist/main.cjs': output, ['dist/licenses/objects/' + hash(prefix) + '.txt']: prefix, 'dist/licenses/index.json': Buffer.from(JSON.stringify(index)) };
  const ranges: number[] = [];
  const view = (): CollectedArtifactView => ({ identity: { sourceSha: 'a'.repeat(40) } as any, producerOriginals: [],
    members: Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes), mode: 0o644 })),
    readMember(name, maximum) { if (files[name]!.length > maximum) throw Error('budget'); return Buffer.from(files[name]!); },
    readMemberRange(name, offset, length) { ranges.push(length); return Buffer.from(files[name]!.subarray(offset, offset + length)); },
    readProducerOriginal() { throw Error('unused'); } });
  return { files, view, ranges, index };
}
test('actual generated prefix and retained object verified with reads of at most 64KiB', () => {
  const f = fixture(), result = inspectBundleLegalMaterials(f.view());
  expect(result.indices).toBe(1); expect(Math.max(...f.ranges)).toBe(65536);
  expect(result.pending).toContain('Observed complete bundle input graph and scoped grant coverage required: dist/main.cjs');
});
test('changed output prefix and retained object fail independently', () => {
  const f = fixture(); f.files['dist/main.cjs']![0] = 42; f.index.cliSha256 = hash(f.files['dist/main.cjs']!);
  f.files['dist/licenses/index.json'] = Buffer.from(JSON.stringify(f.index));
  expect(() => inspectBundleLegalMaterials(f.view())).toThrow('actual generated bundle prefix differs');
  const g = fixture(); const object = Object.keys(g.files).find(name => name.includes('/objects/'))!; g.files[object] = Buffer.from('changed original');
  expect(() => inspectBundleLegalMaterials(g.view())).toThrow('retained original object differs');
});
test('caller graph approval does not confer complete graph authority', () => {
  const f = fixture(); Object.assign(f.index, { legalClearance: true, graphComplete: true }); f.files['dist/licenses/index.json'] = Buffer.from(JSON.stringify(f.index));
  expect(inspectBundleLegalMaterials(f.view()).pending.length > 0).toBe(true);
});

test('an actually empty generated prefix retains its empty original without claiming Bun code was shipped', () => {
  const f = fixture();
  const empty = Buffer.alloc(0), digest = hash(empty), object = 'dist/licenses/objects/' + digest + '.txt';
  f.index.generated = { prefixBytes: 0, prefixSha256: digest, files: [{ sourcePath: 'generated-prefix.js', object: 'objects/' + digest + '.txt', sha256: digest }] };
  f.files[object] = empty; f.files['dist/licenses/index.json'] = Buffer.from(JSON.stringify(f.index));
  const result = inspectBundleLegalMaterials(f.view());
  expect(result.pending).toEqual(['Observed complete bundle input graph and scoped grant coverage required: dist/main.cjs']);
});
