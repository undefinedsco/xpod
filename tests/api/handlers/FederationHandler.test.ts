import { request as httpRequest } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import { registerFederationRoutes } from '../../../src/api/handlers/FederationHandler';
import { MatrixError } from '../../../src/api/matrix/MatrixError';
import { InMemoryMatrixInboundTransactionStore } from '../../../src/api/matrix/federation/inboundTransaction';
import { buildXMatrixAuthorization } from '../../../src/api/matrix/federation/requestAuth';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { computeEventId, signEvent } from '../../../src/api/matrix/protocol/eventIntegrity';
import type { FederationPodStore } from '../../../src/api/handlers/FederationHandler';
import type { MatrixServerRoute } from '../../../src/api/matrix/participantRoutes';
import type { MatrixEventRecord, MatrixStoreContext } from '../../../src/api/matrix/types';

const SERVED = 'alice.example';
const PEER = 'peer.example';
const ROOM = `!r:${SERVED}`;
const ALICE = `@u_alice:${SERVED}`;
const BOB = `@u_bob:${PEER}`;
const POD = 'https://pod.example/alice/';
const NOW = 1_700_000_000_000;

function identity(serverName: string) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const instance = new MatrixServiceIdentity({ serverName, activeKey: { keyId: 'ed25519:1', privateKeyPem }, now: () => NOW });
  const keys = parseServerKeyResponse(instance.serverKeyResponse(), { expectedServerName: serverName, now: NOW });
  return { instance, keyId: 'ed25519:1', privateKeyPem, serverName, keys };
}

/** The peer's view of itself, which is all this deployment needs to verify its requests. */
function keySourceFor(peer: ReturnType<typeof identity>): MatrixServerKeySource {
  return { keysFor: async name => (name === peer.serverName ? peer.keys : undefined) };
}

/**
 * A Pod as the inbound path uses it: a room's events, plus what has been accepted into it. The
 * read is the whole room, because that is what the shell is allowed to ask for.
 */
function podStore(
  initial: readonly Record<string, unknown>[] = [],
  /** Room aliases this Pod holds, and the servers resident in each room. */
  directory: { aliases?: Record<string, string>; servers?: Record<string, string[]> } = {},
) {
  const rooms = new Map<string, Record<string, unknown>[]>();
  for (const event of initial) {
    const roomId = String(event.room_id);
    rooms.set(roomId, [ ...(rooms.get(roomId) ?? []), event ]);
  }
  const accepted: Record<string, unknown>[] = [];
  const contexts: MatrixStoreContext[] = [];
  const store: FederationPodStore = {
    // The MXID derivation the store owns, so the query recognises a user the same way it names one.
    matrixUserIdFor: (webId, serverName) => `@u_${webId.includes('alice') ? 'alice' : 'other'}:${serverName}`,
    async findRoomByAlias(alias) {
      const roomId = directory.aliases?.[alias];
      return roomId === undefined ? undefined : { roomId };
    },
    async roomServers(roomId) {
      return directory.servers?.[roomId] ?? [];
    },
    async protocolEvents(roomId) {
      return [ ...(rooms.get(roomId) ?? []) ];
    },
    async acceptReceivedEvent({ event, context }) {
      contexts.push(context);
      const eventId = computeEventId(event);
      const stored = { ...event, event_id: eventId };
      rooms.set(String(event.room_id), [ ...(rooms.get(String(event.room_id)) ?? []), stored ]);
      accepted.push(stored);
      return {
        eventId,
        roomId: String(event.room_id),
        type: String(event.type),
        sender: String(event.sender),
        originServerTs: Number(event.origin_server_ts),
        content: (event.content ?? {}) as Record<string, unknown>,
        event: stored,
      } satisfies MatrixEventRecord;
    },
  };
  return { store, accepted, rooms, contexts };
}

/**
 * The room this deployment already holds: the create event, Alice's join and public join rules.
 * Everything the auth rules need for a joiner is here, so the peer's events can be authorised
 * against it.
 */
function heldRoom(options: { joinRule?: 'public' | 'knock' } = {}) {
  const alice = identity(SERVED);
  const stored = (event: Record<string, unknown>) => ({ ...event, event_id: computeEventId(event) });
  const create = stored(signEvent({
    type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 10_000,
    content: { room_version: '11' }, depth: 1, prev_events: [], auth_events: [],
  }, { keyId: alice.keyId, privateKeyPem: alice.privateKeyPem }, SERVED));
  const join = stored(signEvent({
    type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: ALICE, origin_server_ts: NOW - 9_000,
    content: { membership: 'join' }, depth: 2, prev_events: [ create.event_id as string ], auth_events: [ create.event_id as string ],
  }, { keyId: alice.keyId, privateKeyPem: alice.privateKeyPem }, SERVED));
  const rules = stored(signEvent({
    type: 'm.room.join_rules', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 8_000,
    content: { join_rule: options.joinRule ?? 'public' }, depth: 3,
    prev_events: [ join.event_id as string ], auth_events: [ create.event_id as string, join.event_id as string ],
  }, { keyId: alice.keyId, privateKeyPem: alice.privateKeyPem }, SERVED));
  return { create, join, rules, alice };
}

