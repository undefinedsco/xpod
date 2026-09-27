import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeInboundPdu, validateInboundPdu } from '../../../../src/api/matrix/federation/inboundPdu';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import { signEvent, computeEventId } from '../../../../src/api/matrix/protocol/eventIntegrity';
import type { AuthEvent } from '../../../../src/api/matrix/protocol/authRules';

const REMOTE = 'remote.example';
const ROOM = '!r:remote.example';
const ALICE = '@u_alice:remote.example';
const BOB = '@u_bob:remote.example';
const NOW = 1_000_000;

function remoteServer(serverName = REMOTE, keyId = 'ed25519:1') {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identity = new MatrixServiceIdentity({ serverName, activeKey: { keyId, privateKeyPem }, now: () => NOW });
  const keys = parseServerKeyResponse(identity.serverKeyResponse(), { expectedServerName: serverName, now: NOW });
  const source: MatrixServerKeySource = { keysFor: async name => (name === serverName ? keys : undefined) };
  return { identity, keys, source, keyId, privateKeyPem, serverName };
}

/**
 * Events a peer would have sent before the PDU under test.
 *
 * Room v11 derives the event id from the event, so a sender does not attach one; the
 * test attaches the derived id to the prefix events so later events can reference them.
 */
function roomPrefix(server: ReturnType<typeof remoteServer>) {
  const create = withDerivedId(signEvent({
    type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: NOW - 10_000,
    content: { room_version: '11' }, prev_events: [], auth_events: [],
  }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName));
  const join = withDerivedId(signEvent({
    type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: ALICE, origin_server_ts: NOW - 9_000,
    content: { membership: 'join' }, prev_events: [ create.event_id as string ], auth_events: [ create.event_id as string ],
  }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName));
  const invite = withDerivedId(signEvent({
    type: 'm.room.member', room_id: ROOM, sender: ALICE, state_key: BOB, origin_server_ts: NOW - 8_000,
    content: { membership: 'invite' },
    prev_events: [ join.event_id as string ], auth_events: [ create.event_id as string, join.event_id as string ],
  }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName));
  const asAuth = (event: Record<string, unknown>): AuthEvent => ({
    event_id: event.event_id as string,
    type: event.type as string,
    sender: event.sender as string,
    room_id: event.room_id as string,
    content: event.content as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { state_key: event.state_key as string }),
    prev_events: event.prev_events as string[],
  });
  return { create, join, invite, auth: [ asAuth(create), asAuth(join), asAuth(invite) ] };
}

/** The received event plus the id a receiver derives from it. */
function withDerivedId(event: Record<string, unknown>): Record<string, unknown> {
  return { ...event, event_id: computeEventId(event) };
}

