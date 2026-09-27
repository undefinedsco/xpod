import { generateKeyPairSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../../src/api/middleware/AuthMiddleware';
import { registerFederationRoutes } from '../../../../src/api/handlers/FederationHandler';
import { createParticipantRoutes } from '../../../../src/api/matrix/participantRoutes';
import { registerMatrixRoutes } from '../../../../src/api/handlers/MatrixHandler';
import { MatrixServerKeyFetcher } from '../../../../src/api/matrix/federation/serverKeys';
import { createNodeFederationFetch } from '../../../../src/api/matrix/federation/federationFetch';
import { validateInboundPdu } from '../../../../src/api/matrix/federation/inboundPdu';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../../helpers/MatrixMemoryDatabase';
import { matrixSigningIdentityRegistry } from '../../../../src/api/matrix/identityRegistry';
import { InMemoryMatrixSigningKeyStore, MatrixSigningIdentityProvider } from '../../../../src/api/matrix/signingKeyStore';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import { getProtocolMetadata } from '../../../../src/api/protocol-metadata';
import { InMemoryMatrixOutboundStore, MatrixOutbox } from '../../../../src/api/matrix/federation/outboundQueue';
import { createSchedulingOutbox, MatrixOutboxScheduler } from '../../../../src/api/matrix/federation/outboxScheduler';
import { MatrixOutboundSender } from '../../../../src/api/matrix/federation/outboundSender';
import { InMemoryMatrixInboundTransactionStore } from '../../../../src/api/matrix/federation/inboundTransaction';
import { handleFederationSend, type FederationSendTarget } from '../../../../src/api/matrix/federation/inboundRoute';
import { authenticateXMatrixRequest, buildXMatrixAuthorization } from '../../../../src/api/matrix/federation/requestAuth';
import { selectAuthChain } from '../../../../src/api/matrix/federation/authChain';
import { joinRoomOverFederation } from '../../../../src/api/matrix/federation/remoteJoin';
import { computeEventId } from '../../../../src/api/matrix/protocol/eventIntegrity';
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
  /** Whether this deployment fetches auth chains it is missing. Defaults to yes. */
  canFetchAuthChain?: boolean;
  /** Whether the store's writes drive delivery themselves, as they do in production. */
  schedulerDriven?: boolean;
  /**
   * How this deployment reaches a peer. Defaults to handing the request straight to the peer's
   * handler; a test that wants a real socket passes an HTTP transport instead.
   */
  fetch?: typeof fetch;
  /**
   * Wire the remote-join ports the way the container does, so `joinRoom` on a room this deployment
   * does not host goes through the membership handshake instead of a local write.
   */
  federationJoin?: boolean;
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
    fetch: input.fetch ?? (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (!peer) throw new Error('no peer connected');
      const target = new URL(String(url));
      const request = {
        authorization: (init?.headers as Record<string, string>).authorization,
        method: String(init?.method),
        uri: `${target.pathname}${target.search}`,
        body: String(init?.body ?? ''),
        serverName: target.hostname,
      };
      const result = target.pathname.includes('/event_auth/')
        ? await peer.handleAuthChain(request)
        : await peer.handle(request);
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
    now: () => NOW,
  });

  const outboundStore = new InMemoryMatrixOutboundStore();
  const outbox = new MatrixOutbox({
    store: outboundStore,
    send: async sendInput => await sender.send(sendInput),
    now: () => NOW,
    // Retry a refused PDU on the next flush rather than after a real backoff.
    retryRefused: { initialBackoffMs: 0, maxBackoffMs: 0, maxAttempts: 4 },
  });
  // In production a write signals the scheduler, which owns when a pass runs.
  const schedulerErrors: Error[] = [];
  const schedulerPasses: unknown[] = [];
  const scheduler = input.schedulerDriven
    ? new MatrixOutboxScheduler({
      outbox,
      intervalMs: 0,
      onError: error => { schedulerErrors.push(error); },
      onPass: pass => { schedulerPasses.push(pass); },
    })
    : undefined;
  const outbound = scheduler
    ? createSchedulingOutbox({ outbox, schedule: () => { scheduler.schedule(); } })
    : outbox;
  // The store queues what it writes, so the queue has to exist before it.
  const harness = matrixHarness({
    identities: registry,
    outbound,
    // The same wiring the container does: ask the room's server, sign as this participant.
    ...(input.federationJoin ? {
      directoryQuery: async ({ roomAlias, destination }: { roomAlias: string; destination: string }) => {
        const client = await sender.clientFor(input.participant);
        const answer = await client?.queryDirectory({ destination, roomAlias });
        return answer?.status === 'ok' ? answer.roomId : undefined;
      },
      remoteJoin: async ({ roomId, userId, destination }: { roomId: string; userId: string; destination: string }) => {
        const client = await sender.clientFor(input.participant);
        const participantIdentity = await registry.identityFor(input.participant).catch(() => undefined);
        if (!client || !participantIdentity) return undefined;
        return await joinRoomOverFederation({
          client, roomId, userId, destination,
          serverName: input.participant,
          sign: event => participantIdentity.signEvent(event),
        });
      },
    } : {}),
  });
  const context = { ...harness.context, webId: input.participantWebId, podUrl: input.podUrl };

  return {
    ...harness,
    context,
    registry,
    identities: [ deploymentIdentity, input.participantIdentity ],
    outbox,
    outboundStore,
    sender,
    transactions,
    scheduler,
    schedulerErrors,
    schedulerPasses,
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
            // The receiver cannot authorise an event whose auth events it lacks, so it asks
            // the sender for the chain — the same hop, in the other direction.
            ...(input.canFetchAuthChain === false ? {} : {
              fetchAuthChain: async ({ eventId, pdu, origin }: { eventId: string; pdu: Record<string, unknown>; origin: string }) => {
                const outcome = await sender.requestAuthChain({
                  origin: input.participant, destination: origin, roomId: String(pdu.room_id ?? ''), eventId,
                });
                return outcome.status === 'ok' ? outcome.events : undefined;
              },
            }),
          } satisfies FederationSendTarget
          : undefined,
        transactions,
        now: () => NOW,
      });
    },
    /** The serving side of `GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}`. */
    async handleAuthChain(request: { authorization: string | undefined; method: string; uri: string; serverName: string }) {
      const authentication = await authenticateXMatrixRequest({
        authorization: request.authorization, method: request.method, uri: request.uri,
        keys: keySourceFor(input.peers), serverName: request.serverName,
      });
      if (!authentication.valid) return { status: 401, body: { errcode: 'M_UNAUTHORIZED', error: authentication.reason } };
      const eventId = decodeURIComponent(request.uri.split('/').at(-1) ?? '');
      const { chain } = selectAuthChain(pdusOf(harness.rows), eventId);
      if (chain.length === 0) return { status: 404, body: { errcode: 'M_NOT_FOUND', error: `No auth chain for ${eventId}` } };
      return { status: 200, body: { auth_chain: chain } };
    },
  };
}

