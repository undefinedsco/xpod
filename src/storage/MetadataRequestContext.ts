import { AsyncLocalStorage } from 'node:async_hooks';
import type { RepresentationMetadata } from '@solid/community-server';

type MetadataCacheEntry =
  | { kind: 'hit'; metadata: RepresentationMetadata }
  | { kind: 'miss' };

export interface MetadataRequestState {
  metadataCache: Map<string, MetadataCacheEntry>;
}

export const metadataRequestContext = new AsyncLocalStorage<MetadataRequestState>();