/** A PDU the peer signed. The test attaches the derived id, as the receiver does when it stores it. */
function peerEvent(input: {
  type: string;
  stateKey?: string;
  content: Record<string, unknown>;
  prev: string[];
  auth: string[];
  depth: number;
  peer: ReturnType<typeof identity>;
}) {
  const event = signEvent({
    room_id: ROOM,
    type: input.type,
    sender: BOB,
    origin_server_ts: NOW - input.depth * 100,
    content: input.content,
    depth: input.depth,
    prev_events: input.prev,
    auth_events: input.auth,
    ...(input.stateKey === undefined ? {} : { state_key: input.stateKey }),
  }, { keyId: input.peer.keyId, privateKeyPem: input.peer.privateKeyPem }, PEER);
  return { ...event, event_id: computeEventId(event) };
}

/** Bob's join, which the peer signs: the membership every later event of his is authorised by. */
function peerJoin(input: { room: ReturnType<typeof heldRoom>; peer: ReturnType<typeof identity>; depth?: number }) {
  return peerEvent({
    type: 'm.room.member', stateKey: BOB, content: { membership: 'join' },
    prev: [ input.room.rules.event_id as string ],
    // A join is authorised by the room's create event and its join rules; naming Alice's
    // membership would be an auth event the selection rules do not allow.
    auth: [ input.room.create.event_id as string, input.room.rules.event_id as string ],
    depth: input.depth ?? 4, peer: input.peer,
  });
}

/** A message from Bob, authorised by his own membership. */
function peerMessage(input: {
  room: ReturnType<typeof heldRoom>;
  peer: ReturnType<typeof identity>;
  body: string;
  membership: Record<string, unknown>;
  depth?: number;
}) {
  return peerEvent({
    type: 'm.room.message', content: { msgtype: 'm.text', body: input.body },
    prev: [ String(input.membership.event_id) ],
    auth: [ input.room.create.event_id as string, String(input.membership.event_id) ],
    depth: input.depth ?? 5, peer: input.peer,
  });
}

interface Harness {
  server: ApiServer;
  port: number;
  store: ReturnType<typeof podStore>;
  peer: ReturnType<typeof identity>;
  /** The identity this deployment accepts under, which countersigns what it takes. */
  ours: ReturnType<typeof identity>;
  sent: string[];
}

async function harness(options: {
  events?: readonly Record<string, unknown>[];
  served?: string[];
  /** Room aliases and resident servers, for the directory query. */
  directory?: { aliases?: Record<string, string>; servers?: Record<string, string[]> };
  /** The deployment's answer to "who is this written as"; recorded so the test can see it used. */
  contextFor?: (route: MatrixServerRoute) => MatrixStoreContext;
} = {}): Promise<Harness> {
  const store = podStore(options.events ?? [], options.directory ?? {});
  const peer = identity(PEER);
  const server = new ApiServer({
    port: 0,
    authMiddleware: new AuthMiddleware({
      authenticator: { canAuthenticate: () => false, authenticate: async () => ({ success: false, error: 'unused' }) },
    }),
  });
  const served = options.served ?? [ SERVED ];
  const sent: string[] = [];
  // The identity this deployment signs as for the name it serves; a join accepted into the routed
  // participant's Pod is countersigned by that participant, not by the deployment.
  const ours = identity(SERVED);
  registerFederationRoutes(server, {
    routes: {
      async route(name) {
        return served.includes(name)
          ? { kind: 'served', route: { webId: 'https://alice.example/card#me', podUrl: POD } }
          : { kind: 'unknown' };
      },
    },
    store: store.store,
    keys: keySourceFor(peer),
    transactions: new InMemoryMatrixInboundTransactionStore(),
    implementation: { name: 'xpod-test', version: '9.9.9' },
    ...(options.contextFor === undefined ? {} : { contextFor: options.contextFor }),
    signerFor: async serverName => (served.includes(serverName) ? ours.instance : undefined),
    fetchAuthChain: async ({ eventId }) => {
      sent.push(eventId);
      return undefined;
    },
    now: () => NOW,
  });
  await server.start();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ApiServer did not bind a TCP port');
  return { server, port: address.port, store, peer, ours, sent };
}

