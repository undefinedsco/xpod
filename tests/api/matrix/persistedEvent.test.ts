import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chatResource, messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { getProtocolMetadata, withProtocolMetadata } from '../../../src/api/protocol-metadata';
import { computeContentHash, computeEventId, decodeVerifyKey, encodeUnpaddedBase64 } from '../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import {
  buildPersistedEvent,
  readPersistedEvent,
  verifyPersistedEvent,
  verifyPersistedEventSignature,
} from '../../../src/api/matrix/persistedEvent';

function identity() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    service: new MatrixServiceIdentity({
      serverName: 'example.test',
      activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    }),
    ...(() => {
      const { publicKey } = generateKeyPairSync('ed25519');
      return { unused: publicKey };
    })(),
  };
}

/** Every protocol event the room has written, in the order the harness holds them. */
function storedEvents(rows: Map<unknown, any[]>) {
  return rows.get(messageResource as never)!
    .map((row: any) => readPersistedEvent(getProtocolMetadata(row.metadata, 'matrix')!))
    .filter((event): event is NonNullable<typeof event> => event !== undefined);
}

function storedEvent(rows: Map<unknown, any[]>, eventId: string) {
  const row = rows.get(messageResource as never)!
    .find((item: any) => (getProtocolMetadata(item.metadata, 'matrix')?.event as any)?.event_id === eventId);
  expect(row, 'the row that stores this event').toBeDefined();
  return { row, event: readPersistedEvent(getProtocolMetadata(row.metadata, 'matrix')!)! };
}

