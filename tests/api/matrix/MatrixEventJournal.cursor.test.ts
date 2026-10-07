import { describe, expect, it } from 'vitest';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { PodMatrixEventJournal } from '../../../src/api/matrix/PodMatrixEventJournal';

const SCOPE = 'https://pod.example/alice/';

function reference(roomId: string, eventId: string, createdAt: number, messageIri?: string) {
  return { roomId, eventId, createdAt, ...(messageIri === undefined ? {} : { messageIri }) };
}

describe('cursor event references', () => {
  it('registers exact references idempotently and returns discovery order', async() => {
    const journal = new InMemoryMatrixEventJournal();
    const first = await journal.registerReference(SCOPE, reference('!r:host', '$a', 100, `${SCOPE}a.ttl#a`));
    const again = await journal.registerReference(SCOPE, reference('!r:host', '$a', 999));
    expect(first.sequence).toBe(1);
    // Re-registering the same (scope, room, event) never moves the reference.
    expect(again).toEqual(first);
    const second = await journal.registerReference(SCOPE, reference('!r:host', '$b', 50));
    expect(second.sequence).toBe(2);
  });

  it('pages by discovery sequence with a bounded limit and optional room filter', async() => {
    const journal = new InMemoryMatrixEventJournal();
    await journal.registerReference(SCOPE, reference('!r:host', '$a', 100));
    await journal.registerReference(SCOPE, reference('!other:host', '$b', 200));
    await journal.registerReference(SCOPE, reference('!r:host', '$c', 300));
    await journal.registerReference(SCOPE, reference('!r:host', '$d', 400));

    const page1 = await journal.listReferences(SCOPE, { limit: 2 });
    expect(page1.map(r => r.eventId)).toEqual([ '$a', '$b' ]);
    const page2 = await journal.listReferences(SCOPE, { afterSequence: page1.at(-1)!.sequence, limit: 2 });
    expect(page2.map(r => r.eventId)).toEqual([ '$c', '$d' ]);
    expect(await journal.listReferences(SCOPE, { afterSequence: page2.at(-1)!.sequence, limit: 2 })).toEqual([]);

    const roomOnly = await journal.listReferences(SCOPE, { roomId: '!r:host', limit: 10 });
    expect(roomOnly.map(r => r.eventId)).toEqual([ '$a', '$c', '$d' ]);
  });

  it('assigns a new discovery sequence to a late event with an older createdAt', async() => {
    const journal = new InMemoryMatrixEventJournal();
    const late = await journal.registerReference(SCOPE, reference('!r:host', '$late', 10));
    const first = await journal.registerReference(SCOPE, reference('!r:host', '$first', 1_000));
    // Discovery order is registration order, not createdAt order; late events are still discovered.
    expect([ late.sequence, first.sequence ]).toEqual([ 1, 2 ]);
    const byPage = await journal.listReferences(SCOPE, { limit: 10 });
    expect(byPage.map(r => r.eventId)).toEqual([ '$late', '$first' ]);
  });

  it('uses a stable random epoch identity that changes only on an explicit bump', async() => {
    const journal = new InMemoryMatrixEventJournal();
    const first = await journal.getEpoch(SCOPE);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    // Stable while the operational index survives (same store, later reads).
    expect(await journal.getEpoch(SCOPE)).toBe(first);
    const bumped = await journal.bumpEpoch(SCOPE);
    expect(bumped).not.toBe(first);
    expect(await journal.getEpoch(SCOPE)).toBe(bumped);
    // Another scope has its own identity.
    expect(await journal.getEpoch('https://pod.example/bob/')).not.toBe(bumped);
  });

  it('delegates the cursor APIs through the Pod wrapper to the sequence journal', async() => {
    const sequences = new InMemoryMatrixEventJournal();
    const podJournal = new PodMatrixEventJournal({ sequences });
    const stored = await podJournal.registerReference(SCOPE, reference('!r:host', '$a', 100));
    expect(stored.sequence).toBe(1);
    expect((await podJournal.listReferences(SCOPE, { limit: 10 })).map(r => r.eventId)).toEqual([ '$a' ]);
    const epoch = await podJournal.getEpoch(SCOPE);
    expect(typeof epoch).toBe('string');
    expect(await podJournal.getEpoch(SCOPE)).toBe(epoch);
  });

  it('honours a fixed throughSequence upper bound and never returns unbounded pages', async() => {
    const journal = new InMemoryMatrixEventJournal();
    await journal.registerReference(SCOPE, reference('!r:host', '$a', 100));
    const through = await journal.getHighWatermark(SCOPE);
    await journal.registerReference(SCOPE, reference('!r:host', '$b', 1));
    expect((await journal.listReferences(SCOPE, { afterSequence: 0, throughSequence: through, limit: 20 }))
      .map(r => r.eventId)).toEqual([ '$a' ]);
    // A non-finite request is clamped to an empty page, never "all".
    expect(await journal.listReferences(SCOPE, { limit: Number.POSITIVE_INFINITY })).toEqual([]);
  });

  it('only a complete exact reference raises the published reference watermark', async() => {
    const journal = new InMemoryMatrixEventJournal();
    expect(await journal.getPublishedReferenceWatermark(SCOPE)).toBe(0);
    const stored = await journal.registerReference(SCOPE, reference('!r:host', '$a', 100));
    expect(await journal.getPublishedReferenceWatermark(SCOPE)).toBe(stored.sequence);
    // A legacy event-only registration (no exact reference) must not raise the published watermark.
    const legacy = await journal.registerEvent(SCOPE, '!r:host', '$legacy-only');
    expect(legacy).toBeGreaterThan(stored.sequence);
    expect(await journal.getPublishedReferenceWatermark(SCOPE)).toBe(stored.sequence);
    expect(await journal.listReferences(SCOPE, { limit: 10 })).toHaveLength(1);
  });
});
