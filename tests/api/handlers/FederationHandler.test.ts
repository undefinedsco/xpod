import { request as httpRequest } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiServer } from '../../../src/api/ApiServer';
import { AuthMiddleware } from '../../../src/api/middleware/AuthMiddleware';
import { registerFederationRoutes } from '../../../src/api/handlers/FederationHandler';
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
function podStore(initial: readonly Record<string, unknown>[] = []) {
  const rooms = new Map<string, Record<string, unknown>[]>();
  for (const event of initial) {
    const roomId = String(event.room_id);
    rooms.set(roomId, [ ...(rooms.get(roomId) ?? []), event ]);
  }
  const accepted: Record<string, unknown>[] = [];
  const contexts: MatrixStoreContext[] = [];
  const store: FederationPodStore = {
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
function heldRoom() {
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
    content: { join_rule: 'public' }, depth: 3,
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
  sent: string[];
}

async function harness(options: {
  events?: readonly Record<string, unknown>[];
  served?: string[];
  /** The deployment's answer to "who is this written as"; recorded so the test can see it used. */
  contextFor?: (route: MatrixServerRoute) => MatrixStoreContext;
} = {}): Promise<Harness> {
  const store = podStore(options.events ?? []);
  const peer = identity(PEER);
  const server = new ApiServer({
    port: 0,
    authMiddleware: new AuthMiddleware({
      authenticator: { canAuthenticate: () => false, authenticate: async () => ({ success: false, error: 'unused' }) },
    }),
  });
  const served = options.served ?? [ SERVED ];
  const sent: string[] = [];
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
    ...(options.contextFor === undefined ? {} : { contextFor: options.contextFor }),
    fetchAuthChain: async ({ eventId }) => {
      sent.push(eventId);
      return undefined;
    },
    now: () => NOW,
  });
  await server.start();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ApiServer did not bind a TCP port');
  return { server, port: address.port, store, peer, sent };
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
