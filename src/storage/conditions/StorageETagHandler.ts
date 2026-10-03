import { type ETagHandler, type RepresentationMetadata } from '@solid/community-server';
import { getStorageVersion, STORAGE_ETAG_PATTERN } from '../StorageVersion';

/** Render an operational storage revision for the negotiated representation. */
export function getStorageETag(metadata: RepresentationMetadata): string | undefined {
  const revision = getStorageVersion(metadata);
  if (revision && metadata.contentType) {
    return `"xpod-${revision}-${Buffer.from(metadata.contentType).toString('base64url')}"`;
  }
  // Uninitialized metadata cannot establish a safe write baseline.
  return undefined;
}

/** Persisted revision authority for reads, conditional mutations and notifications. */
export class StorageETagHandler implements ETagHandler {
  public getETag(metadata: RepresentationMetadata): string | undefined {
    return getStorageETag(metadata);
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
