/** Resource planning only. These numbers never grant an admission capability. */
export const PUBLICATION_DISK_LIMITS = Object.freeze({
  productPackedBytes: 768 * 1024 ** 2,
  outerExpandedBytes: 6 * 1024 ** 3,
  outerPackedBytes: 6 * 1024 ** 3 + 32 * 1024 ** 2,
  sourceCacheBytes: 512 * 1024 ** 2,
  nativeCacheBytes: 512 * 1024 ** 2,
  metadataCacheBytes: 16 * 1024 ** 2,
  freeFloorBytes: 2 * 1024 ** 3,
});
export interface PublicationDiskReservation {
  /** Actual immutable GitHub artifact sizes, deduplicated by acquisition tuple. */
  acquisitionBytes: readonly number[];
  /** Only product archives actually retained during this operation. */
  retainedProductBytes: readonly number[];
  /** The largest current product projection, not every cohort projection. */
  activeProductProjectionBytes: number;
  /** Native originals retained independently of the product acquisition. */
  retainedNativeOriginalBytes: readonly number[];
  freeBytes: number;
}
export function preflightPublicationDisk(input: PublicationDiskReservation): Readonly<{
  status: 'resource-ready' | 'pending'; requiredBytes: number; pending: readonly string[];
}> {
  const checked = (value: number): number => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('disk reservation requires actual nonnegative safe byte counts');
    return value;
  };
  const sum = (values: readonly number[]) => values.reduce((total, value) => checked(total + checked(value)), 0);
  checked(input.freeBytes);
  const requiredBytes = checked(sum(input.acquisitionBytes) + sum(input.retainedProductBytes)
    + checked(input.activeProductProjectionBytes) + sum(input.retainedNativeOriginalBytes)
    + PUBLICATION_DISK_LIMITS.sourceCacheBytes + PUBLICATION_DISK_LIMITS.nativeCacheBytes
    + PUBLICATION_DISK_LIMITS.metadataCacheBytes + PUBLICATION_DISK_LIMITS.freeFloorBytes);
  const pending = input.freeBytes < requiredBytes
    ? [`publication-disk-insufficient: free=${input.freeBytes} required=${requiredBytes}`] : [];
  return Object.freeze({ status: pending.length ? 'pending' : 'resource-ready', requiredBytes, pending: Object.freeze(pending) });
}
