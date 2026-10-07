import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MatrixFederationClient } from '../../../../src/api/matrix/federation/outboundTransaction';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';

const US = 'alice.example';
const THEM = 'bob.example';
const NOW = 1_700_000_000_000;

function ourIdentity(): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName: US,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

const pdu = { event_id: '$e', type: 'm.room.message', room_id: '!r:alice.example', sender: 'https://alice.example/card#me', content: { body: 'hi' } };
const ACTOR = { webId: 'https://alice.example/card#me', podUrl: 'https://alice.example/' };

interface Captured { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A client whose destination resolves, with a scripted actor fetch and capture. */
function client(actorFetch?: (actor: unknown) => Promise<typeof fetch | undefined>) {
  const signed = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    void url; void init;
    return new Response(JSON.stringify({ pdus: { $e: {} } }), { status: 200 });
  });
  const authenticatedCalls: Captured[] = [];
  const authenticated = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    authenticatedCalls.push({
      url: String(url),
      method: String(init?.method),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([ k, v ]) => [ k.toLowerCase(), v ])),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return new Response(JSON.stringify({ pdus: { $e: {} } }), { status: 200 });
  });
  const instance = new MatrixFederationClient({
    identity: ourIdentity(),
    resolve: async serverName => ({ baseUrl: `https://${serverName}:8448`, hostHeader: serverName, via: 'implicit-port' }),
    fetch: signed as unknown as typeof fetch,
    ...(actorFetch === undefined ? {} : { actorFetch: actorFetch as never }),
    now: () => NOW,
  });
  return { client: instance, signed, authenticated, authenticatedCalls };
}

describe('sending a federation transaction as a participant (O1)', () => {
  it('uses the participant authenticated fetch and sends no X-Matrix signature', async () => {
    const { client: instance, signed, authenticated, authenticatedCalls } = client(async() => authenticated as unknown as typeof fetch);
    const outcome = await instance.sendTransaction({ destination: THEM, txnId: 'txn-1', pdus: [ pdu ], actor: ACTOR });

    expect(outcome).toMatchObject({ status: 'delivered', origin: US, destination: THEM, txnId: 'txn-1' });
    expect(signed).not.toHaveBeenCalled();
    expect(authenticatedCalls).toHaveLength(1);
    const sent = authenticatedCalls[0];
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(`https://${THEM}:8448/_matrix/federation/v1/send/txn-1`);
    // The Solid session (added by the real authenticated fetch) is the only authorization; there
    // must be no X-Matrix fallback header.
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body).toMatchObject({ origin: US, pdus: [ pdu ] });
  });

  it('passes the actor reference to the credential resolver', async () => {
    const resolveActor = vi.fn(async() => undefined as typeof fetch | undefined);
    const { client: instance } = client(resolveActor);
    await instance.sendTransaction({ destination: THEM, txnId: 'txn-2', pdus: [ pdu ], actor: { webId: ACTOR.webId, podUrl: ACTOR.podUrl } });
    expect(resolveActor).toHaveBeenCalledWith({ webId: ACTOR.webId, podUrl: ACTOR.podUrl });
  });

  it('refuses an actor-bearing send when no credential can be resolved, without signing', async () => {
    const { client: instance, signed } = client(async() => undefined);
    const outcome = await instance.sendTransaction({ destination: THEM, txnId: 'txn-3', pdus: [ pdu ], actor: ACTOR });
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect((outcome as { reason: string }).reason).toContain(ACTOR.webId);
    expect(signed).not.toHaveBeenCalled();
  });

  it('refuses an actor-bearing send when the client has no credential source at all', async () => {
    const { client: instance, signed } = client();
    const outcome = await instance.sendTransaction({ destination: THEM, txnId: 'txn-4', pdus: [ pdu ], actor: ACTOR });
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(signed).not.toHaveBeenCalled();
  });

  it('re-resolves the participant credential on every attempt and stops when it is revoked', async () => {
    // The resolver is the authority: the first attempt gets a live (but temporarily failing)
    // session, the second attempt gets nothing because the grant was revoked in between. A revoked
    // actor must end as a rejection with zero signed/other-actor attempts, never a silent fallback
    // to the deployment identity or a replayed credential.
    let calls = 0;
    const resolveActor = vi.fn(async() => {
      calls += 1;
      if (calls === 1) {
        return (async() => new Response('busy', { status: 503 })) as unknown as typeof fetch;
      }
      return undefined;
    });
    const { client: instance, signed, authenticated } = client(resolveActor);
    const result = await instance.deliverTransaction({
      destination: THEM,
      txnId: 'txn-5',
      pdus: [ pdu ],
      actor: ACTOR,
      policy: { maxAttempts: 3, initialBackoffMs: 0, jitter: 0 },
      sleep: async() => undefined,
    });
    expect(resolveActor).toHaveBeenCalledTimes(2);
    expect(result.outcome).toMatchObject({ status: 'rejected' });
    expect((result.outcome as { reason: string }).reason).toContain(ACTOR.webId);
    // No fallback transport: neither the deployment-signed fetch nor any other authenticated fetch.
    expect(signed).not.toHaveBeenCalled();
    expect(authenticated).not.toHaveBeenCalled();
  });

  it('keeps the signed legacy path when no actor is given', async () => {
    const { client: instance, signed, authenticated } = client(async() => authenticated as unknown as typeof fetch);
    await instance.sendTransaction({ destination: THEM, txnId: 'txn-6', pdus: [ pdu ] });
    expect(signed).toHaveBeenCalledTimes(1);
  });
});