/** What one deployment needs of another: its inbound handlers. */
interface FederationPeer {
  handle(request: { authorization: string | undefined; method: string; uri: string; body: string; serverName: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  handleAuthChain(request: { authorization: string | undefined; method: string; uri: string; serverName: string }): Promise<{ status: number; body: Record<string, unknown> }>;
}

function twoDeployments(options: {
  fetchAuthChain?: boolean;
  schedulerDriven?: boolean;
  /** Transports for each deployment, when a test wants real HTTP instead of the in-process hop. */
  fetchA?: typeof fetch;
  fetchB?: typeof fetch;
  /** Join remote rooms through the membership handshake, as production does. */
  federationJoin?: boolean;
} = {}) {
  const aliceIdentity = identity('alice.example');
  const bobIdentity = identity('bob.example');
  const a = deployment({
    deploymentName: 'a.example', participant: 'alice.example', participantWebId: 'https://alice.example/profile/card#me',
    podUrl: 'https://pod-a.example/alice/', participantIdentity: aliceIdentity, peers: [ bobIdentity ],
    ...(options.schedulerDriven ? { schedulerDriven: true } : {}),
    ...(options.fetchA === undefined ? {} : { fetch: options.fetchA }),
    ...(options.federationJoin ? { federationJoin: true } : {}),
  });
  const b = deployment({
    deploymentName: 'b.example', participant: 'bob.example', participantWebId: 'https://bob.example/profile/card#me',
    podUrl: 'https://pod-b.example/bob/', participantIdentity: bobIdentity, peers: [ aliceIdentity ],
    ...(options.fetchAuthChain === false ? { canFetchAuthChain: false } : {}),
    ...(options.schedulerDriven ? { schedulerDriven: true } : {}),
    ...(options.fetchB === undefined ? {} : { fetch: options.fetchB }),
    ...(options.federationJoin ? { federationJoin: true } : {}),
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
    // over first. (The receiver can also fetch it itself — see the auth-chain test below —
    // but this test is about a multi-event transaction keeping its order.)
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findPdu(a.rows, 'm.room.member', alice), findPdu(a.rows, 'm.room.join_rules') ]) {
      await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
    }
    const bootstrap = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(bootstrap.delivered).toHaveLength(1);
    expect(pdusOf(b.rows).map(event => event.type)).toEqual([ 'm.room.create', 'm.room.member', 'm.room.join_rules' ]);

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
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findPdu(a.rows, 'm.room.member', alice), findPdu(a.rows, 'm.room.join_rules') ]) {
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

  it('retries an invite the peer refused for missing dependencies, once they arrive', async () => {
    // A receiver that cannot fetch is what makes the sender's retry the only way through.
    const { a, b } = twoDeployments({ fetchAuthChain: false });
    const alice = (await a.store.getAccount(a.context)).userId;
    const bob = (await b.store.getAccount(b.context)).userId;

    // Alice invites Bob into a room his deployment has never seen, so the invite travels
    // alone and is refused: the events that authorise it are not there yet.
    const room = await a.store.createRoom({ invite: [ bob ] }, a.context);
    const invite = findMembership(a.rows, bob, 'invite');
    const first = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(first.deferred).toHaveLength(1);
    expect(pdusOf(b.rows)).toEqual([]);

    // The state it depends on arrives afterwards — the `/get_missing_events` job, played by
    // the test. The refused invite is *not* dropped, so it goes out again on its own.
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findMembership(a.rows, alice, 'join'), findPdu(a.rows, 'm.room.join_rules') ]) {
      await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
    }
    await a.outbox.flush({ scope: a.context.podUrl! });
    expect(pdusOf(b.rows).map(event => event.type)).toEqual(expect.arrayContaining([ 'm.room.create', 'm.room.member' ]));

    const retried = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(retried.delivered).toHaveLength(1);
    expect(findMembership(b.rows, bob, 'invite').event_id).toBe(invite.event_id);
    void room;
  });

  it('accepts an invite by fetching its auth chain from the sending deployment', async () => {
    const { a, b } = twoDeployments();
    const bob = (await b.store.getAccount(b.context)).userId;

    // Alice invites Bob into a room his deployment has never seen. Nothing is handed over:
    // Bob's deployment receives the invite, finds it cannot authorise it, and asks Alice's
    // deployment for the chain.
    const room = await a.store.createRoom({ invite: [ bob ] }, a.context);
    const invite = findMembership(a.rows, bob, 'invite');
    const flush = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(flush.deferred).toEqual([]);
    expect(flush.delivered).toHaveLength(1);

    // The chain arrived with the invite and was stored before it, so the invite is accepted
    // with the id the sender gave it.
    expect(pdusOf(b.rows).map(event => event.type)).toEqual([ 'm.room.create', 'm.room.member', 'm.room.join_rules', 'm.room.member' ]);
    expect(findMembership(b.rows, bob, 'invite').event_id).toBe(invite.event_id);
    expect(pdusOf(b.rows).every(event => String(event.room_id) === room.roomId)).toBe(true);
  });

  it('delivers what a write queues, with nothing driving it but the write itself', async () => {
    const { a, b } = twoDeployments({ schedulerDriven: true });
    const alice = (await a.store.getAccount(a.context)).userId;
    const bob = (await b.store.getAccount(b.context)).userId;

    // The room exists on both sides (the bootstrap is the `/get_missing_events` job the test
    // still plays; everything after this point is driven by the writes themselves).
    const room = await a.store.createRoom({}, a.context);
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findMembership(a.rows, alice, 'join'), findPdu(a.rows, 'm.room.join_rules') ]) {
      await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
    }
    await a.outbox.flush({ scope: a.context.podUrl! });
    await a.store.inviteUser(room.roomId, bob, a.context);
    await a.outbox.flush({ scope: a.context.podUrl! });
    expect(findMembership(b.rows, bob, 'invite')).toBeDefined();

    // Bob joins: nothing flushes this by hand, so his join reaching Alice is the signal path.
    await b.store.joinRoom(room.roomId, b.context);
    await vi.waitFor(() => { expect(findMembership(a.rows, bob, 'join')).toBeDefined(); }, { timeout: 5_000 });
    expect(b.schedulerErrors).toEqual([]);

    // One write. The store hands it to the queue, the queue asks for a pass, the pass sends it.
    const sent = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-live', { body: 'live' }, a.context);
    await vi.waitFor(() => {
      expect(pdusOf(b.rows).map(event => event.event_id)).toContain(sent.eventId);
    }, { timeout: 5_000 });
    expect(a.schedulerErrors).toEqual([]);
    expect((findPdu(b.rows, 'm.room.message').content as Record<string, unknown>).body).toBe('live');
    expect(a.scheduler?.isRunning()).toBe(true);
    a.scheduler?.stop();
    b.scheduler?.stop();
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

  it('reports a PDU it cannot authorise, and the sender keeps it for retry', async () => {
    const { a, b } = twoDeployments({ fetchAuthChain: false });
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

    // A 200 answers the transaction, not the PDU: the refused invite stays queued under a
    // new transaction id, so it can go out again once its dependencies are there.
    const flush = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(flush.rejected).toEqual([]);
    expect(flush.deferred).toHaveLength(1);
    expect(flush.deferred[0].reason).toMatch(/v11/u);
    expect(flush.abandoned).toEqual([]);
  });
});