describe('persisted protocol events', () => {
  it('stores a signed event that verifies from the Pod alone', async () => {
    const { service } = identity();
    const { store, context, rows } = matrixHarness({ serviceIdentity: service });
    const room = await store.createRoom({}, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'signed-1', { msgtype: 'm.text', body: 'verifiable' }, context);

    const { event } = storedEvent(rows, sent.eventId);
    // The event carries the protocol facts the Solid Chat view cannot express.
    expect(event).toMatchObject({ room_id: room.roomId, type: 'm.room.message', content: { body: 'verifiable' } });
    expect(event.signatures).toHaveProperty('example.test');
    expect(event.hashes).toHaveProperty('sha256');

    // Self-check: the id and the content hash are re-derived from the event.
    const check = verifyPersistedEvent(event);
    expect(check).toEqual({ eventIdMatches: true, contentHashMatches: true, signed: true });
    expect(computeEventId(event)).toBe(sent.eventId);
    expect(encodeUnpaddedBase64(computeContentHash(event))).toBe(event.hashes!.sha256);

    // And the signature verifies against the key the deployment publishes.
    const published = service.serverKeyResponse();
    expect(verifyPersistedEventSignature(event, 'example.test', 'ed25519:1',
      decodeVerifyKey(published.verify_keys['ed25519:1'].key))).toBe(true);
  });

  it('reports what an edit to a stored event breaks, layer by layer', async () => {
    const { service } = identity();
    const { store, context, rows } = matrixHarness({ serviceIdentity: service });
    const room = await store.createRoom({}, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'signed-2', { msgtype: 'm.text', body: 'original' }, context);
    const { event } = storedEvent(rows, sent.eventId);
    const verifyKey = decodeVerifyKey(service.serverKeyResponse().verify_keys['ed25519:1'].key);

    // A message redacts to `{}`, so its body is outside both the id and the
    // signature. The content hash is the only check that covers the payload, and
    // that is precisely why it exists: without it the edit would be invisible.
    const editedContent = { ...event, content: { msgtype: 'm.text', body: 'edited' } };
    expect(verifyPersistedEvent(editedContent).contentHashMatches).toBe(false);
    expect(verifyPersistedEvent(editedContent).eventIdMatches).toBe(true);
    expect(verifyPersistedEventSignature(editedContent, 'example.test', 'ed25519:1', verifyKey)).toBe(true);

    // A field that survives redaction is covered by all three checks instead.
    const editedSender = { ...event, sender: '@mallory:example.test' };
    const senderCheck = verifyPersistedEvent(editedSender);
    expect(senderCheck.eventIdMatches).toBe(false);
    expect(senderCheck.contentHashMatches).toBe(false);
    expect(verifyPersistedEventSignature(editedSender, 'example.test', 'ed25519:1', verifyKey)).toBe(false);
  });

  it('still stores a content-derived identity when the deployment cannot sign', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'unsigned-1', { body: 'no identity' }, context);
    const { event } = storedEvent(rows, sent.eventId);

    // Without a signing identity the event is still self-consistent and
    // identifiable; it simply carries no signature, which the check reports.
    expect(verifyPersistedEvent(event)).toEqual({ eventIdMatches: true, contentHashMatches: true, signed: false });
    expect(event.signatures).toBeUndefined();
  });

  it('stores the graph a reader needs to walk the room from the Pod', async () => {
    const { service } = identity();
    const { store, context, rows } = matrixHarness({ serviceIdentity: service });
    const room = await store.createRoom({ name: 'Graph' }, context);
    const agents = await store.setState(room.roomId, 'm.room.power_levels', '', { users: {} }, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'graph-1', { body: 'walk me' }, context);

    const all = storedEvents(rows);
    const find = (type: string) => all.find(event => event.type === type)!;

    // The create event is the root: no parents, nothing authorising it, depth 1.
    const root = find('m.room.create');
    expect(root).toMatchObject({ prev_events: [], auth_events: [], depth: 1 });

    // The creator's join is authorised by the create event and follows it.
    const join = find('m.room.member');
    expect(join).toMatchObject({ prev_events: [ root.event_id ], auth_events: [ root.event_id ], depth: 2 });

    // A message is authorised by create + the current power levels + the sender's
    // membership, and it follows the events that had no child yet.
    const message = storedEvent(rows, sent.eventId).event;
    expect(message.auth_events).toEqual([ root.event_id, agents.eventId, join.event_id ]);
    // The power-levels event was the only event without a child when the message was
    // appended, so the message follows it and is one deeper.
    expect(message.prev_events).toEqual([ agents.eventId ]);
    expect(message.depth).toBe(storedEvent(rows, agents.eventId).event.depth! + 1);

    // Every reference resolves inside this room: that is what makes the state the
    // event was authorised against reachable without a second store.
    const known = new Set(all.map(event => event.event_id));
    for (const event of all) {
      for (const reference of [ ...(event.prev_events ?? []), ...(event.auth_events ?? []) ]) {
        expect(known, `${String(event.event_id)} references ${String(reference)}`).toContain(reference);
      }
    }
  });

  it('chains the room setup events, invites included', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({ invite: [ '@bob:example.test', '@carol:example.test' ] }, context);
    const member = (stateKey: string) => storedEvents(rows)
      .find(event => event.type === 'm.room.member' && event.state_key === stateKey)!;

    // The second invite follows the first: room setup is a chain, not a fan of
    // siblings all pointing at the create event.
    const first = member('@bob:example.test');
    const second = member('@carol:example.test');
    expect(second.prev_events).toEqual([ first.event_id ]);
    expect(second.depth).toBe(first.depth! + 1);
    expect(storedEvents(rows).every(event => event.room_id === room.roomId)).toBe(true);
  });

  it('merges a fork by naming every event that has no child yet', async () => {
    const { service } = identity();
    const { store, context, rows } = matrixHarness({ serviceIdentity: service });
    const room = await store.createRoom({}, context);
    const first = await store.sendEvent(room.roomId, 'm.room.message', 'fork-1', { body: 'one' }, context);

    // A second writer that appended elsewhere: same parent, its own id. This is what
    // a concurrent local write or a replicated copy from another deployment looks
    // like in the Pod, and the next event has to close the fork by naming both.
    const rowsForRoom = rows.get(messageResource as never)!;
    const exemplar = rowsForRoom.find((row: any) => row.id === messageResource.buildIri(context.podUrl, { id: rowsForRoom[0].id }) || row.id === rowsForRoom[0].id) ?? rowsForRoom[0];
    const sibling = buildPersistedEvent({
      roomId: room.roomId, type: 'm.room.message', sender: '@alice:example.test',
      originServerTs: first.originServerTs + 5, content: { msgtype: 'm.text', body: 'sibling' },
      prevEvents: storedEvent(rows, first.eventId).event.prev_events,
      authEvents: storedEvent(rows, first.eventId).event.auth_events,
      depth: storedEvent(rows, first.eventId).event.depth,
    }, service);
    rowsForRoom.push({
      ...structuredClone(exemplar), id: 'chat/sibling', content: 'sibling', createdAt: new Date(first.originServerTs + 5).toISOString(),
      metadata: withProtocolMetadata({}, 'matrix', { event: sibling }),
    });

    const merged = await store.sendEvent(room.roomId, 'm.room.message', 'fork-2', { body: 'two' }, context);
    expect([ ...(storedEvent(rows, merged.eventId).event.prev_events ?? []) ].sort())
      .toEqual([ sibling.event_id!, first.eventId ].sort());
  });

  it('takes a reservation over when the room moved on before the write landed', async () => {
    const { service } = identity();
    const { store, context, rows, db } = matrixHarness({ serviceIdentity: service });
    const room = await store.createRoom({}, context);
    // The first attempt reserves an id and then fails to reach the Pod.
    const insert = db.insert.bind(db);
    let fail = true;
    db.insert = (table: unknown) => (fail && table === messageResource
      ? { values: async () => { fail = false; throw new Error('Pod unavailable'); } }
      : insert(table));
    await expect(store.sendEvent(room.roomId, 'm.room.message', 'moved-txn', { body: 'after a move' }, context))
      .rejects.toThrow('Pod unavailable');
    expect(rows.get(messageResource as never)!.filter((row: any) => row.content === 'after a move')).toHaveLength(0);

    // Another event lands before the client retries, so the room the reservation was
    // taken against no longer exists.
    await store.setState(room.roomId, 'm.room.topic', '', { topic: 'moved on' }, context);

    const retried = await store.sendEvent(room.roomId, 'm.room.message', 'moved-txn', { body: 'after a move' }, context);
    const stored = rows.get(messageResource as never)!.filter((row: any) => row.content === 'after a move');
    expect(stored).toHaveLength(1);
    // One event, at the position the retry actually saw, verified from the Pod.
    expect(storedEvent(rows, retried.eventId).event).toMatchObject({ depth: 5 });
    expect(verifyPersistedEvent(storedEvent(rows, retried.eventId).event))
      .toEqual({ eventIdMatches: true, contentHashMatches: true, signed: true });
  });

  it('keeps application bookkeeping outside the signed event', async () => {
    const { service } = identity();
    const { store, context, rows } = matrixHarness({ serviceIdentity: service });
    const room = await store.createRoom({}, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'bookkeeping-1', { body: 'hi' }, context);
    const matrix = getProtocolMetadata(storedEvent(rows, sent.eventId).row.metadata, 'matrix')!;

    // The author's WebID and the client transaction id are ours, not the event's:
    // including them would change the canonical form and therefore the event id.
    expect(matrix.senderWebId).toBe(context.webId);
    expect(matrix.txnId).toBe('bookkeeping-1');
    expect((matrix.event as Record<string, unknown>).txnId).toBeUndefined();
    expect((matrix.event as Record<string, unknown>).senderWebId).toBeUndefined();
  });
});


