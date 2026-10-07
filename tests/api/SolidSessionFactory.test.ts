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

/**
 * Admission is the only path that decides whether an inbound request may act as this credential.
 * It therefore proves the credential to its issuer every time; the session cache exists to keep
 * the rest of one request from exchanging the same credential twice, not to let a previous
 * request's success admit a later one.
 */
describe('SolidSessionFactory inbound admission', () => {
  const credential = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

  it('exchanges even with a valid session cached, and hands that session to the same request', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ access_token: 'from-an-earlier-request' }))
      .mockResolvedValueOnce(tokenResponse({ access_token: 'proves-this-request' }));
    const sessions = createFactory({ fetch: request });

    await sessions.session(credential);
    const admitted = await sessions.admit(credential);

    expect(admitted).toMatchObject({ accessToken: 'proves-this-request' });
    expect(request).toHaveBeenCalledTimes(2);
    // Reaching the Pod during the same request reuses the admitted token and its DPoP key.
    expect(await sessions.session(credential)).toBe(admitted);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('admits each distinct credential on its own exchange', async () => {
    const request = vi.fn().mockImplementation(async () => tokenResponse());
    const sessions = createFactory({ fetch: request });

    await sessions.admit(credential);
    await sessions.admit({ ...credential, clientSecret: 'rotated-secret' });
    await sessions.admit({ ...credential, version: 'v2' });

    // A rotation and a version bump are new credentials, never a warm cache hit.
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('drops the cached session of exactly the credential the issuer refused', async () => {
    const request = vi.fn().mockImplementation(async () => tokenResponse());
    const sessions = createFactory({ fetch: request });
    const untouched = { clientId: 'another-client', clientSecret: CLIENT_SECRET };

    await sessions.session(credential);
    await sessions.session(untouched);
    expect(request).toHaveBeenCalledTimes(2);

    request.mockResolvedValueOnce(new Response('invalid_client', { status: 401 }));
    await expect(sessions.admit(credential)).rejects.toMatchObject({ status: 401 });

    // The refused credential must be re-proved (and would now be refused again); the other
    // caller's session survives, so one revoked key is not every caller's outage.
    await sessions.admit(credential);
    await sessions.session(untouched);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps the cached session when the issuer is merely unavailable', async () => {
    const request = vi.fn().mockResolvedValueOnce(tokenResponse({ access_token: 'still-the-callers' }));
    const sessions = createFactory({ fetch: request });
    const issued = await sessions.session(credential);

    request.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(sessions.admit(credential)).rejects.toMatchObject({ status: 503 });

    // An outage is not a revocation, so the session issued before it is left alone.
    expect(await sessions.session(credential)).toBe(issued);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never admits on an exchange that began before the credential was destroyed', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn()
      // The exchange already in flight when the credential is destroyed still succeeds.
      .mockImplementationOnce(async () => { await blocked; return tokenResponse({ access_token: 'pre-revocation' }); })
      .mockResolvedValue(new Response('invalid_client', { status: 401 }));
    const sessions = createFactory({ fetch: request });

    const inFlight = sessions.session(credential);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    // A request that begins after the revocation must prove the credential itself.
    await expect(sessions.admit(credential)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(2);

    // The stale exchange is torn down rather than left as a usable session for anyone.
    release();
    await expect(inFlight).rejects.toThrow('token_exchange_invalidated');
  });

  it('does not republish a credential whose exchange resolved after a later request was refused', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn()
      // The exchange already in flight when the credential is destroyed still succeeds at the issuer.
      .mockImplementationOnce(async () => { await blocked; return tokenResponse({ access_token: 'pre-revocation' }); })
      .mockResolvedValue(new Response('invalid_client', { status: 401 }));
    const sessions = createFactory({ fetch: request });

    const lateAdmit = sessions.admit(credential);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    // A request that starts after the destruction proves the credential itself, and is refused.
    await expect(sessions.admit(credential)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(2);

    release();
    // The exchange already in flight is not torn down: its caller keeps the token it verified.
    await expect(lateAdmit).resolves.toMatchObject({ accessToken: 'pre-revocation' });

    // But its success must not republish authority the refusal took away: later Pod access has to
    // exchange again, and the issuer refuses the credential it no longer knows.
    await expect(sessions.session(credential)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not republish an admission that resolves after an explicit client invalidation', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn()
      .mockImplementationOnce(async () => { await blocked; return tokenResponse({ access_token: 'pre-revocation' }); })
      .mockResolvedValue(new Response('invalid_client', { status: 401 }));
    const sessions = createFactory({ fetch: request });

    const lateAdmit = sessions.admit(credential);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    // The product UI deletes the Account credential and tells the factory; the in-flight exchange
    // has not resolved yet.
    sessions.invalidateClientCredential(CLIENT_ID);
    release();
    await expect(lateAdmit).resolves.toMatchObject({ accessToken: 'pre-revocation' });

    await expect(sessions.session(credential)).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps an unrelated credential cached while one credential is invalidated mid-admission', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn()
      .mockImplementationOnce(async () => { await blocked; return tokenResponse({ access_token: 'pre-revocation' }); })
      .mockImplementation(async () => tokenResponse({ access_token: 'live' }));
    const sessions = createFactory({ fetch: request });
    const untouched = { clientId: 'another-client', clientSecret: CLIENT_SECRET };

    const lateAdmit = sessions.admit(credential);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const otherSession = await sessions.session(untouched);
    sessions.invalidateClientCredential(CLIENT_ID);
    release();
    await expect(lateAdmit).resolves.toMatchObject({ accessToken: 'pre-revocation' });

    // One revoked key is not every caller's outage.
    expect(await sessions.session(untouched)).toBe(otherSession);
    expect(request).toHaveBeenCalledTimes(2);
    // The invalidated credential is proved again rather than served from the late success.
    await expect(sessions.session(credential)).resolves.toMatchObject({ accessToken: 'live' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('admits a re-registered credential normally after an invalidation', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn()
      .mockImplementationOnce(async () => { await blocked; return tokenResponse({ access_token: 'pre-revocation' }); })
      .mockResolvedValue(tokenResponse({ access_token: 're-registered' }));
    const sessions = createFactory({ fetch: request });

    const lateAdmit = sessions.admit(credential);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    sessions.invalidateClientCredential(CLIENT_ID);
    release();
    await expect(lateAdmit).resolves.toMatchObject({ accessToken: 'pre-revocation' });

    // The guard is about the one obsolete success, not a permanent ban: admitting the credential
    // again after the invalidation exchanges and caches a session like any other.
    const reissued = await sessions.admit(credential);
    expect(reissued).toMatchObject({ accessToken: 're-registered' });
    expect(await sessions.session(credential)).toBe(reissued);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not accumulate invalidation state for clients it no longer tracks', () => {
    const sessions = createFactory({ fetch: vi.fn() });
    for (let index = 0; index < 500; index += 1) {
      sessions.invalidateClientCredential(`client-${index}`);
    }
    // White-box: the counter exists only while it guards an in-flight admission, so a burst of
    // revocations leaves nothing behind for the process to carry forever.
    const state = sessions as unknown as {
      invalidationSeq: Map<string, number>;
      admissionsInFlight: Map<string, number>;
    };
    expect(state.invalidationSeq.size).toBe(0);
    expect(state.admissionsInFlight.size).toBe(0);
  });
});
