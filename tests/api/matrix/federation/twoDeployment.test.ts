import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../../helpers/MatrixMemoryDatabase';
import { matrixSigningIdentityRegistry } from '../../../../src/api/matrix/identityRegistry';
import { InMemoryMatrixSigningKeyStore, MatrixSigningIdentityProvider } from '../../../../src/api/matrix/signingKeyStore';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import { getProtocolMetadata } from '../../../../src/api/protocol-metadata';
import { InMemoryMatrixOutboundStore, MatrixOutbox } from '../../../../src/api/matrix/federation/outboundQueue';
import { MatrixOutboundSender } from '../../../../src/api/matrix/federation/outboundSender';
import { InMemoryMatrixInboundTransactionStore } from '../../../../src/api/matrix/federation/inboundTransaction';
import { handleFederationSend, type FederationSendTarget } from '../../../../src/api/matrix/federation/inboundRoute';
import { buildXMatrixAuthorization } from '../../../../src/api/matrix/federation/requestAuth';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import type { AuthEvent } from '../../../../src/api/matrix/protocol/authRules';

/** Real time: the events the store writes are stamped with it, and a key list is only
 * usable at a moment inside its validity window. */
const NOW = Date.now();

function identity(serverName: string): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

/** The registry only asks a provider for an identity, so a fixed one is enough here. */
function fixedProvider(serverName: string, participantIdentity: MatrixServiceIdentity) {
  return {
    serverName,
    provider: { identity: async () => participantIdentity } as unknown as MatrixSigningIdentityProvider,
  };
}

function keySourceFor(identities: readonly MatrixServiceIdentity[]): MatrixServerKeySource {
  const keys = new Map(identities.map(entry => [
    entry.serverName,
    parseServerKeyResponse(entry.serverKeyResponse(), { expectedServerName: entry.serverName, now: NOW }),
  ]));
  return { keysFor: async name => keys.get(name) };
}

function pdusOf(rows: Map<unknown, any[]>): Record<string, unknown>[] {
  return (rows.get(messageResource as never) ?? [])
    .map((row: any) => getProtocolMetadata(row.metadata, 'matrix')?.event as Record<string, unknown> | undefined)
    .filter((event): event is Record<string, unknown> => Boolean(event));
}

/** The membership event for a user, by membership: a room has an invite *and* a join. */
function findMembership(rows: Map<unknown, any[]>, userId: string, membership: string): Record<string, unknown> {
  const found = pdusOf(rows).find(event => event.type === 'm.room.member' && event.state_key === userId
    && (event.content as Record<string, unknown> | undefined)?.membership === membership);
  expect(found, `a ${membership} event for ${userId}`).toBeDefined();
  return found!;
}

function findPdu(rows: Map<unknown, any[]>, type: string, stateKey?: string): Record<string, unknown> {
  const found = pdusOf(rows).find(event => event.type === type && (stateKey === undefined || event.state_key === stateKey));
  expect(found, `a ${type} event${stateKey ? ` for ${stateKey}` : ''}`).toBeDefined();
  return found!;
}

/** The receiver resolves a PDU's auth events out of its own Pod, within that room. */
function authEventResolver(rows: Map<unknown, any[]>) {
  return async (ids: readonly string[], pdu: unknown): Promise<AuthEvent[]> => {
    const roomId = String((pdu as Record<string, unknown> | undefined)?.room_id ?? '');
    return pdusOf(rows)
      .filter(event => ids.includes(String(event.event_id)) && String(event.room_id) === roomId)
      .map(event => ({
        event_id: String(event.event_id),
        type: String(event.type),
        sender: String(event.sender),
        room_id: String(event.room_id),
        content: event.content as Record<string, unknown>,
        ...(event.state_key === undefined ? {} : { state_key: String(event.state_key) }),
      }));
  };
}

/**
 * One deployment: its own Pod (a separate harness database), its own signing identities,
 * its own outbound queue and its own inbound transaction log. Requests it sends are handed
 * to the peer's handler instead of the network, which is the hop a real deployment makes
 * with `PUT /_matrix/federation/v1/send/{txnId}`.
 */