/** One HTTP request with full control over `Host`, which is how a peer addresses a server name. */
function send(input: {
  port: number;
  method: string;
  path: string;
  host?: string;
  authorization?: string;
  body?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: input.port,
      method: input.method,
      path: input.path,
      headers: {
        ...(input.host === undefined ? {} : { host: input.host }),
        ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
        'content-type': 'application/json',
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
      });
    });
    request.on('error', reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

/** What the peer sends: a transaction signed for the server name it addressed. */
function transaction(input: {
  peer: ReturnType<typeof identity>;
  destination: string;
  txnId: string;
  pdus: readonly Record<string, unknown>[];
  uri?: string;
}) {
  const uri = input.uri ?? `/_matrix/federation/v1/send/${input.txnId}`;
  const content = { origin: PEER, origin_server_ts: NOW, pdus: [ ...input.pdus ] };
  return {
    body: JSON.stringify(content),
    authorization: buildXMatrixAuthorization({
      origin: PEER, destination: input.destination, method: 'PUT', uri, content,
    }, input.peer.instance),
  };
}

describe('the inbound /send route', () => {
  let running: Harness | undefined;
  afterEach(async () => {
    await running?.server.stop();
    running = undefined;
  });

  it('accepts a signed transaction over HTTP and writes the event into the routed Pod', async () => {
    const room = heldRoom();
    const h = await harness({ events: [ room.create, room.join, room.rules ] });
    running = h;
    const membership = peerJoin({ room, peer: h.peer });
    const message = peerMessage({ room, peer: h.peer, body: 'hello', membership });
    const request = transaction({
      peer: h.peer, destination: SERVED, txnId: 'txn-1', pdus: [ membership, message ],
    });

    const answer = await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-1',
      host: SERVED, authorization: request.authorization, body: request.body,
    });

    expect(answer.status).toBe(200);
    expect(answer.body.pdus).toEqual({ [String(membership.event_id)]: {}, [String(message.event_id)]: {} });
    expect(h.store.accepted).toHaveLength(2);
    expect(h.store.accepted[1]).toMatchObject({ type: 'm.room.message', content: { body: 'hello' } });
  });

  it('answers a retry from what the transaction already produced', async () => {
    const room = heldRoom();
    const peer = identity(PEER);
    const membership = peerJoin({ room, peer });
    const h = await harness({ events: [ room.create, room.join, room.rules, membership ] });
    running = h;
    const message = peerMessage({ room, peer: h.peer, body: 'once', membership });
    const request = transaction({ peer: h.peer, destination: SERVED, txnId: 'txn-2', pdus: [ message ] });
    const attempt = async () => await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-2',
      host: SERVED, authorization: request.authorization, body: request.body,
    });

    expect((await attempt()).status).toBe(200);
    // The peer never saw the first answer and sends the same transaction again.
    expect((await attempt()).status).toBe(200);
    expect(h.store.accepted).toHaveLength(1);
  });

  it('resolves a PDU whose auth event was accepted earlier in the same transaction', async () => {
    const room = heldRoom();
    const h = await harness({ events: [ room.create, room.join, room.rules ] });
    running = h;
    // The join comes first, the message second: the message names the join as an auth event, and
    // the read that answered the join is already done.
    const membership = peerJoin({ room, peer: h.peer });
    const message = peerMessage({ room, peer: h.peer, body: 'after joining', membership });
    const request = transaction({ peer: h.peer, destination: SERVED, txnId: 'txn-3', pdus: [ membership, message ] });

    const answer = await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-3',
      host: SERVED, authorization: request.authorization, body: request.body,
    });

    expect(answer.body.pdus).toEqual({ [String(membership.event_id)]: {}, [String(message.event_id)]: {} });
    expect(h.store.accepted.map(event => event.type)).toEqual([ 'm.room.member', 'm.room.message' ]);
  });

  it('refuses a request addressed to a name this deployment does not serve', async () => {
    const room = heldRoom();
    const h = await harness({ events: [ room.create, room.join, room.rules ] });
    running = h;
    const membership = peerJoin({ room, peer: h.peer });
    const request = transaction({ peer: h.peer, destination: 'other.example', txnId: 'txn-4', pdus: [ membership ] });

    const answer = await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-4',
      host: 'other.example', authorization: request.authorization, body: request.body,
    });

    expect(answer.status).toBe(403);
    expect(answer.body.errcode).toBe('M_FORBIDDEN');
    expect(h.store.accepted).toEqual([]);
  });

  it('rejects a request whose signature is not the sender\'s, and one addressed elsewhere in the header', async () => {
    const room = heldRoom();
    const h = await harness({ events: [ room.create, room.join, room.rules ] });
    running = h;
    const membership = peerJoin({ room, peer: h.peer });

    // Signed by somebody else while claiming to be the peer.
    const attacker = identity('attacker.example');
    const forged = transaction({ peer: { ...h.peer, instance: attacker.instance as never }, destination: SERVED, txnId: 'txn-5', pdus: [ membership ] });
    const rejected = await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-5',
      host: SERVED, authorization: forged.authorization, body: forged.body,
    });
    expect(rejected.status).toBe(401);

    // Addressed to another name in the signed header: the signature is fine, the destination is not.
    const elsewhere = transaction({ peer: h.peer, destination: 'other.example', txnId: 'txn-5', pdus: [ membership ] });
    const mismatch = await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-5',
      host: SERVED, authorization: elsewhere.authorization, body: elsewhere.body,
    });
    expect(mismatch.status).toBe(401);
    expect(h.store.accepted).toEqual([]);
  });

  it('reads the implicit federation port as the server name, and asks the sender for what it lacks', async () => {
    const room = heldRoom();
    const h = await harness({ events: [ room.create, room.join, room.rules ] });
    running = h;
    // An event whose auth events this deployment does not hold: it is deferred, not dropped, and
    // the shell asks the sender for the chain (which the injected fetcher declines here).
    const orphan = peerEvent({
      type: 'm.room.message', content: { body: 'unknown parent' },
      prev: [ '$missing' ], auth: [ '$missing' ], depth: 9, peer: h.peer,
    });
    const request = transaction({ peer: h.peer, destination: SERVED, txnId: 'txn-6', pdus: [ orphan ] });

    const answer = await send({
      port: h.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-6',
      // A peer that reached the implicit port sends the name with it; both spellings are the name.
      host: `${SERVED}:8448`, authorization: request.authorization, body: request.body,
    });

    expect(answer.status).toBe(200);
    expect(String((answer.body.pdus as Record<string, { error?: string }>)[String(orphan.event_id)]?.error)).toMatch(/auth event/u);
    // The chain is asked for by the *event* that could not be authorised.
    expect(h.sent).toEqual([ String(orphan.event_id) ]);
    expect(h.store.accepted).toEqual([]);
  });
});