describe('inbound PDU checks', () => {
  it('accepts a signed PDU that the auth rules allow', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = signEvent({
      type: 'm.room.message', room_id: ROOM, sender: ALICE, origin_server_ts: NOW - 1_000,
      content: { msgtype: 'm.text', body: 'from a peer' },
      prev_events: [ prefix.invite.event_id as string ],
      auth_events: [ prefix.create.event_id as string, prefix.join.event_id as string ],
    }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName);

    const result = await validateInboundPdu(pdu, { keys: server.source, authEvents: prefix.auth, now: () => NOW });
    expect(result.outcome).toBe('accepted');
    expect(result.eventId).toBe(computeEventId(pdu as Record<string, unknown>));
    expect(result.redacted).toBe(false);
    expect(result.event).toMatchObject({ type: 'm.room.message', content: { body: 'from a peer' } });
  });

  it('drops a malformed PDU before looking at anything else', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const missingSender = await validateInboundPdu({ type: 'm.room.message', room_id: ROOM, content: {} },
      { keys: server.source, authEvents: prefix.auth });
    expect(missingSender).toEqual({
      outcome: 'rejected',
      stage: 'structure',
      reason: expect.stringContaining('no usable sender'),
      redacted: false,
    });
    const badEvents = await validateInboundPdu({
      type: 'm.room.message', room_id: ROOM, sender: ALICE, content: {}, origin_server_ts: NOW,
      auth_events: 'nope', prev_events: [],
    }, { keys: server.source, authEvents: prefix.auth });
    expect(badEvents.reason).toMatch(/no usable auth_events/u);
  });

  it('drops an event whose signature does not verify, including a forged sender', async () => {
    const server = remoteServer();
    const attacker = remoteServer('attacker.example');
    const prefix = roomPrefix(server);
    // Signed by the attacker but claiming to come from the remote server.
    const forged = signEvent({
      type: 'm.room.message', room_id: ROOM, sender: ALICE, origin_server_ts: NOW - 1_000, content: { body: 'forged' },
      prev_events: [ prefix.invite.event_id as string ], auth_events: [ prefix.create.event_id as string, prefix.join.event_id as string ],
    }, { keyId: attacker.keyId, privateKeyPem: attacker.privateKeyPem }, REMOTE);
    const rejected = await validateInboundPdu(forged, { keys: server.source, authEvents: prefix.auth, now: () => NOW });
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.reason).toMatch(/v11-2/u);

    // And a server we hold no keys for cannot be verified at all.
    const unknown = await validateInboundPdu(forged, {
      keys: { keysFor: async () => undefined }, authEvents: prefix.auth, now: () => NOW,
    });
    expect(unknown.reason).toMatch(/no verify keys available/u);
  });

  it('redacts an event whose content hash does not match instead of dropping it', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const signed = signEvent({
      type: 'm.room.message', room_id: ROOM, sender: ALICE, origin_server_ts: NOW - 1_000,
      content: { msgtype: 'm.text', body: 'original' },
      prev_events: [ prefix.invite.event_id as string ],
      auth_events: [ prefix.create.event_id as string, prefix.join.event_id as string ],
    }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName);

    // The signature still verifies because it covers the redacted event, so only the
    // content hash catches this edit.
    const tampered = { ...signed, content: { msgtype: 'm.text', body: 'tampered' } };
    const result = await validateInboundPdu(tampered, { keys: server.source, authEvents: prefix.auth, now: () => NOW });
    expect(result.outcome).toBe('accepted');
    expect(result.redacted).toBe(true);
    // The event that would be stored carries no untrusted content.
    expect((result.event as Record<string, unknown>).content).toEqual({});
    expect(result.eventId).toBe(computeEventId(tampered as Record<string, unknown>));
  });

  it('defers an event whose auth events are not available yet', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    const pdu = signEvent({
      type: 'm.room.message', room_id: ROOM, sender: ALICE, origin_server_ts: NOW - 1_000, content: { body: 'hi' },
      prev_events: [ prefix.invite.event_id as string ],
      auth_events: [ prefix.create.event_id as string, prefix.join.event_id as string ],
    }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName);

    // The room's join is missing, so the sender's membership cannot be judged.
    const result = await validateInboundPdu(pdu, { keys: server.source, authEvents: [ prefix.auth[0] ], now: () => NOW });
    expect(result.outcome).toBe('deferred');
    expect(result.reason).toMatch(/not available yet/u);
    expect(result.eventId).toBe(computeEventId(pdu as Record<string, unknown>));
  });

  it('rejects an event the authorisation rules refuse', async () => {
    const server = remoteServer();
    const prefix = roomPrefix(server);
    // BOB was invited, not joined, and joins are not what this event is claiming.
    const pdu = signEvent({
      type: 'm.room.message', room_id: ROOM, sender: BOB, origin_server_ts: NOW - 1_000, content: { body: 'not joined' },
      prev_events: [ prefix.invite.event_id as string ],
      auth_events: [ prefix.create.event_id as string, prefix.invite.event_id as string ],
    }, { keyId: server.keyId, privateKeyPem: server.privateKeyPem }, server.serverName);
    const result = await validateInboundPdu(pdu, { keys: server.source, authEvents: prefix.auth, now: () => NOW });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toMatch(/v11-4: v11-5/u);
  });

  it('accepts the plain and the historical tuple form of event id lists', () => {
    const base = {
      type: 'm.room.message', room_id: ROOM, sender: ALICE, content: {}, origin_server_ts: NOW,
      prev_events: [ '$a' ], auth_events: [ '$create' ],
    };
    expect(normalizeInboundPdu(base).authEventIds).toEqual([ '$create' ]);
    // Synapse has sent `[id, {sha256}]` for v4+; the hash is redundant with the id.
    const tuples = { ...base, prev_events: [ [ '$a', { sha256: 'x' } ] ], auth_events: [ [ '$create', { sha256: 'y' } ] ] };
    expect(normalizeInboundPdu(tuples).event?.prev_events).toEqual([ '$a' ]);
    expect(normalizeInboundPdu(tuples).authEventIds).toEqual([ '$create' ]);
    expect(normalizeInboundPdu({ ...base, prev_events: [ 7 ] }).event).toBeUndefined();
  });
});
