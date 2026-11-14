import { expect, test } from 'bun:test';
import { collectedProductOriginal, collectedProductOriginalBinding } from '../../scripts/lib/independent-admission/product-original';
test('JSON member readers cannot become same-fd collector originals', () => {
  const reference = { path: 'native/large', sizeBytes: 33 * 1024 ** 2, sha256: 'a'.repeat(64) };
  const forged = { reference, readRange: () => Buffer.alloc(0) };
  expect(collectedProductOriginalBinding(forged)).toBeUndefined();
  expect(() => collectedProductOriginal({ members: [{ path: reference.path, bytes: reference.sizeBytes, sha256: reference.sha256 }] }, reference)).toThrow('real collected');
  expect(collectedProductOriginalBinding({})).toBeUndefined();
});
