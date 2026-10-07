import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import type { MatrixRoomChangeSource } from '../../../src/api/matrix/PodMatrixStore';

describe('cursor incremental reads, independent acceptance', () => {
  it('rejects a forged fixed upper bound beyond published source references', async() => {
    const { store, context } = matrixHarness();
    await store.createRoom({}, context);
    const token = (await store.sync(context)).next_batch;
    const epoch = token.split('.')[1];
    await expect(store.sync(context, { since: `v3.${epoch}.900000.0` })).rejects.toMatchObject({
      status: 400, errcode: 'M_UNKNOWN_POS',
    });
  });

  it('delivers a page of new events without reopening the room history', async () => {
    let changed: string[] = [];
    const source: MatrixRoomChangeSource = {
      pending: async () => ({ trust: 'changed', rooms: changed }),
      settle: async () => undefined,
    };
    const { store, context, db } = matrixHarness({ roomChanges: source });
    const room = await store.createRoom({}, context);
    for (let index = 0; index < 200; index++) {
      await store.sendEvent(room.roomId, 'm.room.message', `history-${index}`, { body: `history-${index}` }, context);
    }
    const initial = await store.sync(context, { limit: 1_000 });
    const expectedIds: string[] = [];
    for (let index = 0; index < 20; index++) {
      const written = await store.sendEvent(room.roomId, 'm.room.message', `new-${index}`, { body: `new-${index}` }, context);
      expectedIds.push(written.eventId);
    }
    changed = [ room.roomId ];
    // Only measure the normal incremental read. Writes and initial indexing have separate budgets.
    const history = vi.spyOn(store as any, 'listEvents');
    const exactReads = vi.spyOn(db, 'findByIri');
    const page = await store.sync(context, { since: initial.next_batch, limit: 20 });
    expect(page.rooms.join[room.roomId]?.timeline.events.map(event => event.event_id)).toEqual(expectedIds);
    expect(page.rooms.join[room.roomId]?.timeline.events.map(event => event.content.body))
      .toEqual(Array.from({ length: 20 }, (_, index) => `new-${index}`));
    expect(history, 'normal cursor reads must consume references rather than scan and filter room history')
      .not.toHaveBeenCalled();
    expect(exactReads.mock.calls.filter(([ table ]) => table === messageResource),
      'hydrate each selected reference once, without a second response pass').toHaveLength(20);
    history.mockRestore();
    exactReads.mockRestore();
  });

  for (const limit of [ 1, 7, 20 ]) {
    it(`keeps a fixed backlog snapshot at limit=${limit}, then discovers an older late event`, async () => {
      const source: MatrixRoomChangeSource = {
        pending: async () => ({ trust: 'changed', rooms: [] }),
        settle: async () => undefined,
      };
      const { store, context } = matrixHarness({ roomChanges: source });
      const room = await store.createRoom({}, context);
      let token = (await store.sync(context, { limit: 1_000 })).next_batch;
      const timestamp = Date.now();
      const expected: string[] = [];
      const clock = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
      try {
        for (let index = 0; index < 200; index++) {
          expected.push((await store.sendEvent(room.roomId, 'm.room.message', `backlog-${index}`, {
            body: `backlog-${index}`,
          }, context)).eventId);
        }
      } finally {
        clock.mockRestore();
      }
      const first = await store.sync(context, { since: token, limit });
      const observed = first.rooms.join[room.roomId]?.timeline.events.map(event => event.event_id) ?? [];
      expect(observed).toEqual(expected.slice(0, limit));
      token = first.next_batch;
      // Eight days older than the current backlog, but discovered after its snapshot was fixed.
      const lateClock = vi.spyOn(Date, 'now').mockReturnValue(timestamp - 8 * 24 * 60 * 60 * 1_000);
      let lateId: string;
      try {
        lateId = (await store.sendEvent(room.roomId, 'm.room.message', 'late-old-event', { body: 'late-old-event' }, context)).eventId;
      } finally {
        lateClock.mockRestore();
      }
      while (observed.length < expected.length) {
        const page = await store.sync(context, { since: token, limit });
        const events = page.rooms.join[room.roomId]?.timeline.events ?? [];
        expect(events.length).toBeLessThanOrEqual(limit);
        expect(events.length, 'backlog must make progress even when notification hints are empty').toBeGreaterThan(0);
        observed.push(...events.map(event => event.event_id));
        expect(page.next_batch.length, 'cursor size must not grow with event IDs or history').toBeLessThanOrEqual(1_024);
        token = page.next_batch;
      }
      expect(observed).toEqual(expected);
      const next = await store.sync(context, { since: token, limit });
      expect(next.rooms.join[room.roomId]?.timeline.events.map(event => event.event_id)).toEqual([ lateId ]);
    });
  }

  it('rejects a cursor whose operational-index epoch has changed', async () => {
    const source: MatrixRoomChangeSource = {
      pending: async () => ({ trust: 'changed', rooms: [] }), settle: async () => undefined,
    };
    const { store, context } = matrixHarness({ roomChanges: source });
    const room = await store.createRoom({}, context);
    const token = (await store.sync(context)).next_batch;
    await (store as any).journal.bumpEpoch(context.podUrl);
    await store.sendEvent(room.roomId, 'm.room.message', 'after-rebuild', { body: 'after-rebuild' }, context);
    await expect(store.sync(context, { since: token })).rejects.toThrow();
  });

  it('does not acknowledge a page when its exact stored message is unavailable', async () => {
    let changed: string[] = [];
    const settled: string[][] = [];
    const source: MatrixRoomChangeSource = {
      pending: async () => ({ trust: 'changed', rooms: changed }),
      settle: async ({ rooms }) => { settled.push([ ...rooms ]); },
    };
    const { store, context, db } = matrixHarness({ roomChanges: source });
    const room = await store.createRoom({}, context);
    const token = (await store.sync(context)).next_batch;
    await store.sendEvent(room.roomId, 'm.room.message', 'unavailable', { body: 'unavailable' }, context);
    changed = [ room.roomId ];
    settled.length = 0;
    const exactLookup = db.findByIri.bind(db);
    db.findByIri = async (table: unknown, iri: string) => table === messageResource ? undefined : exactLookup(table, iri);
    await expect(store.sync(context, { since: token, limit: 20 })).rejects.toThrow();
    expect(settled, 'a failed exact read must keep discovery work pending').toEqual([]);
  });

  it('does not discard an undiscovered native append while delivering a known reference', async () => {
    let roomId = '';
    let dirty = false;
    const source: MatrixRoomChangeSource = {
      pending: async () => ({ trust: 'changed', rooms: dirty ? [ roomId ] : [], snapshot: {} }),
      settle: async ({ rooms }) => { if (rooms.includes(roomId)) dirty = false; },
    };
    const { store, context, rows } = matrixHarness({ roomChanges: source });
    roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'seed-for-native', { body: 'seed' }, context);
    let token = (await store.sync(context, { limit: 1_000 })).next_batch;
    const known = await store.sendEvent(roomId, 'm.room.message', 'known-reference', { body: 'known' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: 'same-poll', parent: exemplar.parent, createdAt: '2000-01-01T00:00:00Z' }),
      content: 'native alongside reference',
      maker: 'https://pod.example/agent#one', role: 'assistant', metadata: {},
      createdAt: '2000-01-01T00:00:00Z',
    });
    dirty = true;
    const seen: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const page = await store.sync(context, { since: token, limit: 1 });
      const events = page.rooms.join[roomId]?.timeline.events ?? [];
      seen.push(...events.map(event => String(event.content.body)));
      token = page.next_batch;
      if (!dirty && !seen.includes('native alongside reference')) {
        const references = await (store as any).journal.listReferences(context.podUrl, { limit: 1_000 });
        expect(references.some((reference: { messageIri?: string }) => reference.messageIri?.endsWith('#same-poll')),
          'acknowledgement requires publishing the discovered native reference, not just returning an API reference').toBe(true);
      }
      if (seen.includes('native alongside reference') && seen.includes('known')) break;
    }
    expect(seen.filter(body => body === 'known')).toHaveLength(1);
    expect(known.eventId).toBeTruthy();
    expect(seen.filter(body => body === 'native alongside reference')).toHaveLength(1);
    expect(dirty).toBe(false);
  });

  it('requires an epoch-bearing sync token rather than accepting the legacy numeric position', async () => {
    const { store, context } = matrixHarness();
    await store.createRoom({}, context);
    await expect(store.sync(context, { since: 'v2_1' })).rejects.toMatchObject({
      status: 400, errcode: 'M_UNKNOWN_POS',
    });
  });
});
