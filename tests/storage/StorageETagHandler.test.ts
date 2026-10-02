import { HH, RepresentationMetadata } from '@solid/community-server';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { StorageETagHandler } from '../../src/storage/conditions/StorageETagHandler';
import { stampStorageVersion } from '../../src/storage/StorageVersion';

describe('StorageETagHandler', () => {
  const handler = new StorageETagHandler();
  it('shares a resource revision across representations while comparing exact representation tags', () => {
    const metadata = new RepresentationMetadata({ path: 'https://pod.example/a' }, 'text/plain');
    stampStorageVersion(metadata);
    const text = handler.getETag(metadata)!;
    metadata.contentType = 'application/json';
    const json = handler.getETag(metadata)!;
    expect(json).not.toBe(text);
    expect(handler.sameResourceState(text, json)).toBe(true);
    expect(handler.matchesETag(metadata, text, false)).toBe(true);
    expect(handler.matchesETag(metadata, text, true)).toBe(false);
    expect(handler.matchesETag(metadata, json, true)).toBe(true);
    metadata.set(HH.terms.etag, DataFactory.literal(json));
    expect(handler.getETag(metadata)).toBe(json);
    stampStorageVersion(metadata);
    expect(handler.matchesETag(metadata, json, false)).toBe(false);
    expect(handler.sameResourceState(text, handler.getETag(metadata)!)).toBe(false);
  });
  it('does not accept timestamp-only, weak or malformed versions as mutation baselines', () => {
    const metadata = new RepresentationMetadata({ path: 'https://pod.example/a' }, 'text/plain');
    expect(handler.getETag(metadata)).toBeUndefined();
    expect(handler.matchesETag(metadata, '"1790847011000-text/plain"', false)).toBe(false);
    stampStorageVersion(metadata);
    const current = handler.getETag(metadata)!;
    expect(handler.matchesETag(metadata, `W/${current}`, false)).toBe(false);
    expect(handler.matchesETag(metadata, `${current}garbage`, false)).toBe(false);
    expect(handler.sameResourceState('malformed', 'malformed')).toBe(false);
  });
});
