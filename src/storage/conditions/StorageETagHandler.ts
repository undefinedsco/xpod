import { HH, type ETagHandler, type RepresentationMetadata } from '@solid/community-server';

const TAG = /^"xpod-([a-f0-9]{32})-([A-Za-z0-9_-]+)"$/;

/** Persisted revision authority for reads, conditional mutations and notifications. */
export class StorageETagHandler implements ETagHandler {
  public getETag(metadata: RepresentationMetadata): string | undefined {
    const revision = this.revision(metadata);
    if (revision && metadata.contentType) {
      return `"xpod-${revision}-${Buffer.from(metadata.contentType).toString('base64url')}"`;
    }
    // Old timestamp-only metadata remains readable but cannot establish a safe write baseline.
    return undefined;
  }

  public matchesETag(metadata: RepresentationMetadata, eTag: string, strict: boolean): boolean {
    const parsed = TAG.exec(eTag);
    return Boolean(parsed && parsed[1] === this.revision(metadata) &&
      (!strict || eTag === this.getETag(metadata)));
  }

  public sameResourceState(eTag1: string, eTag2: string): boolean {
    const first = TAG.exec(eTag1);
    const second = TAG.exec(eTag2);
    return Boolean(first && second && first[1] === second[1]);
  }

  private revision(metadata: RepresentationMetadata): string | undefined {
    const value = metadata.get(HH.terms.etag)?.value;
    return value && (/^[a-f0-9]{32}$/.test(value) ? value : TAG.exec(value)?.[1]);
  }
}
