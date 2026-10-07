/**
 * W0 gap tests for the logical event identity the migration targets (G03/G04).
 *
 * The contract makes `(roomId, eventId)` the unique key: a retry is the same event whatever
 * transaction carried it, whatever day it lands on, and whichever process serves it. These tests
 * encode that contract and are deliberately expected to **fail before the write path is fixed** —
 * they are the "new gap tests genuinely fail first" half of W0, and the target of W1.
 *
 * They run on the in-memory harness, so they prove the write path's decision, not the storage
 * guarantee; the real-RDF cross-day/concurrency evidence lives with the Pod-backed carriers.
 */
import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { MATRIX_TEST_SERVER_NAME, matrixHarness, canonicalSourceFor } from '../../helpers/MatrixMemoryDatabase';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { computeEventId } from '../../../src/api/matrix/protocol/eventIntegrity';
import type { MatrixEventRecord } from '../../../src/api/matrix/types';

type MessageRow = { metadata?: { protocols?: { matrix?: { event?: Record<string, unknown> } } } };

/** Every stored protocol event, however it was written. */
function storedEvents(rows: Map<unknown, unknown[]>): Record<string, unknown>[] {
  return (rows.get(messageResource) as MessageRow[] ?? [])
    .map(row => row?.metadata?.protocols?.matrix?.event)
    .filter((event): event is Record<string, unknown> => Boolean(event));
}

/** The message bodies stored under one writer-chosen event id. */
function bodiesFor(rows: Map<unknown, unknown[]>, eventId: string): unknown[] {
  return storedEvents(rows)
    .filter(event => event.event_id === eventId)
    .map(event => (event.content as Record<string, unknown> | undefined)?.body);
}

