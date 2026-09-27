import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMatrixInboundTransactionStore,
  fingerprintPdus,
  handleInboundTransaction,
  referencedAuthEventIds,
} from '../../../../src/api/matrix/federation/inboundTransaction';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import { computeEventId, signEvent } from '../../../../src/api/matrix/protocol/eventIntegrity';
import type { AuthEvent } from '../../../../src/api/matrix/protocol/authRules';

const REMOTE = 'remote.example';
const ROOM = '!r:remote.example';
const ALICE = '@u_alice:remote.example';
const BOB = '@u_bob:remote.example';
const NOW = 3_000_000;

function remoteServer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identity = new MatrixServiceIdentity({ serverName: REMOTE, activeKey: { keyId: 'ed25519:1', privateKeyPem }, now: () => NOW });
  const keys = parseServerKeyResponse(identity.serverKeyResponse(), { expectedServerName: REMOTE, now: NOW });
  const source: MatrixServerKeySource = { keysFor: async name => (name === REMOTE ? keys : undefined) };
  const sign = (event: Record<string, unknown>) => signEvent(event, { keyId: 'ed25519:1', privateKeyPem }, REMOTE);
  return { source, sign };
}

/** The room prefix a peer sends before the events under test. */
function roomPrefix(server: ReturnType<typeof remoteServer>) {
  const withId = (event: Record<string, unknown>) => ({ ...event, event_id: computeEventId(event) });
  const create = withId(server.sign({
    type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 10_000,
    content: { room_version: '11' }, prev_events: [], auth_events: [],
  }));
  const join = withId(server.sign({
    type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: ALICE, origin_server_ts: NOW - 9_000,
    content: { membership: 'join' }, prev_events: [ create.event_id ], auth_events: [ create.event_id ],
  }));
  return { create, join, auth: [ asAuth(create), asAuth(join) ] };
}

function asAuth(event: Record<string, unknown>): AuthEvent {
  return {
    event_id: event.event_id as string,
    type: event.type as string,
    sender: event.sender as string,
    room_id: event.room_id as string,
    content: event.content as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { state_key: event.state_key as string }),
  };
}

/** An invite from the joined member, whose auth events are the create and their own join. */
function invite(server: ReturnType<typeof remoteServer>, prefix: ReturnType<typeof roomPrefix>) {
  return server.sign({
    type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: BOB, origin_server_ts: NOW - 500,
    content: { membership: 'invite' },
    prev_events: [ prefix.join.event_id as string ],
    auth_events: [ prefix.create.event_id as string, prefix.join.event_id as string ],
  });
}

function message(server: ReturnType<typeof remoteServer>, prefix: ReturnType<typeof roomPrefix>, body: string) {
  return server.sign({
    type: 'm.room.message', room_id: ROOM, sender: ALICE, origin_server_ts: NOW - 1_000, content: { body },
    prev_events: [ prefix.join.event_id as string ], auth_events: [ prefix.create.event_id as string, prefix.join.event_id as string ],
  });
}

function handler(server: ReturnType<typeof remoteServer>, prefix: ReturnType<typeof roomPrefix>, pdus: readonly unknown[]) {
  const store = new InMemoryMatrixInboundTransactionStore();
  const acceptEvent = vi.fn(async (_event: Record<string, unknown>) => undefined);
  return {
    store,
    acceptEvent,
    run: () => handleInboundTransaction({
      scope: 'https://pod.example/alice/', origin: REMOTE, transactionId: 'txn-1', pdus,
      store, keys: server.source,
      resolveAuthEvents: async (ids: readonly string[]) => prefix.auth.filter(event => ids.includes(event.event_id ?? '')),
      acceptEvent,
      now: () => NOW,
    }),
  };
}

