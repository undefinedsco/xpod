import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { computeEventId, signEvent } from '../../../src/api/matrix/protocol/eventIntegrity';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../src/api/matrix/federation/serverKeys';
import { validateInboundPdu } from '../../../src/api/matrix/federation/inboundPdu';
import { getProtocolMetadata } from '../../../src/api/protocol-metadata';
import type { AuthEvent } from '../../../src/api/matrix/protocol/authRules';
import type { MatrixEventRecord } from '../../../src/api/matrix/types';

const REMOTE = 'bob.example';
const REMOTE_BOB = '@u_remote_bob:bob.example';
const NOW = 2_000_000;

function localIdentity() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName: 'example.test',
    activeKey: { keyId: 'ed25519:local', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

function remoteServer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const identity = new MatrixServiceIdentity({ serverName: REMOTE, activeKey: { keyId: 'ed25519:remote', privateKeyPem }, now: () => NOW });
  const keys = parseServerKeyResponse(identity.serverKeyResponse(), { expectedServerName: REMOTE, now: NOW });
  const source: MatrixServerKeySource = { keysFor: async name => (name === REMOTE ? keys : undefined) };
  return {
    source,
    key: { keyId: 'ed25519:remote', privateKeyPem },
    sign: (event: Record<string, unknown>) => signEvent(event, { keyId: 'ed25519:remote', privateKeyPem }, REMOTE),
  };
}

function asAuth(event: MatrixEventRecord): AuthEvent {
  return {
    event_id: event.eventId,
    type: event.type,
    sender: event.sender,
    room_id: event.roomId,
    content: event.content,
    ...(event.stateKey === undefined ? {} : { state_key: event.stateKey }),
    prev_events: ((event.event as Record<string, unknown> | undefined)?.prev_events ?? []) as string[],
  };
}

function storedEvent(rows: Map<unknown, any[]>, eventId: string) {
  const row = rows.get(messageResource as never)!
    .find((item: any) => (getProtocolMetadata(item.metadata, 'matrix')?.event as Record<string, unknown> | undefined)?.event_id === eventId);
  expect(row, `the row storing ${eventId}`).toBeDefined();
  return { row, event: getProtocolMetadata(row.metadata, 'matrix')!.event as Record<string, unknown> };
}

async function roomWithInvitedRemote() {
  const harness = matrixHarness({ serviceIdentity: localIdentity() });
  const room = await harness.store.createRoom({ invite: [ REMOTE_BOB ] }, harness.context);
  const state = await harness.store.currentState(room.roomId, harness.context);
  const create = state.get('m.room.create')!;
  const invite = state.get('m.room.member', REMOTE_BOB)!;
  return { ...harness, room, create, invite };
}

describe('received events', () => {
  it('stores the event verbatim without adding this server\'s signature', async () => {
    const { store, context, rows, room, invite } = await roomWithInvitedRemote();
    const remote = remoteServer();
    const received = remote.sign({
      type: 'm.room.message', room_id: room.roomId, sender: REMOTE_BOB, origin_server_ts: NOW - 100,
      content: { msgtype: 'm.text', body: 'from the peer' },
      prev_events: [ invite.eventId ], auth_events: [ invite.eventId ],
    });
    const record = await store.acceptReceivedEvent({ event: received as Record<string, unknown>, context });

    expect(record.eventId).toBe(computeEventId(received as Record<string, unknown>));
    const stored = storedEvent(rows, record.eventId).event;
    // Nothing is re-signed: the peer's signature and hashes are exactly as received,
    // and the only addition is the id this server derived.
    expect(Object.keys(stored.signatures as Record<string, unknown>)).toEqual([ REMOTE ]);
    expect(stored.hashes).toEqual(received.hashes);
    expect(stored).toEqual({ ...received, event_id: record.eventId });
    expect(getProtocolMetadata(storedEvent(rows, record.eventId).row.metadata, 'matrix')!.received).toBe(true);
  });

  it('is idempotent, so a replayed transaction does not duplicate the event', async () => {
    const { store, context, rows, room, invite } = await roomWithInvitedRemote();
    const remote = remoteServer();
    const received = remote.sign({
      type: 'm.room.message', room_id: room.roomId, sender: REMOTE_BOB, origin_server_ts: NOW - 100,
      content: { body: 'once' }, prev_events: [ invite.eventId ], auth_events: [ invite.eventId ],
    });
    const first = await store.acceptReceivedEvent({ event: received as Record<string, unknown>, context });
    const second = await store.acceptReceivedEvent({ event: received as Record<string, unknown>, context });
    expect(second.eventId).toBe(first.eventId);
    expect(rows.get(messageResource as never)!.filter((row: any) => row.id === first.resourceId)).toHaveLength(1);
  });

  it('does not attribute a received event to the Pod owner', async () => {
    const { store, context, room, invite } = await roomWithInvitedRemote();
    const remote = remoteServer();
    const received = remote.sign({
      type: 'm.room.message', room_id: room.roomId, sender: REMOTE_BOB, origin_server_ts: NOW - 100,
      content: { body: 'from the peer' }, prev_events: [ invite.eventId ], auth_events: [ invite.eventId ],
    });
    const record = await store.acceptReceivedEvent({ event: received as Record<string, unknown>, context });
    // The remote author's WebID is not derivable from their MXID, so it stays unknown
    // rather than becoming the Pod owner's WebID.
    expect(record.senderWebId).toBeUndefined();
  });

  it('joins the room timeline and the event graph', async () => {
    const { store, context, rows, room, invite } = await roomWithInvitedRemote();
    const remote = remoteServer();
    const received = remote.sign({
      type: 'm.room.message', room_id: room.roomId, sender: REMOTE_BOB, origin_server_ts: NOW - 100,
      content: { body: 'peer message' }, prev_events: [ invite.eventId ], auth_events: [ invite.eventId ],
    });
    const record = await store.acceptReceivedEvent({ event: received as Record<string, unknown>, context });

    const page = await store.listMessages(room.roomId, context, { limit: 50 });
    expect(page.chunk.find(event => event.event_id === record.eventId)?.content.body).toBe('peer message');

    // The next local event follows the received one: the writer's graph position came
    // from the Pod, not from what this server produced itself.
    const local = await store.sendEvent(room.roomId, 'm.room.message', 'after-peer', { body: 'local reply' }, context);
    expect(storedEvent(rows, local.eventId).event.prev_events).toEqual([ record.eventId ]);
  });

  it('accepts a peer join through the inbound pipeline and shows it in the room state', async () => {
    const { store, context, room, create, invite } = await roomWithInvitedRemote();
    const remote = remoteServer();
    const join = remote.sign({
      type: 'm.room.member', room_id: room.roomId, sender: REMOTE_BOB, state_key: REMOTE_BOB,
      origin_server_ts: NOW - 50, content: { membership: 'join' },
      prev_events: [ invite.eventId ], auth_events: [ create.eventId, invite.eventId ],
    });

    const decision = await validateInboundPdu(join, {
      keys: remote.source, authEvents: [ asAuth(create), asAuth(invite) ], now: () => NOW,
    });
    expect(decision.outcome).toBe('accepted');
    const record = await store.acceptReceivedEvent({ event: decision.event!, context });
    expect(record.eventId).toBe(computeEventId(join as Record<string, unknown>));

    const members = await store.getMembers(room.roomId, context);
    expect(members.find(event => event.state_key === REMOTE_BOB)?.content.membership).toBe('join');
  });
});
