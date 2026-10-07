import { describe, expect, it } from 'vitest';
import { parsePodResourceRef } from '@undefineds.co/drizzle-solid';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';

describe('public resource reference at a nested Pod root', () => {
  it.each([
    'https://a/alice/',
    'https://a/alice/.data/chat/tenant/',
    'https://a/.data/chat/first/.data/chat/second/',
  ])('preserves the builder key under %s', (pod) => {
    const iri = chatResource.buildIri(pod, { id: 'room' });
    const ref = parsePodResourceRef(chatResource, iri);
    expect(ref?.templateValues.key).toBe('room');
    expect(chatResource.buildIri(pod, { id: ref!.templateValues.key })).toBe(iri);
  });

  it('preserves public builder normalization of a path-like id', () => {
    const pod = 'https://a/alice/.data/chat/tenant/';
    const input = 'key/.data/chat/inside-😀';
    // A path-like id is normalized by the public builder; it is not a raw template key.
    const ordinary = chatResource.buildIri('https://a/alice/', { id: input });
    const expectedKey = parsePodResourceRef(chatResource, ordinary)!.templateValues.key;
    const iri = chatResource.buildIri(pod, { id: input });
    const parsed = parsePodResourceRef(chatResource, iri);
    expect(parsed?.templateValues.key).toBe(expectedKey);
    expect(chatResource.buildIri(pod, { id: parsed!.templateValues.key })).toBe(iri);
  });

  it('keeps the public relative-reference parsing contract', () => {
    expect(parsePodResourceRef(chatResource, 'room/index.ttl#this')?.templateValues.key).toBe('room');
  });

  it.each([
    [ 'message', messageResource ],
    [ 'thread', threadResource ],
  ] as const)('preserves a %s fragment containing a layout spelling', (_name, resource) => {
    const pod = 'https://a/alice/';
    const parent = chatResource.buildIri(pod, { id: 'x' });
    const iri = resource.buildIri(pod, { id: 'm/.data/z', parent, createdAt: new Date('2026-10-03T00:00:00Z') });
    const ref = parsePodResourceRef(resource, iri);
    expect(ref?.resourceId).toContain('#m/.data/z');
    expect(resource.buildIri(pod, { id: ref!.resourceId })).toBe(iri);
  });
});
