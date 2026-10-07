import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClientCredentialsAuthenticator } from '../../src/api/auth/ClientCredentialsAuthenticator';
import { SolidSessionFactory } from '../../src/api/auth/SolidSessionFactory';

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

function authenticatorFor(input: {
  fetch: typeof fetch;
  tokenEndpoint?: string;
  publicBaseUrl?: string;
  sessions?: SolidSessionFactory;
}) {
  return new ClientCredentialsAuthenticator({
    sessions: input.sessions ?? new SolidSessionFactory({
      tokenEndpoint: input.tokenEndpoint ?? 'https://example.com/token',
      publicBaseUrl: input.publicBaseUrl,
      fetch: input.fetch,
    }),
  });
}

describe('ClientCredentialsAuthenticator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the Solid client-credentials DPoP exchange at an external issuer', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'cloud-solid-token',
      token_type: 'DPoP',
      expires_in: 3600,
      webid: TEST_WEB_ID,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const authenticator = authenticatorFor({
      fetch: request,
      tokenEndpoint: 'https://id.example/.oidc/token',
      publicBaseUrl: 'https://pod.example/',
    });

    const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    expect(result).toMatchObject({
      success: true,
      context: {
        type: 'solid',
        webId: TEST_WEB_ID,
        accountId: TEST_WEB_ID,
        clientId: TEST_CLIENT_ID,
        clientSecret: TEST_CLIENT_SECRET,
        accessToken: 'cloud-solid-token',
        tokenType: 'DPoP',
        viaApiKey: true,
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

  it('does not bypass the CSS exchange in development mode', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        access_token: 'development-solid-token',
        token_type: 'Bearer',
        expires_in: 3600,
        webid: TEST_WEB_ID,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const authenticator = authenticatorFor({ fetch: request });

      const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

      expect(request).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        success: true,
        context: { webId: TEST_WEB_ID, accessToken: 'development-solid-token' },
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('revalidates the credential on every new request instead of trusting a warm session', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'cached-token',
      token_type: 'DPoP',
      expires_in: 3600,
      webid: TEST_WEB_ID,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const authenticator = authenticatorFor({ fetch: request });

    const first = await authenticator.authenticate(makeRequest(VALID_SK_KEY));
    const second = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    // Two independent inbound requests each prove the credential to its issuer; the token a
    // previous request obtained is not evidence that the credential is still registered.
    expect(request).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ success: true, context: { accessToken: 'cached-token' } });
    expect(second).toMatchObject({ success: true, context: { accessToken: 'cached-token' } });
  });

  it('refuses a destroyed credential on the next request without waiting for the token to expire', async () => {
    // The issuer keeps accepting the credential until the Account credential is destroyed, and
    // then answers invalid_client. The first token is still unexpired throughout.
    let destroyed = false;
    const request = vi.fn().mockImplementation(async () => (destroyed
      ? new Response('invalid_client', { status: 401 })
      : new Response(JSON.stringify({
        access_token: 'pre-destroy-token',
        token_type: 'DPoP',
        expires_in: 3600,
        webid: TEST_WEB_ID,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const authenticator = authenticatorFor({ fetch: request });

    const before = await authenticator.authenticate(makeRequest(VALID_SK_KEY));
    expect(before).toMatchObject({ success: true, context: { accessToken: 'pre-destroy-token' } });

    destroyed = true;
    const after = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    expect(after).toMatchObject({ success: false, category: 'invalid_credentials', statusCode: 401 });
    expect(after).not.toHaveProperty('context');
    // The refusal is reported without echoing the wrapper or its decoded secret.
    expect(JSON.stringify(after)).not.toContain(TEST_CLIENT_SECRET);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never answers from a cached session while the issuer is unavailable', async () => {
    let unavailable = false;
    const request = vi.fn().mockImplementation(async () => (unavailable
      ? new Response('boom', { status: 503 })
      : new Response(JSON.stringify({
        access_token: 'cached-token',
        token_type: 'DPoP',
        expires_in: 3600,
        webid: TEST_WEB_ID,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const authenticator = authenticatorFor({ fetch: request });

    await expect(authenticator.authenticate(makeRequest(VALID_SK_KEY)))
      .resolves.toMatchObject({ success: true });

    unavailable = true;
    // An issuer we cannot reach is not proof of anything, so the cached token must not promote
    // itself into an admission decision.
    await expect(authenticator.authenticate(makeRequest(VALID_SK_KEY))).resolves.toMatchObject({
      success: false,
      category: 'service_unavailable',
      statusCode: 503,
    });
  });

  it('refuses a credential the issuer rejects, without inventing an identity', async () => {
    const request = vi.fn().mockImplementation(async () => new Response('invalid_client', { status: 401 }));
    const authenticator = authenticatorFor({ fetch: request });

    const result = await authenticator.authenticate(makeRequest(VALID_SK_KEY));

    expect(result).toMatchObject({ success: false, error: 'Token exchange failed: 401' });
    expect(result).not.toHaveProperty('context');
  });

  it('reports an unreachable or failing issuer as temporarily unavailable', async () => {
    const failing = authenticatorFor({
      fetch: vi.fn().mockImplementation(async () => new Response('boom', { status: 503 })),
    });
    await expect(failing.authenticate(makeRequest(VALID_SK_KEY))).resolves.toMatchObject({
      success: false,
      category: 'service_unavailable',
      statusCode: 503,
    });

    // A rate limit is the issuer asking us to slow down, not a statement that the key is gone.
    const limited = authenticatorFor({
      fetch: vi.fn().mockImplementation(async () => new Response('slow down', { status: 429 })),
    });
    await expect(limited.authenticate(makeRequest(VALID_SK_KEY))).resolves.toMatchObject({
      success: false,
      category: 'service_unavailable',
      statusCode: 503,
    });

    const unreachable = authenticatorFor({
      fetch: vi.fn().mockImplementation(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    await expect(unreachable.authenticate(makeRequest(VALID_SK_KEY))).resolves.toMatchObject({
      success: false,
      category: 'service_unavailable',
      statusCode: 503,
    });
  });

  it('rejects a token response that carries no owner', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'opaque-token',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const authenticator = authenticatorFor({ fetch: request });

    await expect(authenticator.authenticate(makeRequest(VALID_SK_KEY))).resolves.toMatchObject({
      success: false,
      error: 'Could not determine webId from token response',
    });
  });

  it('does not claim legacy xpod gateway or invocation bearer tokens', () => {
    const authenticator = authenticatorFor({ fetch: vi.fn() });

    expect(authenticator.canAuthenticate(makeRequest('xpod_gw_v1_cloud_gak_legacy_secret'))).toBe(false);
    expect(authenticator.canAuthenticate(makeRequest('xpod_inv_v1.kid.nonce.ciphertext.tag'))).toBe(false);
    // A DPoP header means a Solid token, which the Solid verifier owns.
    expect(authenticator.canAuthenticate({
      headers: { authorization: `Bearer ${VALID_SK_KEY}`, dpop: 'proof' },
    } as unknown as IncomingMessage)).toBe(false);
  });

  it('reports malformed wrappers instead of exchanging them', async () => {
    const request = vi.fn();
    const authenticator = authenticatorFor({ fetch: request });

    const missingColon = `sk-${Buffer.from('client-id-only').toString('base64')}`;
    await expect(authenticator.authenticate(makeRequest(missingColon))).resolves.toMatchObject({
      success: false,
      error: 'Invalid client credentials wrapper: missing colon separator',
    });
    const emptySecret = `sk-${Buffer.from(`${TEST_CLIENT_ID}:`).toString('base64')}`;
    await expect(authenticator.authenticate(makeRequest(emptySecret))).resolves.toMatchObject({
      success: false,
      error: 'Invalid client credentials wrapper: empty client_id or client_secret',
    });
    await expect(authenticator.authenticate(makeRequest('xpod_gw_v1_legacy'))).resolves.toMatchObject({
      success: false,
      error: 'Invalid client credentials wrapper: must start with sk-',
    });
    expect(request).not.toHaveBeenCalled();
  });
});