function deployment(input: {
  deploymentName: string;
  participant: string;
  participantWebId: string;
  podUrl: string;
  /** The identity this deployment signs as; the peer verifies with the same object. */
  participantIdentity: MatrixServiceIdentity;
  /** Identities of the other deployment, so this one can verify its requests. */
  peers: readonly MatrixServiceIdentity[];
}) {
  const deploymentIdentity = identity(input.deploymentName);
  const registry = matrixSigningIdentityRegistry({
    identity: deploymentIdentity,
    providers: [ fixedProvider(input.participant, input.participantIdentity) ],
  });
  const transactions = new InMemoryMatrixInboundTransactionStore();
  let peer: FederationPeer | undefined;

  const sender = new MatrixOutboundSender({
    identities: registry,
    resolve: async name => ({ baseUrl: `https://${name}:8448`, hostHeader: name, via: 'implicit-port' }),
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (!peer) throw new Error('no peer connected');
      const target = new URL(String(url));
      const result = await peer.handle({
        authorization: (init?.headers as Record<string, string>).authorization,
        method: String(init?.method),
        uri: `${target.pathname}${target.search}`,
        body: String(init?.body ?? ''),
        serverName: target.hostname,
      });
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    now: () => NOW,
  });

  const outbox = new MatrixOutbox({
    store: new InMemoryMatrixOutboundStore(),
    send: async sendInput => await sender.send(sendInput),
    now: () => NOW,
  });
  // The store queues what it writes, so the queue has to exist before it.
  const harness = matrixHarness({ identities: registry, outbound: outbox });
  const context = { ...harness.context, webId: input.participantWebId, podUrl: input.podUrl };

  return {
    ...harness,
    context,
    registry,
    identities: [ deploymentIdentity, input.participantIdentity ],
    outbox,
    transactions,
    connect(other: FederationPeer) { peer = other; },
    async handle(request: { authorization: string | undefined; method: string; uri: string; body: string; serverName: string }) {
      return await handleFederationSend({
        ...request,
        keys: keySourceFor(input.peers),
        resolveTarget: async destination => destination === input.participant
          ? {
            scope: input.podUrl,
            acceptEvent: async event => { await harness.store.acceptReceivedEvent({ event, context }); },
            resolveAuthEvents: authEventResolver(harness.rows),
          } satisfies FederationSendTarget
          : undefined,
        transactions,
        now: () => NOW,
      });
    },
  };
}

/** What one deployment needs of another: its inbound transaction handler. */
interface FederationPeer {
  handle(request: { authorization: string | undefined; method: string; uri: string; body: string; serverName: string }): Promise<{ status: number; body: Record<string, unknown> }>;
}

function twoDeployments() {
  const aliceIdentity = identity('alice.example');
  const bobIdentity = identity('bob.example');
  const a = deployment({
    deploymentName: 'a.example', participant: 'alice.example', participantWebId: 'https://alice.example/profile/card#me',
    podUrl: 'https://pod-a.example/alice/', participantIdentity: aliceIdentity, peers: [ bobIdentity ],
  });
  const b = deployment({
    deploymentName: 'b.example', participant: 'bob.example', participantWebId: 'https://bob.example/profile/card#me',
    podUrl: 'https://pod-b.example/bob/', participantIdentity: bobIdentity, peers: [ aliceIdentity ],
  });
  a.connect(b);
  b.connect(a);
  return { a, b };
}

/** Hand a transaction over exactly as the sending deployment would, so it can be replayed. */
async function signedTransaction(
  sender: { registry: ReturnType<typeof matrixSigningIdentityRegistry> },
  pdu: Record<string, unknown>,
  options: { destination?: string; txnId?: string } = {},
) {
  const origin = 'alice.example';
  const destination = options.destination ?? 'bob.example';
  const txnId = options.txnId ?? 'replay-1';
  const identityOfSender = await sender.registry.identityFor(origin);
  const uri = `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`;
  const content = { origin, origin_server_ts: NOW, pdus: [ pdu ] };
  return {
    authorization: buildXMatrixAuthorization({ origin, destination, method: 'PUT', uri, content }, identityOfSender!),
    method: 'PUT',
    uri,
    body: JSON.stringify(content),
    serverName: destination,
  };
}