describe('inbound transactions', () => {
  it('accepts a transaction, persists what passed and answers per PDU', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = message(server, prefix, 'hello');
    const { run, acceptEvent } = handler(server, prefix, [ pdu ]);

    const response = await run();
    expect(Object.keys(response.pdus)).toEqual([ computeEventId(pdu as Record<string, unknown>) ]);
    expect(response.pdus[Object.keys(response.pdus)[0]]).toEqual({});
    expect(acceptEvent).toHaveBeenCalledTimes(1);
    expect(acceptEvent.mock.calls[0][0]).toMatchObject({ type: 'm.room.message', content: { body: 'hello' } });
  });

  it('answers a replay from the first attempt without processing it twice', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = message(server, prefix, 'hello');
    const { run, acceptEvent } = handler(server, prefix, [ pdu ]);

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(acceptEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps the first record when a retry carries different PDUs', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const first = message(server, prefix, 'first payload');
    const other = message(server, prefix, 'different payload');
    const store = new InMemoryMatrixInboundTransactionStore();
    const acceptEvent = vi.fn(async (_event: Record<string, unknown>) => undefined);
    const run = (pdus: readonly unknown[]) => handleInboundTransaction({
      scope: 'scope', origin: REMOTE, transactionId: 'txn-conflict', pdus, store, keys: server.source,
      resolveAuthEvents: async (ids: readonly string[]) => prefix.auth.filter(event => ids.includes(event.event_id ?? '')),
      acceptEvent, now: () => NOW,
    });

    const response = await run([ first ]);
    const replay = await run([ other ]);
    expect(replay).toEqual(response);
    expect(acceptEvent).toHaveBeenCalledTimes(1);
    const record = await store.find('scope', { origin: REMOTE, transactionId: 'txn-conflict' });
    expect(record?.payloadFingerprint).toBe(fingerprintPdus([ first ]));
    expect(record?.conflictAt).toBeDefined();
  });

  it('fetches the auth chain from the sender and accepts what it could not authorise', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = invite(server, prefix);
    const store = new InMemoryMatrixInboundTransactionStore();
    // The receiver only knows what it has stored, so the first look finds nothing.
    const accepted: Record<string, unknown>[] = [];
    const fetchAuthChain = vi.fn(async () => [ prefix.create, prefix.join ]);

    const response = await handleInboundTransaction({
      scope: 'scope', origin: REMOTE, transactionId: 'txn-fetch', pdus: [ pdu ], store, keys: server.source,
      resolveAuthEvents: async (ids: readonly string[]) => accepted.filter(event => ids.includes(String(event.event_id))).map(asAuth),
      acceptEvent: async event => { accepted.push(event); },
      fetchAuthChain,
      now: () => NOW,
    });

    expect(response.pdus).toEqual({ [ computeEventId(pdu as Record<string, unknown>) ]: {} });
    // The chain arrived oldest-first and was stored before the event that depends on it.
    expect(accepted.map(event => event.type)).toEqual([ 'm.room.create', 'm.room.member', 'm.room.member' ]);
    // The chain events keep the ids they arrived with; the invite is stored as received and
    // the receiver derives its id from the content.
    expect(accepted.slice(0, 2).map(event => event.event_id)).toEqual([ prefix.create.event_id, prefix.join.event_id ]);
    expect(accepted[2]).toMatchObject({ type: 'm.room.member', state_key: BOB, content: { membership: 'invite' } });
    expect(fetchAuthChain).toHaveBeenCalledWith({
      eventId: computeEventId(pdu as Record<string, unknown>), pdu, origin: REMOTE,
    });
  });

  it('reports a PDU whose auth events are missing when it cannot fetch them', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = invite(server, prefix);
    const store = new InMemoryMatrixInboundTransactionStore();
    const acceptEvent = vi.fn(async (_event: Record<string, unknown>) => undefined);

    const response = await handleInboundTransaction({
      scope: 'scope', origin: REMOTE, transactionId: 'txn-no-fetch', pdus: [ pdu ], store, keys: server.source,
      resolveAuthEvents: async () => [],
      acceptEvent,
      now: () => NOW,
    });

    // Deferred is reported, not silently accepted, and nothing was written.
    expect(String(Object.values(response.pdus)[0].error)).toMatch(/v11-4/u);
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('keeps the PDU deferred when the fetched chain does not authorise it', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = invite(server, prefix);
    const store = new InMemoryMatrixInboundTransactionStore();
    const accepted: Record<string, unknown>[] = [];

    const response = await handleInboundTransaction({
      scope: 'scope', origin: REMOTE, transactionId: 'txn-bad-chain', pdus: [ pdu ], store, keys: server.source,
      // The peer answers with an event that has nothing to do with this room.
      resolveAuthEvents: async (ids: readonly string[]) => accepted.filter(event => ids.includes(String(event.event_id))).map(asAuth),
      acceptEvent: async event => { accepted.push(event); },
      fetchAuthChain: async () => [ server.sign({ type: 'm.room.create', room_id: '!other:remote.example', sender: ALICE, state_key: '', origin_server_ts: NOW - 9_000, content: { room_version: '11' }, prev_events: [], auth_events: [] }) ],
      now: () => NOW,
    });

    expect(String(Object.values(response.pdus)[0].error)).toMatch(/v11-4/u);
    // The unrelated event was stored (it is a valid event of another room) but proved nothing.
    expect(accepted.map(event => event.type)).toEqual([ 'm.room.create' ]);
  });

  it('keeps the PDU deferred when the sender cannot be reached for the chain', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = invite(server, prefix);
    const store = new InMemoryMatrixInboundTransactionStore();

    const response = await handleInboundTransaction({
      scope: 'scope', origin: REMOTE, transactionId: 'txn-unreachable', pdus: [ pdu ], store, keys: server.source,
      resolveAuthEvents: async () => [],
      acceptEvent: async () => undefined,
      fetchAuthChain: async () => { throw new Error('connect ECONNREFUSED'); },
      now: () => NOW,
    });

    // An unreachable peer leaves the event deferred so the sender can retry the transaction.
    expect(String(Object.values(response.pdus)[0].error)).toMatch(/v11-4/u);
  });

  it('reports a PDU that cannot be verified or authorised as an error entry', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const forged = { ...message(server, prefix, 'forged'), signatures: { [REMOTE]: { 'ed25519:1': 'not-a-signature' } } };
    const { run } = handler(server, prefix, [ forged ]);

    const response = await run();
    const entry = Object.values(response.pdus)[0];
    expect(entry).toHaveProperty('error');
    expect(String(entry.error)).toMatch(/v11-2/u);
  });

  it('asks the sender to retry while a transaction is still being written', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = message(server, prefix, 'hello');
    const store = new InMemoryMatrixInboundTransactionStore();
    // A first attempt reserved the key and has not finished writing yet.
    await store.reserve('scope', {
      origin: REMOTE, transactionId: 'txn-pending', payloadFingerprint: fingerprintPdus([ pdu ]),
      receivedAt: new Date(NOW).toISOString(),
    });

    await expect(handleInboundTransaction({
      scope: 'scope', origin: REMOTE, transactionId: 'txn-pending', pdus: [ pdu ], store, keys: server.source,
      resolveAuthEvents: async () => prefix.auth, acceptEvent: async () => undefined, now: () => NOW,
    })).rejects.toMatchObject({ status: 503 });
  });

  it('reads auth event ids from both list forms and fingerprints payloads stably', () => {
    expect(referencedAuthEventIds({ auth_events: [ '$a', [ '$b', { sha256: 'x' } ] ] })).toEqual([ '$a', '$b' ]);
    expect(referencedAuthEventIds({ auth_events: 'nope' })).toEqual([]);
    expect(fingerprintPdus([ { a: 1, b: 2 } ])).toBe(fingerprintPdus([ { b: 2, a: 1 } ]));
    expect(fingerprintPdus([ { a: 1 } ])).not.toBe(fingerprintPdus([ { a: 2 } ]));
    // A payload canonical JSON rejects still gets a fingerprint rather than throwing.
    expect(fingerprintPdus([ { a: undefined } ])).toBeTruthy();
  });

  it('does not confuse transactions from different origins', async () => {
    const store = new InMemoryMatrixInboundTransactionStore();
    const at = new Date(NOW).toISOString();
    const first = await store.reserve('scope', { origin: 'a.example', transactionId: 'txn', payloadFingerprint: 'x', receivedAt: at });
    const second = await store.reserve('scope', { origin: 'b.example', transactionId: 'txn', payloadFingerprint: 'y', receivedAt: at });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    const replay = await store.reserve('scope', { origin: 'a.example', transactionId: 'txn', payloadFingerprint: 'x', receivedAt: at });
    expect(replay.created).toBe(false);
    expect(await store.find('scope', { origin: 'other.example', transactionId: 'txn' })).toBeUndefined();
  });
});

