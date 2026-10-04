import { HH, type ETagHandler, type RepresentationMetadata } from '@solid/community-server';
import { DataFactory } from 'n3';
import { getStorageVersion, STORAGE_ETAG_PATTERN } from '../StorageVersion';

/** Persisted revision authority for reads, conditional mutations and notifications. */
export class StorageETagHandler implements ETagHandler {
  public getETag(metadata: RepresentationMetadata): string | undefined {
    const revision = getStorageVersion(metadata);
    if (revision && metadata.contentType) {
      const tag = `"xpod-${revision}-${Buffer.from(metadata.contentType).toString('base64url')}"`;
      // Finalize response metadata before CSS merges it into a 304 error that
      // already contains this tag. Keeping the raw revision here creates two
      // ETag values; the persisted revision remains recoverable from the tag.
      metadata.set(HH.terms.etag, DataFactory.literal(tag));
      return tag;
    }
    // Uninitialized metadata cannot establish a safe write baseline.
    return undefined;
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
