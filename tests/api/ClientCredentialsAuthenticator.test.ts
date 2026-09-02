import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientCredentialsAuthenticator } from '../../src/api/auth/ClientCredentialsAuthenticator';

const TEST_CLIENT_ID = 'test-client-id';
const TEST_CLIENT_SECRET = 'test-client-secret';
const VALID_SK_KEY = `sk-${Buffer.from(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`).toString('base64')}`;
const TEST_WEB_ID = 'https://example.com/profile/card#me';

function makeRequest(apiKey: string): IncomingMessage {
  return {
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  } as IncomingMessage;
}

describe('ClientCredentialsAuthenticator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the Solid client-credentials DPoP exchange at an external issuer', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'cloud-solid-token',
      token_type: 'DPoP',
      expires_in: 3600,
      webid: TEST_WEB_ID,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', request);
    const authenticator = new ClientCredentialsAuthenticator({
      tokenEndpoint: 'https://id.example/.oidc/token',
      publicBaseUrl: 'https://pod.example/',
    });

    const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    expect(result).toMatchObject({
      success: true,
      context: {
        webId: TEST_WEB_ID,
        accessToken: 'cloud-solid-token',
        tokenType: 'DPoP',
      },
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://id.example/.oidc/token');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`, 'utf8').toString('base64')}`,
    );
    expect(headers.get('dpop')).toBeTruthy();
    expect(headers.get('x-forwarded-host')).toBeNull();
    expect(String(init.body)).toBe('grant_type=client_credentials&scope=webid');
  });

  it('returns exchanged access token in solid auth context', async () => {
    const authenticator = new ClientCredentialsAuthenticator({
      tokenEndpoint: 'https://example.com/token',
    });
    const exchangeForToken = vi.fn().mockResolvedValue({
      success: true,
      token: 'solid-token',
      tokenType: 'DPoP',
      webId: TEST_WEB_ID,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    (authenticator as any).exchangeForToken = exchangeForToken;

    const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    expect(result.success).toBe(true);
    expect(exchangeForToken).toHaveBeenCalledWith(TEST_CLIENT_ID, TEST_CLIENT_SECRET);
    expect((result as any).context).toMatchObject({
      type: 'solid',
      webId: TEST_WEB_ID,
      accountId: TEST_WEB_ID,
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
      accessToken: 'solid-token',
      tokenType: 'DPoP',
      viaApiKey: true,
    });
  });

  it('does not bypass the CSS exchange in development mode', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const authenticator = new ClientCredentialsAuthenticator({
        tokenEndpoint: 'https://example.com/token',
      });
      const exchangeForToken = vi.fn().mockResolvedValue({
        success: true,
        token: 'development-solid-token',
        tokenType: 'Bearer',
        webId: TEST_WEB_ID,
      });
      (authenticator as any).exchangeForToken = exchangeForToken;

      const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

      expect(exchangeForToken).toHaveBeenCalledWith(TEST_CLIENT_ID, TEST_CLIENT_SECRET);
      expect(result).toMatchObject({
        success: true,
        context: { webId: TEST_WEB_ID, accessToken: 'development-solid-token' },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('returns cached access token in solid auth context', async () => {
    const tokenCache = {
      get: vi.fn().mockResolvedValue({
        token: 'cached-token',
        tokenType: 'DPoP',
        webId: TEST_WEB_ID,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      set: vi.fn(),
    };
    const authenticator = new ClientCredentialsAuthenticator({
      tokenEndpoint: 'https://example.com/token',
      tokenCache,
    });
    const exchangeForToken = vi.fn();
    (authenticator as any).exchangeForToken = exchangeForToken;

    const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    expect(result.success).toBe(true);
    expect(tokenCache.get).toHaveBeenCalledWith(TEST_CLIENT_ID);
    expect(exchangeForToken).not.toHaveBeenCalled();
    expect((result as any).context).toMatchObject({
      type: 'solid',
      webId: TEST_WEB_ID,
      accountId: TEST_WEB_ID,
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
      accessToken: 'cached-token',
      tokenType: 'DPoP',
      viaApiKey: true,
    });
  });

  it('does not claim legacy xpod gateway or invocation bearer tokens', () => {
    const authenticator = new ClientCredentialsAuthenticator({
      tokenEndpoint: 'https://example.com/token',
    });

    expect(authenticator.canAuthenticate(makeRequest('xpod_gw_v1_cloud_gak_legacy_secret'))).toBe(false);
    expect(authenticator.canAuthenticate(makeRequest('xpod_inv_v1.kid.nonce.ciphertext.tag'))).toBe(false);
  });
});