describe('logical event identity (G03/G04)', () => {
  it('absorbs a retry that carries a different transaction id', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    try {
      const { store, context, rows } = matrixHarness();
      vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
      const room = await store.createRoom({}, context);
      const first = await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context, { msgid: '$writer' });
      // A later retry, so the naive "rebuild the resource id from the clock" path would look in a
      // different document. The logical key is the same event, so it must land on the first row.
      vi.setSystemTime(new Date('2026-09-20T10:00:02.000Z'));
      const retry = await store.sendEvent(room.roomId, 'm.room.message', 'txn-2', { body: 'hi' }, context, { msgid: '$writer' });

      expect(retry.eventId).toBe(first.eventId);
      expect(bodiesFor(rows, '$writer')).toEqual([ 'hi' ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('absorbs a retry that lands on another day', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    try {
      const { store, context, rows } = matrixHarness();
      vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
      const room = await store.createRoom({}, context);
      const first = await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context, { msgid: '$cross-day' });
      vi.setSystemTime(new Date('2026-09-21T10:00:00.000Z'));
      const retry = await store.sendEvent(room.roomId, 'm.room.message', 'txn-2', { body: 'hi' }, context, { msgid: '$cross-day' });

      expect(retry.eventId).toBe(first.eventId);
      expect(bodiesFor(rows, '$cross-day')).toEqual([ 'hi' ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('absorbs a retry served by a restarted process', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    try {
      const { store, context, rows, db } = matrixHarness();
      vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
      const room = await store.createRoom({}, context);
      const first = await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context, { msgid: '$restart' });

      vi.setSystemTime(new Date('2026-09-20T10:05:00.000Z'));
      const restarted = new PodMatrixStore({ serverName: MATRIX_TEST_SERVER_NAME, journal: new InMemoryMatrixEventJournal(), canonicalSource: canonicalSourceFor(context.webId, [ context.podUrl ]) });
      const retry = await restarted.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' },
        { ...context, _matrixDb: db } as never, { msgid: '$restart' });

      expect(retry.eventId).toBe(first.eventId);
      expect(bodiesFor(rows, '$restart')).toEqual([ 'hi' ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a different payload under the same writer id and keeps the first', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    try {
      const { store, context, rows } = matrixHarness();
      vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
      const room = await store.createRoom({}, context);

      await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'first' }, context, { msgid: '$conflict' });
      vi.setSystemTime(new Date('2026-09-20T10:00:03.000Z'));
      await expect(store.sendEvent(room.roomId, 'm.room.message', 'txn-2', { body: 'second' }, context, { msgid: '$conflict' }))
        .rejects.toMatchObject({ status: 409 });
      expect(bodiesFor(rows, '$conflict')).toEqual([ 'first' ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses competing content that arrives on another day and keeps the first event (G03)', async () => {
    vi.useFakeTimers({ toFake: [ 'Date' ] });
    try {
      const { store, context, rows } = matrixHarness();
      vi.setSystemTime(new Date('2026-09-20T10:00:00.000Z'));
      const room = await store.createRoom({}, context);
      const first = await store.sendEvent(room.roomId, 'm.room.message', 'day-txn', { body: 'first' }, context, { msgid: '$cross-day-competing' });
      vi.setSystemTime(new Date('2026-09-21T10:00:00.000Z'));
      await expect(store.sendEvent(room.roomId, 'm.room.message', 'day-txn-2', { body: 'second' }, context, { msgid: '$cross-day-competing' }))
        .rejects.toMatchObject({ status: 409 });
      expect(bodiesFor(rows, '$cross-day-competing')).toEqual([ 'first' ]);
      // The later day must not re-bucket the event: the first creation time still owns the document.
      const stored = storedEvents(rows).find(event => event.event_id === '$cross-day-competing');
      expect(stored?.origin_server_ts).toBe(first.originServerTs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a deployment-initiated event itself instead of deriving it from the content (G04)', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    await store.setState(room.roomId, 'm.room.topic', '', { topic: 'x' }, context);

    const state = storedEvents(rows).find(event => event.type === 'm.room.topic');
    expect(state).toBeDefined();
    expect(state!.event_id).not.toBe(computeEventId(state!));
  });

  it('keeps one row under 16-way concurrency for the same content, three rounds (G03)', async () => {
    for (let round = 0; round < 3; round++) {
      const { store, context, rows } = matrixHarness();
      const room = await store.createRoom({}, context);
      // A different transaction per attempt: the logical key is the event id, not the txn, so a
      // concurrent retry arriving under its own txn must still land on the first attempt's event.
      // Sharing one txn would let the txn reservation answer it and hide whether identity is really
      // keyed by `(roomId, eventId)`.
      const sent = await Promise.all(Array.from({ length: 16 }, (_unused, index) =>
        store.sendEvent(room.roomId, 'm.room.message', `same-txn-${index}`, { body: 'one' }, context, { msgid: '$concurrent-same' })));

      // One logical key, one identity: the whole point is that concurrency does not mint a second
      // event, and the room holds exactly one body for it.
      expect(new Set(sent.map(event => event.eventId))).toEqual(new Set([ '$concurrent-same' ]));
      expect(bodiesFor(rows, '$concurrent-same')).toEqual([ 'one' ]);
      // And the first creation time is what all of them report, not whichever txn happened to win.
      expect(new Set(sent.map(event => event.originServerTs)).size).toBe(1);
    }
  });

  it('keeps the first content and refuses the losers under 16-way competing concurrency (G03)', async () => {
    for (let round = 0; round < 3; round++) {
      const { store, context, rows } = matrixHarness();
      const room = await store.createRoom({}, context);
      const attempts = Array.from({ length: 16 }, (_unused, index) =>
        store.sendEvent(room.roomId, 'm.room.message', `competing-txn-${index}`, { body: index % 2 === 0 ? 'even' : 'odd' }, context, { msgid: '$concurrent-competing' }));
      const results = await Promise.allSettled(attempts);
      const accepted = results.filter((result): result is PromiseFulfilledResult<MatrixEventRecord> => result.status === 'fulfilled');
      const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

      expect(accepted.length).toBeGreaterThanOrEqual(1);
      // Every refusal is the conflict verdict — a competing body under a claimed id — not luck.
      for (const refusal of refused) expect(refusal.reason).toMatchObject({ status: 409 });
      // The first content survives and there is only ever one body for the logical key.
      expect(new Set(accepted.map(result => result.value.eventId))).toEqual(new Set([ '$concurrent-competing' ]));
      expect(bodiesFor(rows, '$concurrent-competing')).toHaveLength(1);
    }
  });
});
