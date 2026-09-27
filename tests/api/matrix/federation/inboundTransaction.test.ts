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
  const asAuth = (event: Record<string, unknown>): AuthEvent => ({
    event_id: event.event_id as string,
    type: event.type as string,
    sender: event.sender as string,
    room_id: event.room_id as string,
    content: event.content as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { state_key: event.state_key as string }),
  });
  return { create, join, auth: [ asAuth(create), asAuth(join) ] };
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
