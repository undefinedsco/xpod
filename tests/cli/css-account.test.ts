import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkServer, getAccountData } from '../../src/cli/lib/css-account';

describe('CLI CSS account helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads WebIDs from the account webId control when the index omits them', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://localhost:3000/.account/') {
        return new Response(JSON.stringify({
          controls: {
            account: {
              pod: 'http://localhost:3000/.account/account/abc/pod/',
              clientCredentials: 'http://localhost:3000/.account/account/abc/client-credentials/',
              webId: 'http://localhost:3000/.account/account/abc/webid/',
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'http://localhost:3000/.account/account/abc/webid/') {
        return new Response(JSON.stringify({
          webIdLinks: {
            'http://localhost:3000/test/profile/card#me':
              'http://localhost:3000/.account/account/abc/webid/link-1/',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const data = await getAccountData('account-token', 'http://localhost:3000/');

    expect(data?.webIds).toEqual({
      'http://localhost:3000/test/profile/card#me':
        'http://localhost:3000/.account/account/abc/webid/link-1/',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses top-level WebIDs without fetching the fallback control', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      controls: {
        account: {
          webId: 'http://localhost:3000/.account/account/abc/webid/',
        },
      },
      webIds: {
        'http://localhost:3000/alice/profile/card#me':
          'http://localhost:3000/.account/account/abc/webid/link-alice/',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    vi.stubGlobal('fetch', fetchMock);

    const data = await getAccountData('account-token', 'http://localhost:3000/');

    expect(data?.webIds).toEqual({
      'http://localhost:3000/alice/profile/card#me':
        'http://localhost:3000/.account/account/abc/webid/link-alice/',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks server reachability via OIDC discovery instead of unauthenticated account data', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://localhost:3000/.well-known/openid-configuration') {
        return new Response(JSON.stringify({ issuer: 'http://localhost:3000/' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    await expect(checkServer('http://localhost:3000/')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/.well-known/openid-configuration',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });
});
