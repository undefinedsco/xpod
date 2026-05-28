import { describe, expect, it } from 'vitest';
import { resolvePodRootFromWebId, type CliAuthContext } from '../../src/cli/lib/auth-context';
import {
  contentTypeForPath,
  parseContainedResources,
  relativeToPodRoot,
  resolveResourceTarget,
  responseHeaders,
} from '../../src/cli/lib/resource';

const authContext: CliAuthContext = {
  baseUrl: 'https://pod.example/',
  webId: 'https://pod.example/alice/profile/card#me',
  podRoot: 'https://pod.example/alice/',
  baseIri: 'https://pod.example/alice/',
  accessToken: 'test-token',
  credentials: {
    url: 'https://pod.example/',
    webId: 'https://pod.example/alice/profile/card#me',
    authType: 'client_credentials',
    secrets: {
      clientId: 'id',
      clientSecret: 'secret',
    },
  },
};

describe('CLI resource helpers', () => {
  it('derives a Pod root from a profile WebID', () => {
    expect(resolvePodRootFromWebId('https://pod.example/alice/profile/card#me'))
      .toBe('https://pod.example/alice/');
  });

  it('resolves relative paths against the selected Pod root', () => {
    const target = resolveResourceTarget(authContext, 'settings/credentials.ttl');

    expect(target.resourceUrl).toBe('https://pod.example/alice/settings/credentials.ttl');
    expect(target.webId).toBe(authContext.webId);
    expect(target.podRoot).toBe(authContext.podRoot);
    expect(target.baseIri).toBe(authContext.baseIri);
  });

  it('preserves absolute resource URLs', () => {
    const target = resolveResourceTarget(authContext, 'https://other.example/bob/file.txt');

    expect(target.resourceUrl).toBe('https://other.example/bob/file.txt');
  });

  it('maps common file extensions to content types', () => {
    expect(contentTypeForPath('data.ttl')).toBe('text/turtle');
    expect(contentTypeForPath('data.json')).toBe('application/ld+json');
    expect(contentTypeForPath('note.md')).toBe('text/plain');
    expect(contentTypeForPath('photo.jpeg')).toBe('image/jpeg');
    expect(contentTypeForPath('archive.bin')).toBe('application/octet-stream');
  });

  it('parses LDP containment IRIs without treating dots in URLs as terminators', () => {
    const turtle = `
      @prefix ldp: <http://www.w3.org/ns/ldp#>.
      <https://pod.example/alice/public/> ldp:contains <https://pod.example/alice/public/a.txt>, <b.ttl>.
    `;

    expect(parseContainedResources(turtle, 'https://pod.example/alice/public/')).toEqual([
      'https://pod.example/alice/public/a.txt',
      'https://pod.example/alice/public/b.ttl',
    ]);
  });

  it('redacts sensitive response headers', () => {
    const headers = new Headers({
      authorization: 'Bearer secret',
      cookie: 'a=b',
      etag: '"abc"',
    });

    expect(responseHeaders(new Response(null, { headers }))).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      etag: '"abc"',
    });
  });

  it('formats Pod-relative paths when possible', () => {
    expect(relativeToPodRoot('https://pod.example/alice/public/a.txt', 'https://pod.example/alice/'))
      .toBe('public/a.txt');
    expect(relativeToPodRoot('https://other.example/a.txt', 'https://pod.example/alice/'))
      .toBe('https://other.example/a.txt');
  });
});
