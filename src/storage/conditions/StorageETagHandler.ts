import { HH, type ETagHandler, type RepresentationMetadata } from '@solid/community-server';
import { DataFactory } from 'n3';
import { getStorageVersion, STORAGE_ETAG_PATTERN } from '../StorageVersion';

function renderStorageETag(metadata: RepresentationMetadata): string | undefined {
  const revision = getStorageVersion(metadata);
  if (revision && metadata.contentType) {
    return `"xpod-${revision}-${Buffer.from(metadata.contentType).toString('base64url')}"`;
  }
  return undefined;
}

/** Finalize an isolated response copy with its negotiated HTTP tag. */
export function getStorageETag(metadata: RepresentationMetadata): string | undefined {
  const tag = renderStorageETag(metadata);
  // CSS merges response metadata into a 304 error that already contains this tag. Keeping the raw
  // revision here creates two ETag values; the persisted revision remains recoverable from the tag.
  if (tag) metadata.set(HH.terms.etag, DataFactory.literal(tag));
  return tag;
}

/** Persisted revision authority for reads, conditional mutations and notifications. */
export class StorageETagHandler implements ETagHandler {
  public getETag(metadata: RepresentationMetadata): string | undefined {
    return renderStorageETag(metadata);
  }

  public matchesETag(metadata: RepresentationMetadata, eTag: string, strict: boolean): boolean {
    const parsed = STORAGE_ETAG_PATTERN.exec(eTag);
    return Boolean(parsed && parsed[1] === getStorageVersion(metadata) &&
      (!strict || eTag === this.getETag(metadata)));
  }

  public sameResourceState(eTag1: string, eTag2: string): boolean {
    const first = STORAGE_ETAG_PATTERN.exec(eTag1);
    const second = STORAGE_ETAG_PATTERN.exec(eTag2);
    return Boolean(first && second && first[1] === second[1]);
  }
}
