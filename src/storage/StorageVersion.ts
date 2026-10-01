import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HH, RepresentationMetadata } from '@solid/community-server';
import { DataFactory } from 'n3';

/** Write receipts captured only after the corresponding metadata has been persisted. */
export const storageVersionReceipts = new AsyncLocalStorage<Map<string, RepresentationMetadata>>();

export function stampStorageVersion(metadata: RepresentationMetadata): void {
  // HTTP storage metadata, not a Pod business field. Never trust a supplied revision.
  metadata.set(HH.terms.etag, DataFactory.literal(randomUUID().replaceAll('-', '')));
}

export function captureStorageVersion(metadata: RepresentationMetadata): void {
  storageVersionReceipts.getStore()?.set(metadata.identifier.value, new RepresentationMetadata(metadata));
}