describe('when the other deployment cannot be reached', () => {
  /** A room on Alice's deployment with Bob joined, handed over the way the first test does it. */
  async function joinedRoom() {
    const pair = twoDeployments();
    const { a, b } = pair;
    const alice = (await a.store.getAccount(a.context)).userId;
    const bob = (await b.store.getAccount(b.context)).userId;
    const room = await a.store.createRoom({}, a.context);
    for (const pdu of [ findPdu(a.rows, 'm.room.create'), findPdu(a.rows, 'm.room.member', alice), findPdu(a.rows, 'm.room.join_rules') ]) {
      await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
    }
    await a.outbox.flush({ scope: a.context.podUrl! });
    await a.store.inviteUser(room.roomId, bob, a.context);
    await a.outbox.flush({ scope: a.context.podUrl! });
    await b.store.joinRoom(room.roomId, b.context);
    await b.outbox.flush({ scope: b.context.podUrl! });
    return { ...pair, room, alice, bob };
  }

  // The harness signs and verifies real events and writes through the real store paths, so these
  // two do several times the work of the tests above; the budget is for a loaded machine.
  it('holds the queue, keeps one transaction id, and delivers each event once after recovery', async () => {
    const { a, b, room } = await joinedRoom();
    const messagesIn = () => pdusOf(b.rows).filter(event => event.type === 'm.room.message');

    // Bob's deployment stops answering: every request fails at the transport, which is what an
    // unreachable peer looks like — the peer has not decided anything.
    const reachable = b.handle;
    let down = true;
    b.handle = async request => {
      if (down) throw new Error('bob.example is unreachable');
      return await reachable(request);
    };

    // Three writes while it is down. A write never waits for delivery: the messages are queued
    // and the caller is done, and none of them has left Alice's Pod yet.
    const written: string[] = [];
    for (const body of [ 'one', 'two', 'three' ]) {
      const sent = await a.store.sendEvent(room.roomId, 'm.room.message', `txn-${body}`, { body }, a.context);
      written.push(sent.eventId);
      expect(messagesIn()).toHaveLength(0);
    }

    // A pass fails and leaves the work in place, as a whole batch: nothing was delivered, so
    // nothing may be treated as delivered.
    const failed = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(failed).toMatchObject({ delivered: [], rejected: [], abandoned: [] });
    const pending = await a.outboundStore.pending(a.context.podUrl!);
    expect(pending).toHaveLength(1);
    expect(pending[0].pdus).toHaveLength(3);
    const [ { txnId } ] = pending;

    // A second attempt while it is still down reuses the transaction id — the peer dedups on it,
    // so minting a new one per attempt would make it process the same PDUs twice — and counts up.
    const again = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(again.deferred.map(entry => entry.txnId)).toEqual([ txnId ]);
    const stillPending = await a.outboundStore.pending(a.context.podUrl!);
    expect(stillPending.map(batch => batch.txnId)).toEqual([ txnId ]);
    expect(stillPending[0].attempts).toBe(2);
    expect(stillPending[0].lastReason).toMatch(/unreachable/u);
    expect(messagesIn()).toHaveLength(0);

    // Recovery: the same transaction goes out and the queue drains.
    down = false;
    const recovered = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(recovered.delivered).toEqual([ txnId ]);
    expect(await a.outboundStore.pending(a.context.podUrl!)).toEqual([]);

    // Every message arrived exactly once, in the order it was written, with the ids Alice has.
    const received = messagesIn();
    expect(received.map(event => String(event.event_id))).toEqual(written);
    expect(new Set(received.map(event => String(event.event_id))).size).toBe(3);
    // And the two Pods agree on the room: same events, same ids.
    const idsIn = (rows: Map<unknown, any[]>) => pdusOf(rows).map(event => String(event.event_id)).sort();
    expect(idsIn(b.rows)).toEqual(idsIn(a.rows));
  }, 120_000);

  it('lets nothing overtake a transaction the peer has not answered', async () => {
    const { a, b, room } = await joinedRoom();
    const reachable = b.handle;
    let down = true;
    b.handle = async request => {
      if (down) throw new Error('bob.example is unreachable');
      return await reachable(request);
    };

    // The first write is attempted (and fails); the two after it are queued behind it.
    await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'first' }, a.context);
    await a.outbox.flush({ scope: a.context.podUrl! });
    for (const body of [ 'second', 'third' ]) {
      await a.store.sendEvent(room.roomId, 'm.room.message', `txn-${body}`, { body }, a.context);
    }
    const queued = await a.outboundStore.pending(a.context.podUrl!);
    expect(queued.map(batch => batch.pdus.length)).toEqual([ 1, 2 ]);

    // While the head is unanswered, the batches behind it stay put — they may depend on it, and
    // the peer has not seen any of it. Serial delivery per destination is what keeps a room's
    // events applicable in order at the other end.
    const blocked = await a.outbox.flush({ scope: a.context.podUrl! });
    expect(blocked.delivered).toEqual([]);
    expect(blocked.deferred.map(entry => entry.txnId)).toEqual([ queued[0].txnId ]);
    expect(pdusOf(b.rows).filter(event => event.type === 'm.room.message')).toHaveLength(0);

    down = false;
    await a.outbox.flush({ scope: a.context.podUrl! });
    await a.outbox.flush({ scope: a.context.podUrl! });
    expect(await a.outboundStore.pending(a.context.podUrl!)).toEqual([]);
    expect(pdusOf(b.rows).filter(event => event.type === 'm.room.message')
      .map(event => String((event.content as Record<string, unknown>).body))).toEqual([ 'first', 'second', 'third' ]);
  }, 120_000);
});