describe('the context the deployment writes with', () => {
  it('hands the store what contextFor answers for the routed participant', async () => {
    const room = heldRoom();
    const seen: { webId: string; podUrl: string }[] = [];
    const running = await harness({
      events: [ room.create, room.join, room.rules ],
      contextFor: route => {
        seen.push(route);
        // What a deployment that writes with the participant's grant answers; the store is the
        // one that decides whether that grant exists.
        return { webId: route.webId, podUrl: route.podUrl, service: {} };
      },
    });
    try {
      const membership = peerJoin({ room, peer: running.peer });
      const request = transaction({ peer: running.peer, destination: SERVED, txnId: 'txn-ctx', pdus: [ membership ] });
      const answer = await send({
        port: running.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-ctx',
        host: SERVED, authorization: request.authorization, body: request.body,
      });
      expect(answer.status).toBe(200);
      expect(seen).toEqual([ { webId: 'https://alice.example/card#me', podUrl: POD } ]);
      expect(running.store.contexts).toEqual([ { webId: 'https://alice.example/card#me', podUrl: POD, service: {} } ]);
    } finally {
      await running.server.stop();
    }
  });
});

/** A signed federation GET: no body, so nothing is signed beyond method, target and origin. */
function signedGet(input: { peer: ReturnType<typeof identity>; destination: string; uri: string }): string {
  return buildXMatrixAuthorization({
    origin: PEER, destination: input.destination, method: 'GET', uri: input.uri,
  }, input.peer.instance);
}

describe('the federation read endpoints', () => {
  const ROOM_PATH = encodeURIComponent(ROOM);

  /** A room this deployment holds: create, the joins, the rules, and one message on top. */
  async function heldWithMessage() {
    const room = heldRoom();
    const peer = identity(PEER);
    const membership = peerJoin({ room, peer });
    const message = peerMessage({ room, peer, body: 'stored', membership });
    const running = await harness({ events: [ room.create, room.join, room.rules, membership, message ] });
    return { room, membership, message, running };
  }

  it('answers /event_auth with the chain that authorises the event, including it', async () => {
    const { running, room, membership, message } = await heldWithMessage();
    try {
      const uri = `/_matrix/federation/v1/event_auth/${ROOM_PATH}/${encodeURIComponent(String(message.event_id))}`;
      const answer = await send({
        port: running.port, method: 'GET', path: uri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });

      expect(answer.status).toBe(200);
      const chain = (answer.body.auth_chain as Record<string, unknown>[]).map(event => String(event.event_id));
      // The transitive closure, oldest first: the message is authorised by the create event and the
      // sender's membership, and that membership by the join rules and Alice's own join.
      expect(chain).toEqual([
        room.create.event_id, room.join.event_id, room.rules.event_id, membership.event_id, message.event_id,
      ]);
    } finally {
      await running.server.stop();
    }
  });

  it('answers /state and /state_ids with the state before the event', async () => {
    const { running, room, membership, message } = await heldWithMessage();
    try {
      const query = `?event_id=${encodeURIComponent(String(message.event_id))}`;
      const stateUri = `/_matrix/federation/v1/state/${ROOM_PATH}${query}`;
      const state = await send({
        port: running.port, method: 'GET', path: stateUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: stateUri }),
      });
      expect(state.status).toBe(200);
      expect((state.body.pdus as Record<string, unknown>[]).map(event => String(event.event_id)).sort())
        .toEqual([ room.create.event_id, room.join.event_id, room.rules.event_id, membership.event_id ].sort());
      expect((state.body.auth_chain as Record<string, unknown>[]).length).toBeGreaterThan(0);

      const idsUri = `/_matrix/federation/v1/state_ids/${ROOM_PATH}${query}`;
      const ids = await send({
        port: running.port, method: 'GET', path: idsUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: idsUri }),
      });
      expect(ids.status).toBe(200);
      expect((ids.body.pdu_ids as string[]).sort()).toEqual((state.body.pdus as Record<string, unknown>[])
        .map(event => String(event.event_id)).sort());
      expect((ids.body.auth_chain_ids as string[]).length).toBeGreaterThan(0);
    } finally {
      await running.server.stop();
    }
  });

  it('answers /backfill with the named event and what preceded it, newest first', async () => {
    const { running, room, membership, message } = await heldWithMessage();
    try {
      const uri = `/_matrix/federation/v1/backfill/${ROOM_PATH}?v=${encodeURIComponent(String(message.event_id))}&limit=3`;
      const answer = await send({
        port: running.port, method: 'GET', path: uri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });

      expect(answer.status).toBe(200);
      // A transaction: who answered, when, and the window itself (the named event included).
      expect(answer.body.origin).toBe(SERVED);
      expect(typeof answer.body.origin_server_ts).toBe('number');
      expect((answer.body.pdus as Record<string, unknown>[]).map(event => String(event.event_id)))
        .toEqual([ message.event_id, membership.event_id, room.rules.event_id ]);
    } finally {
      await running.server.stop();
    }
  });

  it('answers /get_missing_events with the parents the requester lacks, oldest first', async () => {
    const { running, room, membership, message } = await heldWithMessage();
    try {
      const uri = `/_matrix/federation/v1/get_missing_events/${ROOM_PATH}`;
      const body = JSON.stringify({
        earliest_events: [ room.create.event_id ],
        latest_events: [ message.event_id ],
      });
      const answer = await send({
        port: running.port, method: 'POST', path: uri, host: SERVED, body,
        authorization: buildXMatrixAuthorization({
          origin: PEER, destination: SERVED, method: 'POST', uri, content: JSON.parse(body),
        }, running.peer.instance),
      });

      expect(answer.status).toBe(200);
      const events = (answer.body.events as Record<string, unknown>[]).map(event => String(event.event_id));
      // The walk starts at the message's parents and stops at what the requester says it has.
      expect(events).toEqual([ room.join.event_id, room.rules.event_id, membership.event_id ]);
    } finally {
      await running.server.stop();
    }
  });

  it('requires a signature, a name it serves, and a room it knows', async () => {
    const { running, message } = await heldWithMessage();
    try {
      const uri = `/_matrix/federation/v1/event_auth/${ROOM_PATH}/${encodeURIComponent(String(message.event_id))}`;
      const unsigned = await send({ port: running.port, method: 'GET', path: uri, host: SERVED });
      expect(unsigned.status).toBe(401);

      const elsewhere = await send({
        port: running.port, method: 'GET', path: uri, host: 'other.example',
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });
      expect(elsewhere.status).toBe(403);

      const unknownRoom = `/_matrix/federation/v1/event_auth/${encodeURIComponent('!other:alice.example')}/${encodeURIComponent(String(message.event_id))}`;
      const missing = await send({
        port: running.port, method: 'GET', path: unknownRoom, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: unknownRoom }),
      });
      expect(missing.status).toBe(404);
      expect(missing.body.errcode).toBe('M_NOT_FOUND');
    } finally {
      await running.server.stop();
    }
  });

  it('refuses a read whose parameters are missing rather than guessing them', async () => {
    const { running, message } = await heldWithMessage();
    try {
      const stateUri = `/_matrix/federation/v1/state/${ROOM_PATH}`;
      const noEvent = await send({
        port: running.port, method: 'GET', path: stateUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: stateUri }),
      });
      expect(noEvent.status).toBe(400);
      expect(noEvent.body.errcode).toBe('M_MISSING_PARAM');

      const backfillUri = `/_matrix/federation/v1/backfill/${ROOM_PATH}?limit=5`;
      const noFrom = await send({
        port: running.port, method: 'GET', path: backfillUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: backfillUri }),
      });
      expect(noFrom.status).toBe(400);

      const ids = await send({
        port: running.port, method: 'GET', path: `/_matrix/federation/v1/state/${ROOM_PATH}?event_id=%24nope`, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: `/_matrix/federation/v1/state/${ROOM_PATH}?event_id=%24nope` }),
      });
      expect(ids.status).toBe(404);
      expect(message.event_id).toBeTruthy();
    } finally {
      await running.server.stop();
    }
  });
});

