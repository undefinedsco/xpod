import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import type { MatrixRoomChangeSnapshot, MatrixRoomChangeSource } from '../../../src/api/matrix/PodMatrixStore';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

describe('notification observations during Matrix sync', () => {
  it('bounds full history reads while an unavailable notification source stays quiet', async () => {
    const { store, context, db } = matrixHarness({ roomChanges: {
      pending: async () => ({ trust: 'all', rooms: [] }), settle: async () => undefined,
    } });
    await store.createRoom({}, context);
    const initial = await store.sync(context);
    const select = vi.spyOn(db, 'select');
    const result = await store.sync(context, { since: initial.next_batch, timeout: 1_200 });
    expect(result.next_batch).toBe(initial.next_batch);
    expect(Object.values(result.rooms.join).flatMap(room => room.timeline.events)).toEqual([]);
    expect(select.mock.calls.length).toBeLessThanOrEqual(4);
  });
  it('indexes a native Pod row notified during long polling before acknowledging it', async () => {
    let roomId = '';
    let inject: (() => void) | undefined;
    let polls = 0;
    let dirty = false;
    const source: MatrixRoomChangeSource = {
      pending: async () => {
        if (inject && polls++ > 0) {
          inject();
          inject = undefined;
          dirty = true;
        }
        return { trust: 'changed', rooms: dirty ? [ roomId ] : [], snapshot: {} };
      },
      settle: async ({ rooms }) => { if (rooms.includes(roomId)) dirty = false; },
    };
    const { store, context, rows } = matrixHarness({ roomChanges: source });
    roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'seed', { body: 'seed' }, context);
    const initial = await store.sync(context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    inject = () => rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: 'during-poll', parent: exemplar.parent, createdAt: '2000-01-01T00:00:00Z' }),
      content: 'native during poll',
      maker: 'https://pod.example/agent#one', role: 'assistant', metadata: {},
      createdAt: '2000-01-01T00:00:00Z',
    });
    const result = await store.sync(context, { since: initial.next_batch, timeout: 1_500 });
    expect(result.rooms.join[roomId]?.timeline.events.some(event => event.content.body === 'native during poll')).toBe(true);
    expect(dirty).toBe(false);
  });

  it('acknowledges the exact observation after a forced full read', async () => {
    const snapshot = {};
    const pending: MatrixRoomChangeSnapshot = { trust: 'all', rooms: [], snapshot };
    const settle = vi.fn(async () => undefined);
    const { store, context } = matrixHarness({ roomChanges: { pending: async () => pending, settle } });
    await store.createRoom({}, context);
    await store.sync(context);
    expect(settle).toHaveBeenCalledWith({ scope: context.podUrl, rooms: [], snapshot, full: true });
  });

  it('leaves observations pending when an authoritative read fails', async () => {
    const settle = vi.fn(async () => undefined);
    const { store, context } = matrixHarness({ roomChanges: {
      pending: async () => ({ trust: 'all', rooms: [], snapshot: {} }), settle,
    } });
    await store.createRoom({}, context);
    const failedRead = vi.spyOn(store as any, 'syncOnce').mockRejectedValueOnce(new Error('Pod unavailable'));
    await expect(store.sync(context)).rejects.toThrow('Pod unavailable');
    expect(settle).not.toHaveBeenCalled();
    failedRead.mockRestore();
  });
});
