import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MatrixOutboundSender } from '../../../../src/api/matrix/federation/outboundSender';
import { authenticateXMatrixRequest } from '../../../../src/api/matrix/federation/requestAuth';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import type { MatrixSigningIdentitySource } from '../../../../src/api/matrix/identityRegistry';

const ALICE = 'alice.example';
const BOB = 'bob.example';
const THEM = 'remote.example';
const TXN = 'txn-1';
const NOW = 1_700_000_000_000;

function identity(serverName: string): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

/** A registry-like source whose `identityFor` is observable, and can be made to refuse. */
function identities(known: MatrixServiceIdentity[], options: { refuseUnknown?: boolean } = {}) {
  const byName = new Map(known.map(entry => [ entry.serverName, entry ]));
  const identityFor = vi.fn(async (serverName: string) => {
    const found = byName.get(serverName);
    if (!found && options.refuseUnknown) throw new Error(`No Matrix signing identity is configured for ${serverName}`);
    return found;
  });
  const source: MatrixSigningIdentitySource = { identityFor, serverNames: () => [ ...byName.keys() ] };
  return { source, identityFor };
}

function keySource(known: MatrixServiceIdentity[]): MatrixServerKeySource {
  const keys = new Map(known.map(entry => [
    entry.serverName,
    parseServerKeyResponse(entry.serverKeyResponse(), { expectedServerName: entry.serverName, now: NOW }),
  ]));
  return { keysFor: async name => keys.get(name) };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * `captured` is what the peer was asked over the Matrix transport; `nativeAttempts` is every
 * attempt on its own endpoint. They are separate because a Matrix-only peer answers the native
 * attempt with 404 — a probe the Matrix-facing tests have no business asserting on.
 */
function harness(options: {
  known: MatrixServiceIdentity[];
  refuseUnknown?: boolean;
  respond?: (attempt: number) => Response;
  /** What the peer answers on its own endpoint; absent means it has none (404). */
  native?: (attempt: number) => Response;
  /** Injectable so "remembered for a while" is testable without waiting. */
  now?: () => number;
} ) {
  const { source, identityFor } = identities(options.known, { ...(options.refuseUnknown ? { refuseUnknown: true } : {}) });
  const captured: Captured[] = [];
  const nativeAttempts: Captured[] = [];
  let attempt = 0;
  let nativeAttempt = 0;
  const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const entry: Captured = {
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([ k, v ]) => [ k.toLowerCase(), v ])),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    if (entry.url.includes('/_xpod/matrix/inbound/')) {
      nativeAttempts.push(entry);
      nativeAttempt += 1;
      return options.native?.(nativeAttempt) ?? new Response('not found', { status: 404 });
    }
    captured.push(entry);
    attempt += 1;
    return options.respond?.(attempt) ?? new Response(JSON.stringify({ pdus: {} }), { status: 200 });
  });
  const sender = new MatrixOutboundSender({
    identities: source,
    resolve: async serverName => ({ baseUrl: `https://${serverName}:8448`, hostHeader: serverName, via: 'implicit-port' }),
    // Native requests go to the name itself, as they do in production.
    resolveNative: async serverName => ({ baseUrl: `https://${serverName}`, hostHeader: serverName, via: 'native-endpoint' }),
    fetch: fetch as unknown as typeof fetch,
    now: options.now ?? (() => NOW),
    policy: { maxAttempts: 3, initialBackoffMs: 0, jitter: 0 },
    sleep: async () => undefined,
  });
  return { sender, captured, nativeAttempts, fetch, identityFor, source };
}

describe('sending as a participant server', () => {
  it('signs the transaction as the origin, not as the deployment', async () => {
    const alice = identity(ALICE);
    const bob = identity(BOB);
    const { sender, captured } = harness({ known: [ alice, bob ] });
    const outcome = await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [ { type: 'm.room.message' } ] });

    expect(outcome).toMatchObject({ status: 'delivered', origin: ALICE, destination: THEM, txnId: TXN });
    const [ sent ] = captured;
    expect(sent.headers.authorization).toContain(`origin="${ALICE}"`);
    // The receiver verifies with alice.example's published key, and not with bob's.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'PUT', uri: `/_matrix/federation/v1/send/${TXN}`,
      content: sent.body, keys: keySource([ alice, bob ]), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: ALICE });
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'PUT', uri: `/_matrix/federation/v1/send/${TXN}`,
      content: sent.body, keys: keySource([ bob ]), serverName: THEM,
    })).resolves.toMatchObject({ valid: false });
  });

  it('refuses an origin this deployment holds no key for, without sending anything', async () => {
    const alice = identity(ALICE);
    const { sender, fetch } = harness({ known: [ alice ] });
    const outcome = await sender.send({ origin: 'mallory.example', destination: THEM, txnId: TXN, pdus: [] });

    expect(outcome).toMatchObject({ status: 'rejected', origin: 'mallory.example' });
    expect(outcome.reason).toMatch(/no signing identity/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a registry that throws on unknown names the same way', async () => {
    const alice = identity(ALICE);
    const { sender, fetch } = harness({ known: [ alice ], refuseUnknown: true });
    // No `serverNames()` to pre-check against, so the refusal comes from the lookup itself.
    const blind = new MatrixOutboundSender({
      identities: { identityFor: async () => { throw new Error('unknown server name'); } },
      resolve: async () => ({ baseUrl: `https://${THEM}:8448`, hostHeader: THEM, via: 'implicit-port' }),
      fetch: fetch as unknown as typeof fetch,
    });
    await expect(sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'delivered' });
    await expect(blind.send({ origin: 'mallory.example', destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'rejected' });
  });

  it('looks each origin\'s identity up once and reuses the client', async () => {
    const alice = identity(ALICE);
    const { sender, identityFor, captured } = harness({ known: [ alice ] });
    await sender.send({ origin: ALICE, destination: THEM, txnId: 'a', pdus: [] });
    await sender.send({ origin: ALICE, destination: 'other.example', txnId: 'b', pdus: [] });

    expect(identityFor).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(2);
  });

  it('spends the retry budget on the same transaction id', async () => {
    const alice = identity(ALICE);
    const { sender, captured } = harness({
      known: [ alice ],
      respond: attempt => (attempt < 3
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ pdus: { $e: {} } }), { status: 200 })),
    });
    const outcome = await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [] });

    expect(outcome.status).toBe('delivered');
    expect(captured.map(entry => entry.url.split('/').at(-1))).toEqual([ TXN, TXN, TXN ]);
  });

  it('reports an unresolvable destination as refused', async () => {
    const alice = identity(ALICE);
    const sender = new MatrixOutboundSender({
      identities: identities([ alice ]).source,
      resolve: async () => undefined,
      // Native-first: the native address is the one that has to be unresolvable here.
      resolveNative: async () => undefined,
      fetch: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch,
    });
    await expect(sender.send({ origin: ALICE, destination: 'nope', txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'rejected' });
  });

  it('carries EDUs through to the wire', async () => {
    const alice = identity(ALICE);
    const { sender, captured } = harness({ known: [ alice ] });
    await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [], edus: [ { edu_type: 'm.typing' } ] });
    expect(captured[0].body.edus).toEqual([ { edu_type: 'm.typing' } ]);
  });
});

