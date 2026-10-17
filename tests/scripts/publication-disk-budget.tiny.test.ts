import { expect, test } from 'bun:test';
import { preflightPublicationDisk, PUBLICATION_DISK_LIMITS } from '../../scripts/lib/independent-admission/publication-disk-budget';

test('reservation accounts for the actual simultaneously retained layers and floor', () => {
  const input = { acquisitionBytes: [466158368], retainedProductBytes: [467908110],
    activeProductProjectionBytes: 1024, retainedNativeOriginalBytes: [26752739], freeBytes: 0 };
  const absent = preflightPublicationDisk(input);
  expect(absent.status).toBe('pending');
  expect(absent.requiredBytes).toBe(466158368 + 467908110 + 1024 + 26752739
    + PUBLICATION_DISK_LIMITS.sourceCacheBytes + PUBLICATION_DISK_LIMITS.nativeCacheBytes
    + 2*PUBLICATION_DISK_LIMITS.metadataCacheBytes + PUBLICATION_DISK_LIMITS.freeFloorBytes);
  expect(preflightPublicationDisk({ ...input, freeBytes: absent.requiredBytes }).status).toBe('resource-ready');
  expect(preflightPublicationDisk({ ...input, freeBytes: absent.requiredBytes - 1 }).status).toBe('pending');
  expect(Object.isFrozen(absent.pending)).toBe(true);
});

test('unknown, negative and overflowing sizes cannot stand in for an observed size', () => {
  const input = { acquisitionBytes: [], retainedProductBytes: [], activeProductProjectionBytes: 0,
    retainedNativeOriginalBytes: [], freeBytes: 0 };
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => preflightPublicationDisk({ ...input, acquisitionBytes: [value] })).toThrow();
  }
  expect(() => preflightPublicationDisk({ ...input, acquisitionBytes: [Number.MAX_SAFE_INTEGER, 1] })).toThrow();
});
