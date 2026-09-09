import { describe, expect, it, vi } from 'vitest';
import { PodSearchIndexRebuilder } from '../../../src/api/ai-config/PodSearchIndexRebuilder';

describe('PodSearchIndexRebuilder', () => {
  it('walks the owner Pod and rebuilds text sources from actual resource bytes', async () => {
    const indexTextSource = vi.fn(async () => undefined);
    const trustedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://pod.example/alice/') {
        return new Response('<> <http://www.w3.org/ns/ldp#contains> <notes/a.md>, <private/> .', { headers: { 'content-type': 'text/turtle' } });
      }
      if (url.endsWith('/private/')) {
        return new Response('<> a <http://www.w3.org/ns/ldp#Container> .', { headers: { 'content-type': 'text/turtle' } });
      }
      return new Response('# Hello\nPod text', { headers: { 'content-type': 'text/markdown', etag: '"v1"' } });
    }) as typeof fetch;
    const rebuilder = new PodSearchIndexRebuilder({ trustedFetch, indexTextSource, maxResources: 20 });

    const result = await rebuilder.rebuildText({ webId: 'https://pod.example/alice/profile/card#me', podUrl: 'https://pod.example/alice/' });

    expect(result).toEqual({ scanned: 3, indexed: 1, skipped: 2, failed: 0 });
    expect(indexTextSource).toHaveBeenCalledWith({
      source: 'https://pod.example/alice/notes/a.md', workspace: 'https://pod.example/alice/',
      contentType: 'text/markdown', sourceVersion: '"v1"',
    }, '# Hello\nPod text');
  });

  it('feeds the same bounded Pod resources to the vector re-embedding executor', async () => {
    const indexVectorSource = vi.fn(async () => undefined);
    const trustedFetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/')
      ? new Response('<> <http://www.w3.org/ns/ldp#contains> <a.txt> .', { headers: { 'content-type': 'text/turtle' } })
      : new Response('semantic text', { headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    const rebuilder = new PodSearchIndexRebuilder({ trustedFetch, indexVectorSource });

    await expect(rebuilder.rebuildVector({ webId: 'https://pod.example/alice#me', podUrl: 'https://pod.example/' }))
      .resolves.toEqual({ scanned: 2, indexed: 1, skipped: 1, failed: 0 });
    expect(indexVectorSource).toHaveBeenCalledWith(expect.objectContaining({ source: 'https://pod.example/a.txt' }), 'semantic text');
  });
});
