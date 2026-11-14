import { expect, test } from 'bun:test';
import { readLegalProductManifest } from '../../scripts/lib/independent-admission/legal-product-manifest';
import type { CollectedArtifactView } from '../../scripts/lib/independent-admission/artifact-contract';
function fixture(text: string) {
  const bytes = Buffer.from(text); let largest = 0;
  const artifact = { members: [{ path: 'package.json', bytes: bytes.length }], readMember() { throw Error('whole reads forbidden'); }, readMemberRange(_name: string, offset: number, length: number) { largest = Math.max(largest, length); if (length > 65536) throw Error('range'); return bytes.subarray(offset, offset + length); } } as unknown as CollectedArtifactView;
  return { artifact, largest: () => largest };
}
test('manifest identity range projection discards embedded provenance without whole reads', () => {
  const f = fixture(JSON.stringify({ name: '@undefineds.co/xpod-css', version: '0.1.0', xpodModule: { id: 'css', provenance: { files: Array.from({ length: 5000 }, (_, i) => ({ path: 'node_modules/file-' + i, sha256: 'a'.repeat(64) })) } } }));
  expect(readLegalProductManifest(f.artifact)).toEqual({ name: '@undefineds.co/xpod-css', version: '0.1.0', xpodModule: { id: 'css' } });
  expect(f.largest()).toBe(65536);
  expect(readLegalProductManifest(fixture('{"name":"a","version":"1","xpodModule/id":"css"}').artifact)).toEqual({ name: 'a', version: '1' });
});
test('duplicate identities, truncation and oversized string tokens cannot be hidden in provenance', () => {
  expect(() => readLegalProductManifest(fixture('{"name":"a","name":"b","version":"1"}').artifact)).toThrow('duplicate');
  expect(() => readLegalProductManifest(fixture('{"name":"a","version":"1"').artifact)).toThrow('incomplete');
  expect(() => readLegalProductManifest(fixture(JSON.stringify({ name: 'a', version: '1', description: 'x'.repeat(65537) })).artifact)).toThrow('token');
});
