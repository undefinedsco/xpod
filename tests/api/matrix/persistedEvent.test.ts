import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { getProtocolMetadata } from '../../../src/api/protocol-metadata';
import { computeContentHash, computeEventId, decodeVerifyKey, encodeUnpaddedBase64 } from '../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import {
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