/** A PUT with a body, signed as the peer with that body as the signed content. */
function signedPut(input: {
  peer: ReturnType<typeof identity>;
  destination: string;
  uri: string;
  body: Record<string, unknown>;
}): string {
  return buildXMatrixAuthorization({
    origin: PEER, destination: input.destination, method: 'PUT', uri: input.uri, content: input.body,
  }, input.peer.instance);
}

describe('the membership handshake endpoints', () => {
  const ROOM_PATH = encodeURIComponent(ROOM);
  const BOB_PATH = encodeURIComponent(BOB);

  /** The event the asking server derives from a template: the template, signed and stamped. */
  function signTemplate(template: Record<string, unknown>, peer: ReturnType<typeof identity>) {
    const event = signEvent({
      room_id: template.room_id,
      type: template.type,
      sender: template.sender,
      state_key: template.state_key,
      content: template.content,
      depth: template.depth,
      prev_events: template.prev_events,
      auth_events: template.auth_events,
      origin: PEER,
      origin_server_ts: NOW - 500,
    }, { keyId: peer.keyId, privateKeyPem: peer.privateKeyPem }, PEER);
    return { ...event, event_id: computeEventId(event) } as Record<string, unknown>;
  }

  async function makeTemplate(input: {
    running: Harness;
    membership: 'join' | 'leave' | 'knock';
    userId?: string;
    versions?: string;
  }) {
    const path = input.membership === 'join' ? 'make_join' : input.membership === 'leave' ? 'make_leave' : 'make_knock';
    const uri = `/_matrix/federation/v1/${path}/${ROOM_PATH}/${encodeURIComponent(input.userId ?? BOB)}${input.versions ?? '?ver=11'}`;
    const answer = await send({
      port: input.running.port, method: 'GET', path: uri, host: SERVED,
      authorization: signedGet({ peer: input.running.peer, destination: SERVED, uri }),
    });
    return { answer, uri };
  }

  it('answers make_join with a template carrying the room\'s graph position', async () => {
    const room = heldRoom();
    const running = await harness({ events: [ room.create, room.join, room.rules ] });
    try {
      const { answer } = await makeTemplate({ running, membership: 'join' });
      expect(answer.status).toBe(200);
      expect(answer.body.room_version).toBe('11');
      expect(answer.body.event).toMatchObject({
        room_id: ROOM, type: 'm.room.member', sender: BOB, state_key: BOB, content: { membership: 'join' },
      });
      const template = answer.body.event as Record<string, unknown>;
      // The parents are the room's current extremity and the authorisers include the join rules.
      expect(template.prev_events).toEqual([ room.rules.event_id ]);
      expect(template.auth_events).toContain(room.rules.event_id);

      // A version the asking server offered but this room is not comes back as the one error that
      // names the room's version.
      const refused = await makeTemplate({ running, membership: 'join', versions: '?ver=10' });
      expect(refused.answer.status).toBe(400);
      expect(refused.answer.body).toMatchObject({ errcode: 'M_INCOMPATIBLE_ROOM_VERSION', room_version: '11' });
    } finally {
      await running.server.stop();
    }
  });

  it('accepts send_join, countersigns it, and answers with the state before it', async () => {
    const room = heldRoom();
    const running = await harness({ events: [ room.create, room.join, room.rules ] });
    try {
      const template = (await makeTemplate({ running, membership: 'join' })).answer.body.event as Record<string, unknown>;
      const join = signTemplate(template, running.peer);
      const uri = `/_matrix/federation/v2/send_join/${ROOM_PATH}/${encodeURIComponent(String(join.event_id))}`;
      const answer = await send({
        port: running.port, method: 'PUT', path: uri, host: SERVED, body: JSON.stringify(join),
        authorization: signedPut({ peer: running.peer, destination: SERVED, uri, body: join }),
      });

      expect(answer.status).toBe(200);
      // The state the joining server gets is the room before the join, and the auth chain it rests on.
      expect((answer.body.state as Record<string, unknown>[]).map(event => String(event.event_id)).sort())
        .toEqual([ room.create.event_id, room.join.event_id, room.rules.event_id ].sort());
      expect((answer.body.auth_chain as Record<string, unknown>[]).length).toBeGreaterThan(0);
      // The join comes back signed by the joining server *and* by the server that accepted it.
      const accepted = answer.body.event as Record<string, unknown>;
      expect(computeEventId(accepted)).toBe(join.event_id);
      expect(Object.keys(accepted.signatures as Record<string, unknown>).sort()).toEqual([ PEER, SERVED ].sort());
      expect(running.store.accepted).toEqual([]);
    } finally {
      await running.server.stop();
    }
  });

  it('answers make_leave and accepts send_leave for a member', async () => {
    const room = heldRoom();
    const peer = identity(PEER);
    const membership = peerJoin({ room, peer });
    const running = await harness({ events: [ room.create, room.join, room.rules, membership ] });
    try {
      // The leaving server asks for a template for one of *its* users, who is in the room.
      const { answer } = await makeTemplate({ running, membership: 'leave', userId: BOB });
      expect(answer.status).toBe(200);
      expect(answer.body.event).toMatchObject({ sender: BOB, state_key: BOB, content: { membership: 'leave' } });

      const leave = signTemplate(answer.body.event as Record<string, unknown>, running.peer);
      const uri = `/_matrix/federation/v2/send_leave/${ROOM_PATH}/${encodeURIComponent(String(leave.event_id))}`;
      const accepted = await send({
        port: running.port, method: 'PUT', path: uri, host: SERVED, body: JSON.stringify(leave),
        authorization: signedPut({ peer: running.peer, destination: SERVED, uri, body: leave }),
      });
      expect(accepted.status).toBe(200);
      // v2 answers a leave with an empty object: there is nothing for the leaving server to learn.
      expect(accepted.body).toEqual({});
    } finally {
      await running.server.stop();
    }
  });

  it('answers make_knock and accepts send_knock with the room\'s stripped state', async () => {
    const room = heldRoom({ joinRule: 'knock' });
    const running = await harness({ events: [ room.create, room.join, room.rules ] });
    try {
      const { answer } = await makeTemplate({ running, membership: 'knock' });
      expect(answer.status).toBe(200);
      expect(answer.body.event).toMatchObject({ content: { membership: 'knock' }, sender: BOB, state_key: BOB });

      const knock = signTemplate(answer.body.event as Record<string, unknown>, running.peer);
      const uri = `/_matrix/federation/v1/send_knock/${ROOM_PATH}/${encodeURIComponent(String(knock.event_id))}`;
      const accepted = await send({
        port: running.port, method: 'PUT', path: uri, host: SERVED, body: JSON.stringify(knock),
        authorization: signedPut({ peer: running.peer, destination: SERVED, uri, body: knock }),
      });
      expect(accepted.status).toBe(200);
      // What the knocking client shows: the display state, in the four fields a receiver may rely on.
      const state = accepted.body.knock_room_state as Record<string, unknown>[];
      expect(state.map(entry => entry.type)).toEqual([ 'm.room.create', 'm.room.join_rules' ]);
      expect(Object.keys(state[0]).sort()).toEqual([ 'content', 'sender', 'state_key', 'type' ]);
    } finally {
      await running.server.stop();
    }
  });

  it('countersigns an invite for one of its users, and refuses one for anybody else', async () => {
    const running = await harness();
    try {
      const invited = `@u_dave:${SERVED}`;
      const invite = signEvent({
        room_id: ROOM, type: 'm.room.member', sender: BOB, state_key: invited, origin: PEER,
        origin_server_ts: NOW - 500, content: { membership: 'invite' }, depth: 6,
        prev_events: [ '$prev' ], auth_events: [ '$create' ],
      }, { keyId: running.peer.keyId, privateKeyPem: running.peer.privateKeyPem }, PEER);
      const signed = { ...invite, event_id: computeEventId(invite) } as Record<string, unknown>;
      const uri = `/_matrix/federation/v2/invite/${ROOM_PATH}/${encodeURIComponent(String(signed.event_id))}`;
      const container = {
        room_version: '11',
        event: signed,
        invite_room_state: [ { type: 'm.room.create', state_key: '', sender: BOB, content: { room_version: '11' } } ],
      };
      const answer = await send({
        port: running.port, method: 'PUT', path: uri, host: SERVED, body: JSON.stringify(container),
        authorization: signedPut({ peer: running.peer, destination: SERVED, uri, body: container }),
      });

      expect(answer.status).toBe(200);
      const accepted = answer.body.event as Record<string, unknown>;
      expect(computeEventId(accepted)).toBe(signed.event_id);
      expect(Object.keys(accepted.signatures as Record<string, unknown>).sort()).toEqual([ PEER, SERVED ].sort());
      // No Pod is touched: the invited server does not know the room, which is the point.
      expect(running.store.accepted).toEqual([]);

      // An invite for somebody who is not one of this deployment's users is not ours to sign.
      const elsewhere = { ...signed, state_key: `@u_eve:${PEER}`, event_id: undefined } as Record<string, unknown>;
      delete elsewhere.event_id;
      const foreign = { ...elsewhere, event_id: computeEventId(elsewhere) };
      const foreignUri = `/_matrix/federation/v2/invite/${ROOM_PATH}/${encodeURIComponent(String(foreign.event_id))}`;
      const refused = await send({
        port: running.port, method: 'PUT', path: foreignUri, host: SERVED,
        body: JSON.stringify({ room_version: '11', event: foreign }),
        authorization: signedPut({ peer: running.peer, destination: SERVED, uri: foreignUri, body: { room_version: '11', event: foreign } }),
      });
      expect(refused.status).toBe(400);
      expect(refused.body.errcode).toBe('M_INVALID_PARAM');
    } finally {
      await running.server.stop();
    }
  });
});

