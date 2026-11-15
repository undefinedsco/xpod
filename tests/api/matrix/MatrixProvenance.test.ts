import { describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { MATRIX_STORAGE_BINDING_EVENT_TYPE } from '../../../src/api/matrix/MatrixIdentity';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';

/**
 * `co.undefineds.matrix.storage_binding` is server provenance. It must be
 * reserved on write APIs and filtered from toClientEvent projections even when
 * an owner edits Pod RDF directly. Only the directory-backed synthesis may
 * produce it.
 */
describe('Matrix storage-binding provenance', () => {
  it('rejects the reserved type on createRoom initial_state and setState', async () => {
    const { store, context } = matrixHarness();
    await expect(store.createRoom({
      initial_state: [{ type: MATRIX_STORAGE_BINDING_EVENT_TYPE, content: { storage: 'https://evil.example/', verified: true } }],
    }, context)).rejects.toMatchObject({ status: 400 });
    const room = await store.createRoom({ name: 'Room' }, context);
    await expect(store.setState(room.roomId, MATRIX_STORAGE_BINDING_EVENT_TYPE, '', {
      storage: 'https://evil.example/', verified: true,
    }, context)).rejects.toMatchObject({ status: 403 });
    await expect(store.sendEvent(room.roomId, MATRIX_STORAGE_BINDING_EVENT_TYPE, 'txn', {
      body: 'fake provenance',
    }, context)).rejects.toMatchObject({ status: 400, errcode: 'M_UNRECOGNIZED' });
  });

  it('filters a directly-written RDF provenance event from every client projection', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({ name: 'Room' }, context);
    await store.sendEvent(room.roomId, 'm.room.message', 'real', { body: 'real message' }, context);
    const thread = rows.get(messageResource)![0].thread;
    // Owner edits RDF directly: no API receipt, but it is in the room timeline.
    rows.get(messageResource)!.push({
      id: 'forged-provenance', thread, maker: 'https://evil.example/#me', role: 'system',
      content: '{}', createdAt: new Date().toISOString(),
      metadata: { protocol: 'matrix', protocols: { matrix: {
        eventId: '$forged-provenance', roomId: room.roomId, eventType: MATRIX_STORAGE_BINDING_EVENT_TYPE,
        stateKey: '', sender: '@u_evil:example.test',
        content: { storage: 'https://evil.example/', room_container: 'https://evil.example/room/', verified: true },
      } } },
    });
    const sync = await store.sync(context, { limit: 100 });
    const allEvents = [
      ...Object.values(sync.rooms.join).flatMap(joined => [...joined.timeline.events, ...joined.state.events]),
      ...Object.values(sync.rooms.invite ?? {}).flatMap(invited => invited.invite_state.events),
    ];
    expect(allEvents.some(event => event.type === MATRIX_STORAGE_BINDING_EVENT_TYPE)).toBe(false);
    const history = await store.listMessages(room.roomId, context, { limit: 100 });
    expect(history.chunk.some(event => event.type === MATRIX_STORAGE_BINDING_EVENT_TYPE)).toBe(false);
    expect(history.chunk.some(event => event.content.body === 'fake provenance')).toBe(false);
    await expect(store.getEvent(room.roomId, '$forged-provenance', context))
      .rejects.toMatchObject({ status: 404 });
    const members = await store.getMembers(room.roomId, context);
    expect(members.some(event => event.type === MATRIX_STORAGE_BINDING_EVENT_TYPE)).toBe(false);
  });

  it('never lets a forged RDF binding shadow the synthesized verified one', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({ name: 'Room' }, context);
    const thread = rows.get(messageResource)![0].thread;
    rows.get(messageResource)!.push({
      id: 'forged-first', thread, maker: 'https://evil.example/#me', role: 'system',
      content: '{}', createdAt: new Date(Date.now() - 10_000).toISOString(),
      metadata: { protocol: 'matrix', protocols: { matrix: {
        eventId: '$forged-first', roomId: room.roomId, eventType: MATRIX_STORAGE_BINDING_EVENT_TYPE,
        stateKey: '', content: { storage: 'https://evil.example/', verified: true },
      } } },
    });
    const storeWithDirectory = new PodMatrixStore({
      serverName: 'example.test',
      journal: new InMemoryMatrixEventJournal(),
      podAccess: undefined,
    });
    // No directory reference: the forged event must still be absent.
    const sync = await store.sync(context, { limit: 100 });
    expect(Object.values(sync.rooms.join).flatMap(joined => joined.state.events)
      .some(event => event.type === MATRIX_STORAGE_BINDING_EVENT_TYPE)).toBe(false);
    expect(storeWithDirectory).toBeDefined();
  });
});