describe('choosing a transport between two Xpod deployments', () => {
  const nativeUrl = `https://${THEM}/_xpod/matrix/inbound/${TXN}`;
  const matrixUrl = `https://${THEM}:8448/_matrix/federation/v1/send/${TXN}`;
  const deliveredNatively = (): Response => new Response(JSON.stringify({ events: { $e: {} } }), { status: 200 });

  it('tries the peer\'s own endpoint first, and does not also federate', async () => {
    const alice = identity(ALICE);
    const { sender, captured, nativeAttempts } = harness({
      known: [ alice ],
      native: deliveredNatively,
    });

    const outcome = await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [ { type: 'm.room.message' } ] });
    expect(outcome).toMatchObject({ status: 'delivered' });
    expect(nativeAttempts.map(entry => entry.url)).toEqual([ nativeUrl ]);
    // Nothing was federated: the peer already answered over its own endpoint.
    expect(captured).toEqual([]);
    // The native request is signed the same way, over the path it actually uses.
    await expect(authenticateXMatrixRequest({
      authorization: nativeAttempts[0].headers.authorization, method: 'POST', uri: `/_xpod/matrix/inbound/${TXN}`,
      content: nativeAttempts[0].body, keys: keySource([ alice ]), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: ALICE });
  });

  it('falls back to Matrix when the peer has no native endpoint, and remembers that', async () => {
    const alice = identity(ALICE);
    const { sender, captured, nativeAttempts } = harness({ known: [ alice ] });

    const first = await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [] });
    expect(first).toMatchObject({ status: 'delivered' });
    expect(nativeAttempts).toHaveLength(1);
    expect(captured.map(entry => entry.url)).toEqual([ matrixUrl ]);

    // A later batch goes straight to the transport the peer does speak.
    const second = await sender.send({ origin: ALICE, destination: THEM, txnId: 'txn-2', pdus: [] });
    expect(second).toMatchObject({ status: 'delivered' });
    expect(nativeAttempts).toHaveLength(1);
    expect(captured.map(entry => entry.url)).toEqual([ matrixUrl, `https://${THEM}:8448/_matrix/federation/v1/send/txn-2` ]);
  });

  it('asks again once the remembered answer is stale', async () => {
    const alice = identity(ALICE);
    let clock = NOW;
    const { sender, nativeAttempts } = harness({ known: [ alice ], now: () => clock });

    await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [] });
    await sender.send({ origin: ALICE, destination: THEM, txnId: 'txn-2', pdus: [] });
    expect(nativeAttempts).toHaveLength(1);

    // A peer that gains a native endpoint is noticed; one that never had it costs one 404 per window.
    clock += 10 * 60_000 + 1;
    await sender.send({ origin: ALICE, destination: THEM, txnId: 'txn-3', pdus: [] });
    expect(nativeAttempts).toHaveLength(2);
  });

  it('does not fall back when the peer decided about the events', async () => {
    const alice = identity(ALICE);
    const { sender, captured, nativeAttempts } = harness({
      known: [ alice ],
      native: () => new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'not joined' }), { status: 403 }),
    });

    const outcome = await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [] });
    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(outcome.reason).toContain('M_FORBIDDEN');
    // A refusal is an answer: re-sending the same batch over Matrix would ask the peer to decide twice.
    expect(nativeAttempts).toHaveLength(1);
    expect(captured).toEqual([]);
  });

  it('keeps trying the native transport when the peer is simply unreachable', async () => {
    const alice = identity(ALICE);
    // Unreachable is "the peer has not decided", so the batch stays owed under the same id and is
    // not re-sent over Matrix — where the peer might have received it after all.
    const { sender, captured, nativeAttempts } = harness({
      known: [ alice ],
      native: () => { throw new Error('connect ECONNREFUSED'); },
    });

    const outcome = await sender.send({ origin: ALICE, destination: THEM, txnId: TXN, pdus: [] });
    expect(outcome.status).toBe('retry');
    expect(nativeAttempts).toHaveLength(3);
    expect(captured).toEqual([]);
  });
});