describe('the directory query', () => {
  it('answers which room an alias names, and who else is in it', async () => {
    const room = heldRoom();
    const alias = `#lobby:${SERVED}`;
    const running = await harness({
      events: [ room.create, room.join, room.rules ],
      directory: { aliases: { [alias]: ROOM }, servers: { [ROOM]: [ SERVED, PEER ] } },
    });
    try {
      const uri = `/_matrix/federation/v1/query/directory?${new URLSearchParams({ room_alias: alias }).toString()}`;
      const answer = await send({
        port: running.port, method: 'GET', path: uri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ room_id: ROOM, servers: [ SERVED, PEER ] });
    } finally {
      await running.server.stop();
    }
  });

  it('answers 404 for an alias nobody holds, and requires the signature and the parameter', async () => {
    const running = await harness({ directory: { aliases: {} } });
    try {
      const unknownAlias = `#nope:${SERVED}`;
      const unknownUri = `/_matrix/federation/v1/query/directory?${new URLSearchParams({ room_alias: unknownAlias }).toString()}`;
      const missing = await send({
        port: running.port, method: 'GET', path: unknownUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: unknownUri }),
      });
      expect(missing.status).toBe(404);
      expect(missing.body.errcode).toBe('M_NOT_FOUND');

      // An alias of a server this deployment does not serve is not ours to answer at all.
      const elsewhereAlias = '#lobby:other.example';
      const elsewhereUri = `/_matrix/federation/v1/query/directory?${new URLSearchParams({ room_alias: elsewhereAlias }).toString()}`;
      const elsewhere = await send({
        port: running.port, method: 'GET', path: elsewhereUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: 'other.example', uri: elsewhereUri }),
      });
      expect(elsewhere.status).toBe(404);

      const unsigned = await send({ port: running.port, method: 'GET', path: unknownUri, host: SERVED });
      expect(unsigned.status).toBe(401);

      const noAlias = await send({
        port: running.port, method: 'GET', path: '/_matrix/federation/v1/query/directory', host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: '/_matrix/federation/v1/query/directory' }),
      });
      expect(noAlias.status).toBe(400);
      expect(noAlias.body.errcode).toBe('M_MISSING_PARAM');
    } finally {
      await running.server.stop();
    }
  });
});