/** Where a transport reaches its peer, which is only known once that peer's server is listening. */
interface Endpoint {
  port: number;
}

/**
 * A peer's transport, over a real socket.
 *
 * The sender builds `https://<server name>:8448/...` from the resolution it was given; this rewrites
 * that to the loopback port the test listens on while keeping everything the protocol uses — path,
 * query, method, headers and the `Host` header carrying the *server name*. Federation peers address
 * each other by name, so a test that let `Host` default to `127.0.0.1:port` would not be testing the
 * same thing.
 */
function httpTransport(endpoint: () => Endpoint | undefined, sent: { host?: string; path: string }[] = []): typeof fetch {
  return (async (url: URL | RequestInfo, init?: RequestInit) => {
    const target = endpoint();
    if (!target) throw new Error('the peer is not listening');
    const address = new URL(String(url));
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> ?? {}),
      // The implicit federation port, exactly as a peer that resolved nothing would send it.
      host: `${address.hostname}:8448`,
    };
    sent.push({ host: headers.host, path: `${address.pathname}${address.search}` });
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: target.port,
        method: String(init?.method ?? 'GET'),
        path: `${address.pathname}${address.search}`,
        headers,
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      if (init?.body !== undefined) request.write(String(init.body));
      request.end();
    });
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** Serve one deployment's inbound federation route on a real socket, routed by its Pod registry. */
async function serveFederation(input: {
  deployment: ReturnType<typeof deployment>;
  serverName: string;
  keys: readonly MatrixServiceIdentity[];
}) {
  const server = new ApiServer({
    port: 0,
    authMiddleware: new AuthMiddleware({
      authenticator: { canAuthenticate: () => false, authenticate: async () => ({ success: false, error: 'unused' }) },
    }),
  });
  const { context, store, sender, transactions } = input.deployment;
  // The client-facing Matrix routes too, so a peer can fetch this deployment's published keys the
  // way a real one does — by asking for a server name and getting the keys for that name.
  registerMatrixRoutes(server, {
    store,
    serviceIdentity: input.deployment.identities[0],
    identities: input.deployment.registry,
  });
  registerFederationRoutes(server, {
    // The real derivation, over a registry holding exactly this participant's Pod.
    routes: createParticipantRoutes({
      pods: {
        listAllPods: async () => [ {
          podId: 'pod-1',
          accountId: 'account-1',
          baseUrl: context.podUrl!,
          webId: context.webId,
        } ],
      },
    }),
    store,
    keys: keySourceFor([ ...input.keys ]),
    transactions,
    signerFor: async name => await input.deployment.registry.identityFor(name).catch(() => undefined),
    // What the test deployment can present for the routed participant. In production this is the
    // participant's task-layer grant; here it is the harness session the store already writes with.
    contextFor: route => ({ ...context, webId: route.webId, podUrl: route.podUrl }),
    // A PDU we cannot authorise is asked about — over the same transport, in the other direction.
    fetchAuthChain: async ({ roomId, eventId, sender: from, servedName }) => {
      const outcome = await sender.requestAuthChain({ origin: servedName, destination: from, roomId, eventId });
      return outcome.status === 'ok' ? outcome.events : undefined;
    },
  });
  await server.start();
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('ApiServer did not bind a TCP port');
  expect(input.serverName).toBeTruthy();
  return { server, endpoint: () => ({ port: bound.port }) };
}

