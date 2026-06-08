import { describe, expect, it, vi } from 'vitest';
import {
  decodeProvisionScopePayload,
  filterWebIdsByStorageRoot,
  lookupProvisionScopedWebIds,
  resolveProvisionScope,
  storageRootFromOrigin,
  storageUrlBelongsToRoot,
} from '../../ui/src/utils/provision-scope';

describe('provision scope utilities', () => {
  it('decodes the readable provision payload and resolves the canonical storage root', () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'service-token',
      spDomain: 'node-0000.undefineds.co',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    expect(decodeProvisionScopePayload(provisionCode)).toMatchObject({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'service-token',
      spDomain: 'node-0000.undefineds.co',
    });
    expect(resolveProvisionScope(provisionCode)).toEqual({
      lookupUrl: 'http://localhost:5737/',
      storageRoot: 'https://node-0000.undefineds.co/',
      serviceToken: 'service-token',
    });
  });

  it('looks up WebIDs through the selected SP instead of trusting Cloud account lists', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'service-token',
      spDomain: 'node.example',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      entries: [
        {
          webId: 'https://id.example/alice/profile/card#me',
          storageUrl: 'https://node.example/alice/',
        },
      ],
    }));

    const entries = await lookupProvisionScopedWebIds(fetchMock as unknown as typeof fetch, [
      'https://id.example/alice/profile/card#me',
      'https://id.example/bob/profile/card#me',
    ], provisionCode);

    expect(entries).toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://node.example/alice/',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:5737/provision/webids', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer service-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        webIds: [
          'https://id.example/alice/profile/card#me',
          'https://id.example/bob/profile/card#me',
        ],
      }),
    });
  });

  it('filters remote lookup entries that do not belong to the provisioned storage root', async () => {
    const provisionCode = makeProvisionCode({
      spUrl: 'http://localhost:5737/',
      serviceToken: 'service-token',
      spDomain: 'node.example',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
      entries: [
        {
          webId: 'https://id.example/alice/profile/card#me',
          storageUrl: 'https://id.example/alice/',
        },
        {
          webId: 'https://id.example/alice/profile/card#me',
          storageUrl: 'https://node.example/alice/',
        },
      ],
    }));

    const entries = await lookupProvisionScopedWebIds(fetchMock as unknown as typeof fetch, [
      'https://id.example/alice/profile/card#me',
    ], provisionCode);

    expect(entries).toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://node.example/alice/',
      },
    ]);
  });

  it('checks whether storage URLs belong to the current SP root', () => {
    expect(storageRootFromOrigin('https://id.example')).toBe('https://id.example/');
    expect(storageRootFromOrigin(undefined)).toBeUndefined();
    expect(storageUrlBelongsToRoot('https://id.example/alice/', 'https://id.example/')).toBe(true);
    expect(storageUrlBelongsToRoot('https://node.example/alice/', 'https://id.example/')).toBe(false);
    expect(storageUrlBelongsToRoot('https://id.example/alice/', undefined)).toBe(false);
  });

  it('filters Cloud account WebIDs by their profile solid:storage binding', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://id.example/alice/profile/card#me') {
        return textResponse(200, `
          @prefix solid: <http://www.w3.org/ns/solid/terms#>.
          <https://id.example/alice/profile/card#me>
            solid:storage <https://id.example/alice/> .
        `, 'text/turtle');
      }
      if (url === 'https://id.example/glocal/profile/card#me') {
        return textResponse(200, `
          @prefix solid: <http://www.w3.org/ns/solid/terms#>.
          <https://id.example/glocal/profile/card#me>
            solid:storage <https://node.example/glocal/> .
        `, 'text/turtle');
      }
      return textResponse(404, '', 'text/turtle');
    });

    const entries = await filterWebIdsByStorageRoot(fetchMock as unknown as typeof fetch, [
      'https://id.example/alice/profile/card#me',
      'https://id.example/glocal/profile/card#me',
    ], 'https://id.example/');

    expect(entries).toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://id.example/alice/',
      },
    ]);
  });

  it('supports JSON-LD profile storage bindings when filtering WebIDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(200, JSON.stringify({
      '@graph': [
        {
          '@id': 'https://id.example/alice/profile/card#me',
          'http://www.w3.org/ns/solid/terms#storage': [
            { '@id': 'https://id.example/alice/' },
          ],
        },
      ],
    }), 'application/ld+json'));

    const entries = await filterWebIdsByStorageRoot(fetchMock as unknown as typeof fetch, [
      'https://id.example/alice/profile/card#me',
    ], 'https://id.example/');

    expect(entries).toEqual([
      {
        webId: 'https://id.example/alice/profile/card#me',
        storageUrl: 'https://id.example/alice/',
      },
    ]);
  });
});

function makeProvisionCode(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}

function jsonResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  } as Response;
}

function textResponse(status: number, text: string, contentType: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => text,
  } as Response;
}