describe('saying who is answering', () => {
  it('answers /version with the implementation, without requiring a signature', async () => {
    const running = await harness();
    try {
      const answer = await send({
        port: running.port, method: 'GET', path: '/_matrix/federation/v1/version', host: SERVED,
      });

      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ server: { name: 'xpod-test', version: '9.9.9' } });
    } finally {
      await running.server.stop();
    }
  });

  it('reports the deployment\'s own version by default, from the one place that reads it', async () => {
    // An embedding that says nothing still identifies itself truthfully rather than as `unknown`.
    const server = new ApiServer({
      port: 0,
      authMiddleware: new AuthMiddleware({
        authenticator: { canAuthenticate: () => false, authenticate: async () => ({ success: false, error: 'unused' }) },
      }),
    });
    registerFederationRoutes(server, {
      routes: { route: async () => ({ kind: 'unknown' as const }) },
      store: podStore().store,
      keys: keySourceFor(identity(PEER)),
      transactions: new InMemoryMatrixInboundTransactionStore(),
    });
    await server.start();
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('ApiServer did not bind a TCP port');
      const answer = await send({ port: address.port, method: 'GET', path: '/_matrix/federation/v1/version', host: SERVED });
      expect(answer.status).toBe(200);
      const server_ = answer.body.server as { name: string; version: string };
      expect(server_.name).toBe('xpod');
      expect(server_.version).not.toBe('unknown');
    } finally {
      await server.stop();
    }
  });
});