/** Two deployments whose only way to each other is a socket, with both routes listening. */
async function httpPair(options: { federationJoin?: boolean } = {}) {
  let endpointA: Endpoint | undefined;
  let endpointB: Endpoint | undefined;
  const requestsToB: { host?: string; path: string }[] = [];
  const requestsToA: { host?: string; path: string }[] = [];
  const { a, b } = twoDeployments({
    fetchA: httpTransport(() => endpointB, requestsToB),
    fetchB: httpTransport(() => endpointA, requestsToA),
    ...(options.federationJoin ? { federationJoin: true } : {}),
  });
  const keys = [ a.identities[1], b.identities[1] ];
  const served = await serveFederation({ deployment: a, serverName: 'alice.example', keys });
  const servedB = await serveFederation({ deployment: b, serverName: 'bob.example', keys });
  endpointA = served.endpoint();
  endpointB = servedB.endpoint();
  return {
    a, b, requestsToA, requestsToB,
    portA: served.endpoint().port,
    portB: servedB.endpoint().port,
    async stop() {
      await served.server.stop();
      await servedB.server.stop();
    },
  };
}

describe('two deployments federating over real HTTP', () => {
  it('carries the room, the invite, the join and a message across sockets', async () => {
    const { a, b, requestsToA, requestsToB, stop } = await httpPair();

    try {
      const alice = (await a.store.getAccount(a.context)).userId;
      const bob = (await b.store.getAccount(b.context)).userId;
      const room = await a.store.createRoom({}, a.context);

      // The room's first events go to Bob's deployment over the socket, because it cannot know the
      // room they belong to. Nothing is handed over in process: this is the peer's HTTP route.
      for (const pdu of [ findPdu(a.rows, 'm.room.create'), findPdu(a.rows, 'm.room.member', alice), findPdu(a.rows, 'm.room.join_rules') ]) {
        await a.outbox.enqueue({ scope: a.context.podUrl!, origin: 'alice.example', destination: 'bob.example', pdus: [ pdu ] });
      }
      expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ delivered: expect.any(Array), rejected: [], abandoned: [] });
      expect(pdusOf(b.rows).map(event => event.type)).toEqual([ 'm.room.create', 'm.room.member', 'm.room.join_rules' ]);

      // The invite is authorised on the receiving side against exactly that state.
      await a.store.inviteUser(room.roomId, bob, a.context);
      expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ rejected: [], abandoned: [] });
      expect(findPdu(b.rows, 'm.room.member', bob).event_id).toBe(findPdu(a.rows, 'm.room.member', bob).event_id);

      // Bob joins on his own deployment, which queues his join back over the socket to Alice's.
      await b.store.joinRoom(room.roomId, b.context);
      const bobJoin = findMembership(b.rows, bob, 'join');
      expect(await b.outbox.flush({ scope: b.context.podUrl! })).toMatchObject({ delivered: expect.any(Array), rejected: [], abandoned: [] });
      expect(findMembership(a.rows, bob, 'join')).toEqual(bobJoin);

      // And a message from Alice reaches Bob's Pod with the same id on both sides.
      const sent = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-http', { body: 'over http' }, a.context);
      expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ delivered: expect.any(Array), rejected: [], abandoned: [] });
      expect(findPdu(b.rows, 'm.room.message').event_id).toBe(sent.eventId);
      expect((findPdu(b.rows, 'm.room.message').content as Record<string, unknown>).body).toBe('over http');

      // Both Pods hold the same events, by the same ids, with nothing left owed in either queue.
      const idsIn = (rows: Map<unknown, any[]>) => pdusOf(rows).map(event => String(event.event_id)).sort();
      expect(idsIn(b.rows)).toEqual(idsIn(a.rows));
      expect(await a.outboundStore.pending(a.context.podUrl!)).toEqual([]);
      expect(await b.outboundStore.pending(b.context.podUrl!)).toEqual([]);

      // And it all really went over the sockets, addressed by server name rather than by address.
      expect(requestsToB.length).toBeGreaterThanOrEqual(3);
      expect(requestsToA.length).toBeGreaterThanOrEqual(1);
      expect(requestsToB.map(request => request.host)).toEqual(requestsToB.map(() => 'bob.example:8448'));
      expect(requestsToA.map(request => request.host)).toEqual(requestsToA.map(() => 'alice.example:8448'));
      expect(requestsToB.every(request => request.path.startsWith('/_matrix/federation/v1/send/'))).toBe(true);
    } finally {
      await stop();
    }
  }, 180_000);

  it('joins a room through the handshake over HTTP, and keeps what the resident sent back', async () => {
    const { a, b, requestsToA, stop } = await httpPair({ federationJoin: true });
    try {
      const bob = (await b.store.getAccount(b.context)).userId;
      // A public room, so joining needs no invitation: this test is about the handshake, not about
      // who may join.
      const room = await a.store.createRoom({ visibility: 'public' }, a.context);

      // Bob joins a room only Alice's deployment hosts: not a local write, but the handshake —
      // template, signature, submission — over the socket.
      await b.store.joinRoom(room.roomId, b.context);
      expect(requestsToA.some(request => request.path.startsWith('/_matrix/federation/v1/make_join/'))).toBe(true);
      expect(requestsToA.some(request => request.path.startsWith('/_matrix/federation/v2/send_join/'))).toBe(true);

      // Both deployments hold Bob's join under the same id, and Bob's Pod holds the room's state
      // because the resident sent it with the join.
      const joinAtA = findMembership(a.rows, bob, 'join');
      const joinAtB = findMembership(b.rows, bob, 'join');
      expect(joinAtB.event_id).toBe(joinAtA.event_id);
      expect(findPdu(b.rows, 'm.room.create').event_id).toBe(findPdu(a.rows, 'm.room.create').event_id);
      expect(findPdu(b.rows, 'm.room.join_rules').event_id).toBe(findPdu(a.rows, 'm.room.join_rules').event_id);
      // The resident's signature is on the event Bob kept, next to Bob's own.
      expect(Object.keys(joinAtB.signatures as Record<string, unknown>).sort()).toEqual([ 'alice.example', 'bob.example' ]);

      // And the room works from there: Alice's next message reaches Bob's Pod.
      const sent = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-after-join', { body: 'after the handshake' }, a.context);
      expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ rejected: [], abandoned: [] });
      expect(findPdu(b.rows, 'm.room.message').event_id).toBe(sent.eventId);
    } finally {
      await stop();
    }
  }, 180_000);

  it('gets an invite countersigned by the invited server, over the wire', async () => {
    const { a, b, requestsToB, stop } = await httpPair();
    try {
      const bob = (await b.store.getAccount(b.context)).userId;
      const room = await a.store.createRoom({ visibility: 'public' }, a.context);
      await a.store.inviteUser(room.roomId, bob, a.context);
      const invite = findPdu(a.rows, 'm.room.member', bob);

      // The inviting deployment asks the invited one to sign, because a remote invite is only
      // complete once both servers have: the invited server is what makes it attributable to Bob.
      const client = await a.sender.clientFor('alice.example');
      expect(client).toBeDefined();
      const outcome = await client!.sendInvite({
        destination: 'bob.example',
        roomId: room.roomId,
        eventId: String(invite.event_id),
        event: invite,
      });

      expect(outcome.status).toBe('ok');
      const signed = outcome.event!;
      // Both signatures, and the same event: the invited server adds to it, it does not replace it.
      expect(computeEventId(signed)).toBe(invite.event_id);
      expect(Object.keys(signed.signatures as Record<string, unknown>).sort()).toEqual([ 'alice.example', 'bob.example' ]);
      expect(requestsToB.some(request => request.path.startsWith('/_matrix/federation/v2/invite/'))).toBe(true);
      // Nothing was written to Bob's Pod by the invite: he has not accepted anything yet.
      expect(pdusOf(b.rows)).toEqual([]);
    } finally {
      await stop();
    }
  }, 180_000);

  it('joins by an alias the other deployment holds, querying then handshaking', async () => {
    const { a, b, requestsToA, stop } = await httpPair({ federationJoin: true });
    try {
      const bob = (await b.store.getAccount(b.context)).userId;
      // A public room with an alias, which is how a client asks for a room it does not hold.
      const room = await a.store.createRoom({ visibility: 'public', room_alias_name: 'lobby' }, a.context);
      const alias = `#lobby:alice.example`;

      await b.store.joinRoom(alias, b.context);

      // The alias names the server that can resolve it, and both steps really went over the socket:
      // the directory query, then the handshake for the room it named.
      expect(requestsToA.some(request => request.path.startsWith('/_matrix/federation/v1/query/directory'))).toBe(true);
      expect(requestsToA.some(request => request.path.startsWith('/_matrix/federation/v1/make_join/'))).toBe(true);
      expect(requestsToA.some(request => request.path.startsWith('/_matrix/federation/v2/send_join/'))).toBe(true);

      // And both deployments ended up with the same room and the same membership.
      expect(findPdu(b.rows, 'm.room.create').event_id).toBe(findPdu(a.rows, 'm.room.create').event_id);
      expect(findMembership(b.rows, bob, 'join').event_id).toBe(findMembership(a.rows, bob, 'join').event_id);
      expect(room.roomId).toBeDefined();
    } finally {
      await stop();
    }
  }, 180_000);

  it('verifies a peer\'s event with the keys that peer publishes for its own name', async () => {
    const { a, b, portA, stop } = await httpPair();
    try {
      const alice = (await a.store.getAccount(a.context)).userId;
      const room = await a.store.createRoom({ visibility: 'public' }, a.context);
      const message = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-keys', { body: 'signed by alice' }, a.context);
      const create = findPdu(a.rows, 'm.room.create');
      const aliceJoin = findMembership(a.rows, alice, 'join');
      const pdu = findPdu(a.rows, 'm.room.message');

      // Bob's deployment fetches the keys of the *server name* it is verifying — over a socket, from
      // the route that publishes them — instead of being handed a key set.
      const fetcher = new MatrixServerKeyFetcher({
        fetch: globalThis.fetch,
        fetchTarget: createNodeFederationFetch(),
        resolveKeyEndpoint: () => `http://127.0.0.1:${portA}/_matrix/key/v2/server`,
      });
      const keys = await fetcher.keysFor('alice.example');
      expect(keys?.verifyKeys['ed25519:1']).toBeDefined();

      const asAuth = (event: Record<string, unknown>) => ({
        event_id: String(event.event_id),
        type: String(event.type),
        sender: String(event.sender),
        room_id: String(event.room_id),
        content: event.content as Record<string, unknown>,
        ...(event.state_key === undefined ? {} : { state_key: String(event.state_key) }),
      });
      const verified = await validateInboundPdu(pdu, {
        keys: fetcher,
        authEvents: [ asAuth(create), asAuth(aliceJoin) ],
        now: () => Date.now(),
      });
      expect(verified.outcome).toBe('accepted');
      expect(verified.eventId).toBe(message.eventId);

      // A name this deployment publishes nothing for is "no keys", not somebody else's keys.
      const stranger = await fetcher.keysFor('bob.example');
      expect(stranger).toBeUndefined();
      expect(b.store).toBeDefined();
    } finally {
      await stop();
    }
  }, 180_000);

  it('answers the read endpoints from the room it actually holds', async () => {
    const { a, b, requestsToA, stop } = await httpPair({ federationJoin: true });
    try {
      const bob = (await b.store.getAccount(b.context)).userId;
      const room = await a.store.createRoom({ visibility: 'public' }, a.context);
      const first = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-read-1', { body: 'first' }, a.context);
      const second = await a.store.sendEvent(room.roomId, 'm.room.message', 'txn-read-2', { body: 'second' }, a.context);
      // Bob joins through the handshake, so both deployments hold the same room.
      await b.store.joinRoom(room.roomId, b.context);
      const bobJoin = findMembership(a.rows, bob, 'join');
      const ids = (events: readonly Record<string, unknown>[]) => events.map(event => String(event.event_id)).sort();
      // The state before the *second message*: both messages were written before Bob joined, so the
      // room's state at that point is the create event, Alice's join and the join rules.
      const alice = (await a.store.getAccount(a.context)).userId;
      const roomState = [
        findPdu(a.rows, 'm.room.create').event_id,
        findMembership(a.rows, alice, 'join').event_id,
        findPdu(a.rows, 'm.room.join_rules').event_id,
      ];
      expect(bobJoin.event_id).toBeDefined();

      const client = await b.sender.clientFor('bob.example');
      expect(client).toBeDefined();

      // `/state` and `/state_ids` are the same answer twice: the state before the second message.
      const state = await client!.getState({ destination: 'alice.example', roomId: room.roomId, eventId: second.eventId });
      expect(state.status).toBe('ok');
      expect(ids(state.events!)).toEqual(ids(roomState.map(id => ({ event_id: id }))));
      const stateIds = await client!.getStateIds({ destination: 'alice.example', roomId: room.roomId, eventId: second.eventId });
      expect(stateIds.status).toBe('ok');
      expect([ ...stateIds.pduIds! ].sort()).toEqual(ids(roomState.map(id => ({ event_id: id }))));

      // `/backfill` includes the named event and walks back, newest first.
      const backfill = await client!.backfill({ destination: 'alice.example', roomId: room.roomId, from: [ second.eventId ], limit: 2 });
      expect(backfill.status).toBe('ok');
      expect(backfill.events!.map(event => String(event.event_id))).toEqual([ second.eventId, first.eventId ]);

      // `/get_missing_events` walks the parents a requester says it lacks, oldest first.
      const missing = await client!.getMissingEvents({
        destination: 'alice.example', roomId: room.roomId,
        earliestEvents: [ findPdu(a.rows, 'm.room.create').event_id as string ],
        latestEvents: [ second.eventId ],
        limit: 10,
      });
      expect(missing.status).toBe('ok');
      const missingIds = missing.events!.map(event => String(event.event_id));
      // The walk starts at the second message's parents and stops at what the requester says it has.
      expect(missingIds).toContain(first.eventId);
      expect(missingIds).not.toContain(findPdu(a.rows, 'm.room.create').event_id);

      // `/event_auth` answers with the chain that authorises the event, including it.
      const chain = await client!.getAuthChain({ destination: 'alice.example', roomId: room.roomId, eventId: second.eventId });
      expect(chain.status).toBe('ok');
      expect(chain.events!.map(event => String(event.event_id))).toContain(second.eventId);

      // Every one of those really was a signed request to Alice's deployment.
      for (const path of [ '/_matrix/federation/v1/state/', '/_matrix/federation/v1/state_ids/',
        '/_matrix/federation/v1/backfill/', '/_matrix/federation/v1/get_missing_events/',
        '/_matrix/federation/v1/event_auth/' ]) {
        expect(requestsToA.some(request => request.path.startsWith(path)), path).toBe(true);
      }
    } finally {
      await stop();
    }
  }, 180_000);

  it('fetches an auth chain over HTTP when it cannot authorise an event', async () => {
    const { a, b, requestsToA, requestsToB, stop } = await httpPair();
    try {
      const bob = (await b.store.getAccount(b.context)).userId;
      const room = await a.store.createRoom({}, a.context);
      // An invite names the invitee's server, so it is delivered to a deployment that does not
      // know the room yet — the case the chain fetch exists for.
      await a.store.inviteUser(room.roomId, bob, a.context);
      const invite = findPdu(a.rows, 'm.room.member', bob);
      expect(await a.outbox.flush({ scope: a.context.podUrl! })).toMatchObject({ rejected: [], abandoned: [] });

      // Bob's deployment cannot authorise the invite from what it holds, so it asks Alice's
      // deployment for the chain — over HTTP, through the route that answers `/event_auth` — and
      // accepts the room's state and the invite with the ids Alice has.
      expect(await b.outbox.flush({ scope: b.context.podUrl! })).toMatchObject({ rejected: [], abandoned: [] });
      expect(requestsToA.some(request => request.path.startsWith('/_matrix/federation/v1/event_auth/'))).toBe(true);

      const idsIn = (rows: Map<unknown, any[]>) => pdusOf(rows).map(event => String(event.event_id)).sort();
      expect(idsIn(b.rows)).toEqual(idsIn(a.rows));
      expect(findPdu(b.rows, 'm.room.member', bob).event_id).toBe(invite.event_id);
      expect(requestsToB.length).toBeGreaterThanOrEqual(1);
    } finally {
      await stop();
    }
  }, 180_000);
});