describe('a transaction that did not finish', () => {
  it('releases the reservation, so a retry tries again instead of meeting an unfinished transaction', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const store = new InMemoryMatrixInboundTransactionStore();
    const pdu = message(server, prefix, 'first attempt');
    let failing = true;
    const acceptEvent = vi.fn(async () => {
      if (failing) throw new Error('the Pod refused the write');
    });
    const run = () => handleInboundTransaction({
      scope: 'https://pod.example/alice/', origin: REMOTE, transactionId: 'txn-1', pdus: [ pdu ],
      store, keys: server.source, resolveAuthEvents: async () => prefix.auth, acceptEvent, now: () => NOW,
    });

    await expect(run()).rejects.toThrow(/refused the write/u);
    // The reservation is gone, so the retry is processed rather than answered as "still being
    // processed" — which is what a sender would otherwise meet for ever.
    failing = false;
    await expect(run()).resolves.toMatchObject({ pdus: { [String(computeEventId(pdu))]: {} } });
    expect(acceptEvent).toHaveBeenCalledTimes(2);

    // And a later replay is answered from the record the successful attempt left.
    await expect(run()).resolves.toMatchObject({ pdus: { [String(computeEventId(pdu))]: {} } });
    expect(acceptEvent).toHaveBeenCalledTimes(2);
  });

  it('releases the reservation when the response could not be recorded either', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const store = new InMemoryMatrixInboundTransactionStore();
    const complete = vi.spyOn(store, 'complete').mockRejectedValueOnce(new Error('the record store is down'));
    const pdu = message(server, prefix, 'unrecordable');

    await expect(handleInboundTransaction({
      scope: 'https://pod.example/alice/', origin: REMOTE, transactionId: 'txn-2', pdus: [ pdu ],
      store, keys: server.source, resolveAuthEvents: async () => prefix.auth, acceptEvent: async () => undefined, now: () => NOW,
    })).rejects.toThrow(/record store is down/u);

    // Nothing is left behind, so the retry completes normally.
    complete.mockRestore();
    await expect(handleInboundTransaction({
      scope: 'https://pod.example/alice/', origin: REMOTE, transactionId: 'txn-2', pdus: [ pdu ],
      store, keys: server.source, resolveAuthEvents: async () => prefix.auth, acceptEvent: async () => undefined, now: () => NOW,
    })).resolves.toMatchObject({ pdus: { [String(computeEventId(pdu))]: {} } });
  });

  it('still answers a transaction that is genuinely in progress with "retry"', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const store = new InMemoryMatrixInboundTransactionStore();
    const pdu = message(server, prefix, 'in flight');
    // A first attempt that has reserved but not finished: nothing releases it here, which is the
    // state a concurrent duplicate sees.
    await store.reserve('https://pod.example/alice/', {
      origin: REMOTE, transactionId: 'txn-3', payloadFingerprint: fingerprintPdus([ pdu ]), receivedAt: new Date(NOW).toISOString(),
    });

    await expect(handleInboundTransaction({
      scope: 'https://pod.example/alice/', origin: REMOTE, transactionId: 'txn-3', pdus: [ pdu ],
      store, keys: server.source, resolveAuthEvents: async () => prefix.auth, acceptEvent: async () => undefined, now: () => NOW,
    })).rejects.toThrow(/still being processed/u);
  });
});
