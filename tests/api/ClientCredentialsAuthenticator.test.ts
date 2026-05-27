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
});
