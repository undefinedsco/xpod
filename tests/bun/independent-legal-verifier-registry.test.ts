import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { measureRegistryArchiveExpansion, observeVerifierRegistryOriginal, registryLegalOriginalView,
  REGISTRY_LEGAL_ORIGINAL_LIMITS, VERIFIER_REGISTRY_ORIGINAL_PACKAGES } from '../../scripts/lib/independent-admission/legal-registry-originals';

test('complete official fixture gzip expansion is charged, including tar headers and padding', async () => {
  const archive = readFileSync(new URL('../fixtures/legal-originals/ms-2.1.3.tgz', import.meta.url));
  const actual = await measureRegistryArchiveExpansion(archive, 32 * 1024 ** 2, AbortSignal.timeout(1000));
  expect(actual).toBe(gunzipSync(archive).length);
  await expect(measureRegistryArchiveExpansion(archive, actual - 1, AbortSignal.timeout(1000))).rejects.toThrow('expanded byte budget');
  expect(registryLegalOriginalView({ expandedBytes: actual, archive })).toBeUndefined();
});
test('concatenated gzip members cannot undercharge the group using only the final ISIZE footer', async () => {
  const archive = Buffer.concat([gzipSync(Buffer.alloc(4096, 1)), gzipSync(Buffer.alloc(1024, 2))]);
  expect(await measureRegistryArchiveExpansion(archive, 5120, AbortSignal.timeout(1000))).toBe(5120);
  await expect(measureRegistryArchiveExpansion(archive, 4096, AbortSignal.timeout(1000))).rejects.toThrow('expanded byte budget');
  const abort = new AbortController(); abort.abort();
  await expect(measureRegistryArchiveExpansion(archive, 5120, abort.signal)).rejects.toThrow('bounded expansion');
});
test('verifier original acquisition accepts no structural immutable-source stand-in', async () => {
  let callbackCalls = 0;
  const fake = { sourceSha: 'a'.repeat(40), trackedPaths: ['bun.lock'], readTracked() { callbackCalls++; return Buffer.from('{}'); } };
  for (const name of VERIFIER_REGISTRY_ORIGINAL_PACKAGES) {
    await expect(observeVerifierRegistryOriginal({ source: fake, name, version: '1.0.0' })).rejects.toThrow('private immutable Git source');
  }
  await expect(observeVerifierRegistryOriginal({ source: fake, name: 'ms', version: '2.1.3' })).rejects.toThrow('fixed six-package');
  await expect(observeVerifierRegistryOriginal({ source: fake, name: 'jose', version: 'latest' })).rejects.toThrow('exact verifier registry version');
  expect(callbackCalls).toBe(0);
  expect(VERIFIER_REGISTRY_ORIGINAL_PACKAGES.length).toBe(6);
  expect(REGISTRY_LEGAL_ORIGINAL_LIMITS.groupAttempts).toBe(16);
  expect(REGISTRY_LEGAL_ORIGINAL_LIMITS.groupExpandedBytes).toBe(128 * 1024 ** 2);
  expect(REGISTRY_LEGAL_ORIGINAL_LIMITS.groupTimeoutMs).toBe(120000);
});
