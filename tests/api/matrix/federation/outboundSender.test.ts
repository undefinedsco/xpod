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

function harness(options: {
  known: MatrixServiceIdentity[];
  refuseUnknown?: boolean;
  respond?: (attempt: number) => Response;
} ) {
  const { source, identityFor } = identities(options.known, { ...(options.refuseUnknown ? { refuseUnknown: true } : {}) });
  const captured: Captured[] = [];
  let attempt = 0;
  const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    captured.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([ k, v ]) => [ k.toLowerCase(), v ])),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    attempt += 1;
    return options.respond?.(attempt) ?? new Response(JSON.stringify({ pdus: {} }), { status: 200 });
  });
  const sender = new MatrixOutboundSender({
    identities: source,
    resolve: async serverName => ({ baseUrl: `https://${serverName}:8448`, hostHeader: serverName, via: 'implicit-port' }),
    fetch: fetch as unknown as typeof fetch,
    now: () => NOW,
    policy: { maxAttempts: 3, initialBackoffMs: 0, jitter: 0 },
    sleep: async () => undefined,
  });
  return { sender, captured, fetch, identityFor, source };
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
