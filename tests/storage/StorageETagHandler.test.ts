import { BasicConditions, BasicRepresentation, DC, GetOperationHandler, HeadOperationHandler, HH, ModifiedMetadataWriter, RepresentationMetadata } from '@solid/community-server';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { StorageETagHandler } from '../../src/storage/conditions/StorageETagHandler';
import { getStorageVersion, stampStorageVersion } from '../../src/storage/StorageVersion';

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
  it.each([{ method: 'GET', Handler: GetOperationHandler }, { method: 'HEAD', Handler: HeadOperationHandler }])('keeps one ETag in a cached $method read response', async ({ method, Handler }) => {
    const contentType = 'application/trig';
    const metadata = new RepresentationMetadata({ path: 'https://pod.example/inbox/events.ttl' }, contentType);
    stampStorageVersion(metadata);
    const revision = getStorageVersion(metadata)!;
    const tag = `"xpod-${revision}-${Buffer.from(contentType).toString('base64url')}"`;
    metadata.set(HH.terms.etag, DataFactory.literal(tag));
    const preserved = DataFactory.namedNode('https://example.org/read-marker');
    metadata.set(preserved, DataFactory.literal('preserve'));
    metadata.set(DC.terms.modified, DataFactory.literal('2026-10-04T00:00:00.000Z'));
    const body = new BasicRepresentation('cached content', metadata);
    const conditions = new BasicConditions(handler, { notMatchesETag: [tag] });
    let caught: unknown;
    try {
      const operationHandler = new Handler({ getRepresentation: async () => body } as never, handler);
      await operationHandler.handle({ operation: {
        method,
        target: { path: 'https://pod.example/inbox/events.ttl' },
        preferences: { type: { [contentType]: 1 } },
        conditions,
      } } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ statusCode: 304 });
    const response = (caught as { metadata: RepresentationMetadata }).metadata;
    expect(response.getAll(HH.terms.etag)).toHaveLength(1);
    expect(response.get(HH.terms.etag)?.value).toBe(tag);
    expect(response.get(preserved)?.value).toBe('preserve');
    expect(getStorageVersion(response)).toBe(revision);
    expect(body.data.destroyed).toBe(true);
    const headers = new Map<string, unknown>();
    await new ModifiedMetadataWriter().handle({ metadata: response, response: {
      hasHeader: (name: string) => headers.has(name),
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: unknown) => headers.set(name, value),
    } } as never);
    expect(headers.get('ETag')).toBe(tag);
    expect(headers.get('Last-Modified')).toBe('Sun, 04 Oct 2026 00:00:00 GMT');
  });

  it('finalizes response copies idempotently without changing the persisted revision', () => {
    const stored = new RepresentationMetadata({ path: 'https://pod.example/inbox/events.ttl' }, 'text/turtle');
    stampStorageVersion(stored);
    const revision = getStorageVersion(stored)!;
    const turtle = new RepresentationMetadata(stored);
    const trig = new RepresentationMetadata(stored, 'application/trig');
    const turtleTag = handler.getETag(turtle)!;
    const trigTag = handler.getETag(trig)!;
    expect(handler.getETag(turtle)).toBe(turtleTag);
    expect(handler.getETag(trig)).toBe(trigTag);
    expect(turtle.getAll(HH.terms.etag)).toHaveLength(1);
    expect(trig.getAll(HH.terms.etag)).toHaveLength(1);
    expect(stored.get(HH.terms.etag)?.value).toBe(revision);
    expect(getStorageVersion(turtle)).toBe(revision);
    expect(getStorageVersion(trig)).toBe(revision);
    expect(handler.sameResourceState(turtleTag, trigTag)).toBe(true);
    expect(handler.matchesETag(trig, turtleTag, false)).toBe(true);
    expect(handler.matchesETag(trig, turtleTag, true)).toBe(false);
    stampStorageVersion(trig);
    expect(handler.matchesETag(trig, trigTag, false)).toBe(false);
    expect(handler.sameResourceState(trigTag, handler.getETag(trig)!)).toBe(false);
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