describe('two deployments federating one room', () => {
  it('carries room state, an invite, a join and a message between two Pods with the same event ids', async () => {
    const { a, b } = twoDeployments();
    const alice = (await a.store.getAccount(a.context)).userId;
    const bob = (await b.store.getAccount(b.context)).userId;
    expect(bob).toMatch(/:bob\.example$/u);

    // Alice creates the room on her own deployment; nobody else is in it yet, so nothing
    // leaves the Pod.
    const room = await a.store.createRoom({}, a.context);
    expect(room.roomId).toMatch(/:alice\.example$/u);
    expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ delivered: [] });

    // Bob's deployment cannot know the room, so the state an invite depends on is handed
    // over first — this is the `/get_missing_events` job the receiving server would do,
    // played here by the test. The two events travel in one transaction, in order.
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findPdu(a.rows, 'm.room.member', alice) ]) {
      await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
    }
    const bootstrap = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(bootstrap.delivered).toHaveLength(1);
    expect(pdusOf(b.rows).map(event => event.type)).toEqual([ 'm.room.create', 'm.room.member' ]);

    // The invite itself is a transaction of its own, and Bob's deployment can authorise it
    // because the state it names is there.
    await a.store.inviteUser(room.roomId, bob, a.context);
    const invite = findPdu(a.rows, 'm.room.member', bob);
    expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ delivered: expect.any(Array), rejected: [] });
    expect(findPdu(b.rows, 'm.room.member', bob).event_id).toBe(invite.event_id);

    // Bob joins on his own deployment, which queues his join back to Alice's server.
    await b.store.joinRoom(room.roomId, b.context);
    const bobJoin = findMembership(b.rows, bob, 'join');
    expect(Object.keys(bobJoin.signatures as Record<string, unknown>)).toEqual([ 'bob.example' ]);
    const back = await b.outbox.flush({ scope: b.context.podUrl! });
    expect(back.delivered).toHaveLength(1);
    // Alice's deployment accepted Bob's join and kept it verbatim, signature and all.
    expect(findMembership(a.rows, bob, 'join')).toEqual(bobJoin);

    // Alice's message reaches Bob's deployment with the same id on both sides.
    const sent = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hello bob' }, a.context);
    const forward = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(forward.delivered).toHaveLength(1);
    const received = findPdu(b.rows, 'm.room.message');
    expect(received.event_id).toBe(sent.eventId);
    expect((received.content as Record<string, unknown>).body).toBe('hello bob');

    // Both Pods agree on the room and on the identity of every event they share.
    const idsIn = (rows: Map<unknown, any[]>) => pdusOf(rows).map(event => String(event.event_id));
    expect(idsIn(b.rows).sort()).toEqual(idsIn(a.rows).sort());
    expect(pdusOf(b.rows).every(event => String(event.room_id) === room.roomId)).toBe(true);
    // A copy B received keeps the author's identity unknown: the row belongs to Bob's Pod,
    // but Bob is not the author, and a remote WebID cannot be derived from an MXID.
    const storedMessage = (b.rows.get(messageResource as never) as any[])
      .find((row: any) => (getProtocolMetadata(row.metadata, 'matrix')?.event as { event_id?: string } | undefined)?.event_id === sent.eventId)!;
    expect(getProtocolMetadata(storedMessage.metadata, 'matrix')?.senderWebId).toBeUndefined();
    expect(getProtocolMetadata(storedMessage.metadata, 'matrix')?.event).toMatchObject({ sender: alice });
  });

  it('answers a replayed transaction from the first attempt instead of writing twice', async () => {
    const { a, b } = twoDeployments();
    const alice = (await a.store.getAccount(a.context)).userId;
    const bob = (await b.store.getAccount(b.context)).userId;
    const room = await a.store.createRoom({}, a.context);
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findPdu(a.rows, 'm.room.member', alice) ]) {
      await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
    }
    await a.outbox.flush({ scope: a.context.podUrl! });
    await a.store.inviteUser(room.roomId, bob, a.context);
    const rowsBefore = b.rows.get(messageResource as never)!.length;

    const request = await signedTransaction(a, findMembership(a.rows, bob, 'invite'));
    const first = await b.handle(request);
    const rowsAfterFirst = b.rows.get(messageResource as never)!.length;
    expect(rowsAfterFirst).toBe(rowsBefore + 1);
    const second = await b.handle(request);
    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    // The replay is answered from the recorded response, so nothing was written twice.
    expect(b.rows.get(messageResource as never)!.length).toBe(rowsAfterFirst);
  });

  it('refuses an unserved destination, an unknown signer and a body that is not JSON', async () => {
    const { a, b } = twoDeployments();
    const bob = (await b.store.getAccount(b.context)).userId;
    const room = await a.store.createRoom({}, a.context);
    await a.store.inviteUser(room.roomId, bob, a.context);
    const invite = findMembership(a.rows, bob, 'invite');

    // Signed and consistent, but addressed to a server name this deployment does not serve:
    // accepting it would write a room into a Pod that is not that server's.
    const elsewhere = await signedTransaction(a, invite, { destination: 'nobody.example' });
    await expect(b.handle(elsewhere)).resolves.toMatchObject({ status: 403 });

    const known = await signedTransaction(a, invite);
    await expect(b.handle({ ...known, authorization: 'X-Matrix origin="mallory.example",destination="bob.example",key="ed25519:1",sig="nope"' }))
      .resolves.toMatchObject({ status: 401 });
    await expect(b.handle({ ...known, body: 'not json' })).resolves.toMatchObject({ status: 400 });
    // A body that claims a different origin than the request that was signed: the signature
    // no longer covers it, so it is not a transaction anybody sent.
    const mismatched = { ...known, body: JSON.stringify({ origin: 'mallory.example', origin_server_ts: NOW, pdus: [ invite ] }) };
    await expect(b.handle(mismatched)).resolves.toMatchObject({ status: 401 });
  });

  it('reports a PDU it cannot authorise, and the sender drops the transaction', async () => {
    const { a, b } = twoDeployments();
    const bob = (await b.store.getAccount(b.context)).userId;
    const room = await a.store.createRoom({}, a.context);
    await a.store.inviteUser(room.roomId, bob, a.context);
    // The invite arrives without the events that authorise it, so Bob's deployment cannot
    // check it yet and says so rather than pretending the event was taken.
    const request = await signedTransaction(a, findMembership(a.rows, bob, 'invite'), { txnId: 'no-deps' });
    const result = await b.handle(request);
    expect(result.status).toBe(200);
    expect(Object.values(result.body.pdus as Record<string, { error?: string }>)[0]?.error).toBeTruthy();
    expect(pdusOf(b.rows)).toEqual([]);

    // Known gap: a 200 counts as delivered for the sender, so a PDU the peer refused for
    // missing dependencies is not retried. Recording it is this round's finding.
    const flush = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(flush.rejected).toEqual([]);
    expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ delivered: [], deferred: [] });
  });
});
