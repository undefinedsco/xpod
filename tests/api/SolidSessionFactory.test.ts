import { describe, expect, it, vi } from 'vitest';

import { SolidSessionError, SolidSessionFactory } from '../../src/api/auth/SolidSessionFactory';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const WEB_ID = 'https://example.com/profile/card#me';
const TOKEN_ENDPOINT = 'https://id.example/.oidc/token';

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    access_token: 'solid-token',
    token_type: 'DPoP',
    expires_in: 3600,
    webid: WEB_ID,
    ...overrides,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function createFactory(input: {
  fetch: typeof fetch;
  tokenEndpoint?: string;
  publicBaseUrl?: string;
  now?: () => number;
}) {
  return new SolidSessionFactory({
    tokenEndpoint: input.tokenEndpoint ?? TOKEN_ENDPOINT,
    publicBaseUrl: input.publicBaseUrl,
    fetch: input.fetch,
    now: input.now,
  });
}

describe('SolidSessionFactory', () => {
  it('keeps the DPoP key the token is bound to, so the token stays spendable', async () => {
    const request = vi.fn().mockResolvedValue(tokenResponse());
    const sessions = createFactory({ fetch: request });

    const session = await sessions.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(session).toMatchObject({ accessToken: 'solid-token', tokenType: 'DPoP', webId: WEB_ID });
    expect(session.dpopKey?.privateKey).toBeTruthy();
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64')}`,
    );
    expect(headers.get('dpop')).toBeTruthy();
    expect(String(init.body)).toBe('grant_type=client_credentials&scope=webid');
  });

  it('exchanges one credential once and hands the same session to every caller', async () => {
    const request = vi.fn().mockResolvedValue(tokenResponse());
    const sessions = createFactory({ fetch: request });

    const first = await sessions.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const second = await sessions.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();
  });

  it('never serves one secret, version or issuer another credential\'s session', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'valid-token', token_type: 'Bearer' }))
      .mockImplementation(async () => new Response('invalid_client', { status: 401 }));
    const sessions = createFactory({ fetch: request });

    await expect(sessions.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .resolves.toMatchObject({ accessToken: 'valid-token' });

    // A different secret for the same client id is a different credential.
    await expect(sessions.session({ clientId: CLIENT_ID, clientSecret: 'wrong-secret' }))
      .rejects.toBeInstanceOf(SolidSessionError);
    // So is the same credential under a new version, and under another issuer.
    await expect(sessions.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, version: 'v2' }))
      .rejects.toBeInstanceOf(SolidSessionError);
    const otherIssuer = createFactory({ fetch: request, tokenEndpoint: 'https://other.example/token' });
    await expect(otherIssuer.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .rejects.toBeInstanceOf(SolidSessionError);

    expect(request).toHaveBeenCalledTimes(4);
  });

  it('repeats the exchange once the session is spent, and after an explicit invalidation', async () => {
    let now = 1_000_000;
    const request = vi.fn().mockImplementation(async () => tokenResponse({ expires_in: 60 }));
    const sessions = createFactory({ fetch: request, now: () => now });
    const credential = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

    await sessions.session(credential);
    await sessions.session(credential);
    expect(request).toHaveBeenCalledTimes(1);

    // Inside the expiry skew the token is no longer usable, so it must not be reused.
    now += 45_000;
    await sessions.session(credential);
    expect(request).toHaveBeenCalledTimes(2);

    sessions.invalidate(credential);
    await sessions.session(credential);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('reports the issuer\'s refusal with its status, and ignores a body without a token', async () => {
    const refused = createFactory({ fetch: vi.fn().mockResolvedValue(new Response('invalid_client', { status: 401 })) });
    await expect(refused.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .rejects.toMatchObject({ status: 401 });

    const empty = createFactory({ fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) });
    await expect(empty.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }))
      .rejects.toMatchObject({ status: undefined });
  });

  it('keeps the DPoP proof canonical when the deployment reaches its own interface in loopback', async () => {
    const request = vi.fn().mockResolvedValue(tokenResponse());
    const sessions = createFactory({
      fetch: request,
      tokenEndpoint: 'http://127.0.0.1:5737/.oidc/token',
      publicBaseUrl: 'https://pod.example/',
    });

    await sessions.session({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5737/.oidc/token');
    const proof = JSON.parse(Buffer.from(String(new Headers(init.headers).get('dpop')).split('.')[1]!, 'base64url').toString('utf-8'));
    expect(proof.htu).toBe('https://pod.example/.oidc/token');
  });

  it('forgets one client\'s sessions when its credential is revoked', async () => {
    const request = vi.fn().mockImplementation(async () => tokenResponse());
    const sessions = new SolidSessionFactory({ tokenEndpoint: TOKEN_ENDPOINT, fetch: request });

    const revoked = { clientId: 'client-revoked', clientSecret: CLIENT_SECRET };
    const kept = { clientId: 'client-kept', clientSecret: CLIENT_SECRET };
    await sessions.session(revoked);
    await sessions.session(kept);
    expect(request).toHaveBeenCalledTimes(2);

    sessions.invalidateClientCredential('client-revoked');

    // The revoked client is exchanged again (and would now be refused by the issuer); the other
    // client keeps its session, so an unrelated revocation does not cost every caller an exchange.
    await sessions.session(revoked);
    await sessions.session(kept);
    expect(request).toHaveBeenCalledTimes(3);

    sessions.invalidateClientCredential('never-seen');
    await sessions.session(kept);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('caps how many sessions it remembers', async () => {
    const request = vi.fn().mockImplementation(async () => tokenResponse());
    const sessions = new SolidSessionFactory({
      tokenEndpoint: TOKEN_ENDPOINT,
      fetch: request,
      maxEntries: 1,
    });

    await sessions.session({ clientId: 'client-a', clientSecret: CLIENT_SECRET });
    await sessions.session({ clientId: 'client-b', clientSecret: CLIENT_SECRET });
    await sessions.session({ clientId: 'client-a', clientSecret: CLIENT_SECRET });

    expect(request).toHaveBeenCalledTimes(3);
  });
});


describe('SolidSessionFactory exchange lifecycle', () => {
  const credential = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

  it('shares one pending exchange between concurrent requests', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn(async () => { await blocked; return tokenResponse(); });
    const sessions = createFactory({ fetch: request });
    const waiting = Array.from({ length: 10 }, () => sessions.session(credential));
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    release();
    const results = await Promise.all(waiting);
    expect(request).toHaveBeenCalledOnce();
    expect(results.every((session) => session === results[0])).toBe(true);
  });

  it.each(['credential', 'client'] as const)('rejects an exchange invalidated by %s before completion', async (kind) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn(async () => { await blocked; return tokenResponse(); });
    const sessions = createFactory({ fetch: request });
    const waiting = sessions.session(credential);
    const rejected = expect(waiting).rejects.toThrow('token_exchange_invalidated');
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    if (kind === 'client') sessions.invalidateClientCredential(CLIENT_ID);
    else sessions.invalidate(credential);
    release();
    await rejected;
    await sessions.session(credential);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate a newer session because an older request failed late', async () => {
    const request = vi.fn(async () => tokenResponse());
    const sessions = createFactory({ fetch: request });
    const first = await sessions.session(credential);
    sessions.invalidate(credential);
    const second = await sessions.session(credential);
    sessions.invalidate(credential, first);
    expect(await sessions.session(credential)).toBe(second);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('permits a new exchange after a pending exchange fails', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(tokenResponse());
    const sessions = createFactory({ fetch: request });
    await expect(sessions.session(credential)).rejects.toThrow('offline');
    await expect(sessions.session(credential)).resolves.toMatchObject({ accessToken: 'solid-token' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
