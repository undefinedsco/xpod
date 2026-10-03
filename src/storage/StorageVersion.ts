import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HH, RepresentationMetadata, type ResourceIdentifier } from '@solid/community-server';
import { DataFactory } from 'n3';

/** Write receipts captured only after the corresponding metadata has been persisted. */
export const storageVersionReceipts = new AsyncLocalStorage<Map<string, RepresentationMetadata>>();

export const STORAGE_ETAG_PATTERN = /^"xpod-([a-f0-9]{32})-([A-Za-z0-9_-]+)"$/;

/** Only locked representation reads request lazy initialization of legacy metadata. */
export const storageVersionReadContext = new AsyncLocalStorage<boolean>();

/** The locking store must release its read locks before running this callback under write locks. */
export class LegacyStorageVersionError extends Error {
  public constructor(
    public readonly identifier: ResourceIdentifier,
    public readonly initialize: () => Promise<void>,
  ) {
    super('Legacy resource metadata requires a persisted storage revision');
  }
}

export function getStorageVersion(metadata: RepresentationMetadata): string | undefined {
  const value = metadata.get(HH.terms.etag)?.value;
  return value && (/^[a-f0-9]{32}$/.test(value) ? value : STORAGE_ETAG_PATTERN.exec(value)?.[1]);
}

export function stampStorageVersion(metadata: RepresentationMetadata): void {
  // HTTP storage metadata, not a Pod business field. Never trust a supplied revision.
  metadata.set(HH.terms.etag, DataFactory.literal(randomUUID().replaceAll('-', '')));
}

export function captureStorageVersion(metadata: RepresentationMetadata): void {
  storageVersionReceipts.getStore()?.set(metadata.identifier.value, new RepresentationMetadata(metadata));
}