describe('the profile query', () => {
  it('recognises one of its own users, and publishes nothing about them yet', async () => {
    const running = await harness();
    try {
      const uri = `/_matrix/federation/v1/query/profile?${new URLSearchParams({ user_id: `@u_alice:${SERVED}` }).toString()}`;
      const answer = await send({
        port: running.port, method: 'GET', path: uri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });

      // A well-formed answer with the fields left out: Xpod has no federated profile, and an
      // unset field is omitted rather than invented (the specification allows exactly this).
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({});
    } finally {
      await running.server.stop();
    }
  });

  it('refuses a user that is not one of its own, and requires the parameter and a signature', async () => {
    const running = await harness();
    try {
      const stranger = `@u_somebody:${SERVED}`;
      const uri = `/_matrix/federation/v1/query/profile?${new URLSearchParams({ user_id: stranger }).toString()}`;
      const unknown = await send({
        port: running.port, method: 'GET', path: uri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.errcode).toBe('M_NOT_FOUND');

      // A user of another server is not this deployment's to answer about.
      const elsewhereUri = `/_matrix/federation/v1/query/profile?${new URLSearchParams({ user_id: `@u_x:${PEER}` }).toString()}`;
      const elsewhere = await send({
        port: running.port, method: 'GET', path: elsewhereUri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: PEER, uri: elsewhereUri }),
      });
      expect(elsewhere.status).toBe(404);

      const unsigned = await send({ port: running.port, method: 'GET', path: uri, host: SERVED });
      expect(unsigned.status).toBe(401);

      const noUser = await send({
        port: running.port, method: 'GET', path: '/_matrix/federation/v1/query/profile', host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri: '/_matrix/federation/v1/query/profile' }),
      });
      expect(noUser.status).toBe(400);
      expect(noUser.body.errcode).toBe('M_MISSING_PARAM');
    } finally {
      await running.server.stop();
    }
  });
});

describe('a transaction this deployment cannot write', () => {
  it('reports the Pod\'s refusal as a decision, not as an unknown failure', async () => {
    const room = heldRoom();
    const running = await harness({ events: [ room.create, room.join, room.rules ] });
    // Signed by the identity the shell verifies with, which is the one the harness minted.
    const membership = peerJoin({ room, peer: running.peer });
    try {
      // What the store throws when the routed participant has granted this deployment nothing:
      // the event cannot be written, and saying "unknown error" would invite the peer to retry
      // something that will never succeed.
      vi.spyOn(running.store.store, 'acceptReceivedEvent').mockRejectedValue(
        new MatrixError(403, 'M_FORBIDDEN', `This deployment holds no grant for ${POD}`),
      );
      const request = transaction({ peer: running.peer, destination: SERVED, txnId: 'txn-grant', pdus: [ membership ] });
      const answer = await send({
        port: running.port, method: 'PUT', path: '/_matrix/federation/v1/send/txn-grant',
        host: SERVED, authorization: request.authorization, body: request.body,
      });

      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(String(answer.body.error)).toMatch(/holds no grant/u);
    } finally {
      await running.server.stop();
    }
  });
});

describe('a failure while answering a read', () => {
  it('answers with the status the failure actually has', async () => {
    const room = heldRoom();
    const running = await harness({ events: [ room.create, room.join, room.rules ] });
    try {
      const uri = `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(String(room.join.event_id))}`;
      const ask = async () => await send({
        port: running.port, method: 'GET', path: uri, host: SERVED,
        authorization: signedGet({ peer: running.peer, destination: SERVED, uri }),
      });

      // What the store throws when this deployment holds no grant for the Pod the room is in: a
      // decision the peer should not retry, not an unknown failure it should.
      const denied = vi.spyOn(running.store.store, 'protocolEvents')
        .mockRejectedValueOnce(new MatrixError(403, 'M_FORBIDDEN', `This deployment holds no grant for ${POD}`));
      const refused = await ask();
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
      expect(String(refused.body.error)).toMatch(/holds no grant/u);
      denied.mockRestore();

      // A backend failure is ours, and a peer is right to retry it.
      const broken = vi.spyOn(running.store.store, 'protocolEvents')
        .mockRejectedValueOnce(new Error('the Pod is on fire'));
      const failed = await ask();
      expect(failed.status).toBe(500);
      expect(failed.body).toMatchObject({ errcode: 'M_UNKNOWN' });
      broken.mockRestore();

      // And with the store healthy the same question is answered.
      expect((await ask()).status).toBe(200);
    } finally {
      await running.server.stop();
    }
  });
});
