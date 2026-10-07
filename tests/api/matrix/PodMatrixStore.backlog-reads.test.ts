import { describe, expect, it } from 'vitest';
import { chatResource, messageResource } from '@undefineds.co/models';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';

/**
 * Bounded regression for the Matrix backlog stall.
 *
 * A backlog `sendEvent` must not re-read the same Pod documents more times than it
 * needs. The pre-fix hot path performed two `chatResource` lookups (requireJoined and
 * appendEvent.getRoomContext). The exact message lookup still protects receipts whose
 * records have moved out of the timeline; only the duplicate room read is removed.
 */
function countingHarness() {
  const rows = new Map<any, any[]>();
  const counts = { chatFindById: 0, messageFindById: 0, messageSelects: 0 };
  const db: any = {
    init: async () => undefined,
    findById: async (table: any, id: string) => {
      if (table === chatResource) counts.chatFindById += 1;
      if (table === messageResource) counts.messageFindById += 1;
      return (rows.get(table) ?? []).find((r: any) => r.id === id);
    },
    insert: (table: any) => ({ values: async (row: any) => {
      const list = rows.get(table) ?? [];
      if (!list.some((r: any) => r.id === row.id)) list.push(structuredClone(row));
      rows.set(table, list);
    } }),
    updateById: async (table: any, id: string, value: any) =>
      Object.assign((rows.get(table) ?? []).find((r: any) => r.id === id), value),
    select: () => {
      let table: any; let condition: any;
      const match = (r: any, c: any): boolean => !c || (c.expressions
        ? c.expressions.filter(Boolean).every((x: any) => match(r, x))
        : c.operator === '=' ? r[c.left.name] === c.right : true);
      const q: any = { from: (t: any) => { table = t; return q; },
        where: (c: any) => { condition = c; return q; }, orderBy: () => q, limit: () => q,
        then: (ok: any, fail: any) => {
          if (table === messageResource) counts.messageSelects += 1;
          return Promise.resolve((rows.get(table) ?? []).filter((r: any) => match(r, condition))).then(ok, fail);
        },
      }; return q;
    },
  };
  const context: any = { webId: 'https://alice.example/profile/card#me', podUrl: 'https://pod.example/alice/',
    auth: { type: 'solid', webId: 'https://alice.example/profile/card#me', clientId: 'device-a' }, _matrixDb: db };
  const store = new PodMatrixStore({ serverName: 'example.test', journal: new InMemoryMatrixEventJournal() });
  return { store, context, db, rows, counts };
}

describe('PodMatrixStore bounded backlog reads', () => {
  it('reads each Pod document at most once per backlog send', async () => {
    const h = countingHarness();
    const room = await h.store.createRoom({ name: 'Backlog room' }, h.context);
    for (let index = 0; index < 20; index += 1) {
      await h.store.sendEvent(room.roomId, 'm.room.message', `seed-${index}`, { body: `seed ${index}` }, h.context);
    }
    h.counts.chatFindById = 0;
    h.counts.messageFindById = 0;
    h.counts.messageSelects = 0;

    await h.store.sendEvent(room.roomId, 'm.room.message', 'probe', { body: 'probe' }, h.context);

    // Reuse the room snapshot while keeping the authoritative receipt lookup.
    expect(h.counts.chatFindById).toBe(1);
    expect(h.counts.messageSelects).toBe(1);
    expect(h.counts.messageFindById).toBe(1);
  });

  it('still preserves transaction idempotency and conflict detection', async () => {
    const h = countingHarness();
    const room = await h.store.createRoom({ name: 'Retry room' }, h.context);
    const first = await h.store.sendEvent(room.roomId, 'm.room.message', 'retry', { body: 'same' }, h.context);
    const duplicate = await h.store.sendEvent(room.roomId, 'm.room.message', 'retry', { body: 'same' }, h.context);
    expect(duplicate.eventId).toBe(first.eventId);
    await expect(h.store.sendEvent(room.roomId, 'm.room.message', 'retry', { body: 'changed' }, h.context))
      .rejects.toMatchObject({ status: 409 });
    expect(h.rows.get(messageResource)!.filter((row: any) => row.content === 'same')).toHaveLength(1);
  });

  it('rejects a conflicting stored receipt even when its event no longer appears in the room timeline', async () => {
    const h = countingHarness();
    const room = await h.store.createRoom({ name: 'Receipt room' }, h.context);
    const first = await h.store.sendEvent(room.roomId, 'm.room.message', 'receipt', { body: 'same' }, h.context);
    const row = h.rows.get(messageResource)!.find((value: any) => value.id === first.resourceId)!;
    row.thread = 'https://pod.example/alice/another-thread';
    row.metadata = { protocols: { matrix: { eventId: first.eventId, eventType: 'm.room.message',
      senderWebId: h.context.webId, content: { body: 'tampered' } } } };

    await expect(h.store.sendEvent(room.roomId, 'm.room.message', 'receipt', { body: 'same' }, h.context))
      .rejects.toMatchObject({ status: 409 });
  });
});
