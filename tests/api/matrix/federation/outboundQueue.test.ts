import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMatrixOutboundStore,
  MatrixOutbox,
  orderByDependencies,
  type MatrixOutboundBatch,
} from '../../../../src/api/matrix/federation/outboundQueue';
import type { MatrixDeliveryOutcome, MatrixDeliveryStatus } from '../../../../src/api/matrix/federation/outboundTransaction';

const SCOPE = 'https://pod.example/alice/';
const US = 'alice.example';
const THEM = 'remote.example';
const OTHER = 'other.example';

function pdu(id: string) {
  return { event_id: id, type: 'm.room.message', content: { body: id } };
}

function outcome(status: MatrixDeliveryStatus, reason = status): MatrixDeliveryOutcome {
  return { status, origin: US, destination: THEM, txnId: '-', reason };
}

function harness(options: {
  results?: MatrixDeliveryStatus[] | ((input: { destination: string; txnId: string }) => MatrixDeliveryStatus);
  store?: InMemoryMatrixOutboundStore;
  /** Per-PDU results for a delivered transaction, keyed by event id. */
  pduResults?: (input: { txnId: string; pdus: readonly unknown[] }) => Record<string, { error?: string }>;
  retryRefused?: { maxAttempts?: number; initialBackoffMs?: number; maxBackoffMs?: number };
  clock?: { now: number };
} = {}) {
  const store = options.store ?? new InMemoryMatrixOutboundStore();
  let index = 0;
  const sent: { origin: string; destination: string; txnId: string; pdus: readonly unknown[]; edus?: readonly unknown[] }[] = [];
  const clock = options.clock ?? { now: 1_000 };
  const send = vi.fn(async (input: { origin: string; destination: string; txnId: string; pdus: readonly unknown[]; edus?: readonly unknown[] }) => {
    sent.push(input);
    const status = typeof options.results === 'function'
      ? options.results(input)
      : options.results?.[index] ?? 'delivered';
    index += 1;
    const results = status === 'delivered' ? options.pduResults?.(input) : undefined;
    return { ...outcome(status), destination: input.destination, txnId: input.txnId, ...(results ? { pdus: results } : {}) };
  });
  let counter = 0;
  const outbox = new MatrixOutbox({
    store,
    send,
    now: () => clock.now,
    newTransactionId: () => `txn-${++counter}`,
    ...(options.retryRefused ? { retryRefused: options.retryRefused } : {}),
  });
  return { outbox, store, send, sent, clock };
}

describe('queueing outbound transactions', () => {
  it('creates one batch per destination with its own transaction id', async () => {
    const { outbox, store } = harness();
    const batches = await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a'), pdu('$b') ] });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ origin: US, destination: THEM, txnId: 'txn-1', attempts: 0, createdAt: 1_000 });
    expect(batches[0].pdus.map(p => (p as { event_id: string }).event_id)).toEqual([ '$a', '$b' ]);
    expect(await store.pending(SCOPE)).toHaveLength(1);
    expect(await store.pending(SCOPE, { destination: OTHER })).toEqual([]);
    expect(await store.pending(SCOPE, { origin: 'bob.example' })).toEqual([]);
  });

  it('splits more PDUs than a transaction may carry, preserving order', async () => {
    const { outbox } = harness();
    const pdus = Array.from({ length: 120 }, (_, i) => pdu(`$${i}`));
    const batches = await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus });

    expect(batches.map(batch => batch.pdus.length)).toEqual([ 50, 50, 20 ]);
    expect(batches.map(batch => batch.txnId)).toEqual([ 'txn-1', 'txn-2', 'txn-3' ]);
    const flattened = batches.flatMap(batch => batch.pdus.map(p => (p as { event_id: string }).event_id));
    expect(flattened).toEqual(pdus.map(p => (p as { event_id: string }).event_id));
  });

  it('drops PDUs it already owes that destination, and does not dedup what has no id', async () => {
    const { outbox } = harness();
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    const second = await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a'), pdu('$b'), { type: 'x' }, { type: 'x' } ] });

    // Appended to the batch that has never been attempted, so it keeps its transaction id.
    expect(second).toHaveLength(1);
    expect(second[0].txnId).toBe('txn-1');
    const ids = second[0].pdus.map(p => (p as { event_id?: string }).event_id ?? 'anonymous');
    expect(ids).toEqual([ '$a', '$b', 'anonymous', 'anonymous' ]);
  });

  it('is a no-op when there is nothing to send', async () => {
    const { outbox, store } = harness();
    await expect(outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM })).resolves.toEqual([]);
    await expect(outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] })).resolves.toHaveLength(1);
    // Everything already queued: nothing new to say.
    await expect(outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] })).resolves.toEqual([]);
    expect(await store.pending(SCOPE)).toHaveLength(1);
  });

  it('never appends to a batch the destination may already have seen', async () => {
    const { outbox, store } = harness({ results: [ 'retry' ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.flush({ scope: SCOPE });

    const batches = await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$b') ] });
    // Appending to txn-1 would hide $b behind a stored response the peer replays, so a new
    // transaction id has to be minted instead.
    expect(batches).toHaveLength(1);
    expect(batches[0].txnId).toBe('txn-2');
    const pending = await store.pending(SCOPE);
    expect(pending.map(batch => batch.txnId)).toEqual([ 'txn-1', 'txn-2' ]);
  });

  it('keeps scopes, origins and destinations apart', async () => {
    const { outbox, store } = harness();
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: OTHER, pdus: [ pdu('$b') ] });
    await outbox.enqueue({ scope: SCOPE, origin: 'bob.example', destination: THEM, pdus: [ pdu('$c') ] });
    await outbox.enqueue({ scope: 'https://pod.example/bob/', origin: 'bob.example', destination: THEM, pdus: [ pdu('$d') ] });

    expect((await store.pending(SCOPE)).map(batch => [ batch.origin, batch.destination ])).toEqual([
      [ US, THEM ], [ US, OTHER ], [ 'bob.example', THEM ],
    ]);
    expect((await store.pending(SCOPE, { origin: US })).map(batch => batch.destination)).toEqual([ THEM, OTHER ]);
    expect((await store.pending('https://pod.example/bob/')).map(batch => batch.destination)).toEqual([ THEM ]);
  });

  it('carries EDUs, including a transaction with no PDUs at all', async () => {
    const { outbox, store } = harness();
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, edus: [ { edu_type: 'm.typing' } ] });
    const [ batch ] = await store.pending(SCOPE);
    expect(batch.pdus).toEqual([]);
    expect(batch.edus).toEqual([ { edu_type: 'm.typing' } ]);
  });
});

describe('flushing the queue', () => {
  it('delivers oldest first and empties the queue', async () => {
    const { outbox, store, sent } = harness({ results: [ 'delivered', 'delivered' ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: Array.from({ length: 60 }, (_, i) => pdu(`$${i}`)) });
    const report = await outbox.flush({ scope: SCOPE });

    expect(report.delivered).toEqual([ 'txn-1', 'txn-2' ]);
    expect(report.deferred).toEqual([]);
    expect(sent.map(entry => [ entry.origin, entry.txnId ])).toEqual([ [ US, 'txn-1' ], [ US, 'txn-2' ] ]);
    expect(sent[0].pdus).toHaveLength(50);
    expect(sent[1].pdus).toHaveLength(10);
    expect(await store.pending(SCOPE)).toEqual([]);
  });

  it('stops a destination at the first failure, leaving later transactions alone', async () => {
    const { outbox, store, sent } = harness({ results: [ 'retry', 'delivered' ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: Array.from({ length: 60 }, (_, i) => pdu(`$${i}`)) });
    const report = await outbox.flush({ scope: SCOPE });

    // A failed transaction with one id must be resolved before a different id goes out.
    expect(report.deferred).toEqual([ { txnId: 'txn-1', destination: THEM, reason: 'retry' } ]);
    expect(report.blocked).toEqual([ { txnId: 'txn-2', destination: THEM } ]);
    expect(report.delivered).toEqual([]);
    expect(sent).toHaveLength(1);
    const pending = await store.pending(SCOPE);
    expect(pending.map(batch => [ batch.txnId, batch.attempts, batch.lastReason ])).toEqual([ [ 'txn-1', 1, 'retry' ], [ 'txn-2', 0, undefined ] ]);
  });

  it('keeps the transaction id across flushes until it is delivered', async () => {
    const clock = { now: 1_000 };
    const { outbox } = harness({ results: [ 'retry', 'retry', 'delivered' ], clock });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });

    const first = await outbox.flush({ scope: SCOPE });
    const second = await outbox.flush({ scope: SCOPE });
    const third = await outbox.flush({ scope: SCOPE });
    // Both failures deferred the *same* transaction: a new id would make the peer
    // process the same PDUs again.
    expect(first.deferred.map(entry => entry.txnId)).toEqual([ 'txn-1' ]);
    expect(second.deferred.map(entry => entry.txnId)).toEqual([ 'txn-1' ]);
    expect(third.delivered).toEqual([ 'txn-1' ]);
  });

  it('moves on after a refusal, because the peer has decided', async () => {
    const { outbox, store } = harness({ results: [ 'rejected', 'delivered' ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: Array.from({ length: 60 }, (_, i) => pdu(`$${i}`)) });
    const report = await outbox.flush({ scope: SCOPE });

    expect(report.rejected).toEqual([ { txnId: 'txn-1', destination: THEM, reason: 'rejected' } ]);
    expect(report.delivered).toEqual([ 'txn-2' ]);
    expect(report.blocked).toEqual([]);
    expect(await store.pending(SCOPE)).toEqual([]);
  });

  it('does not let one origin block another towards the same destination', async () => {
    const { outbox, sent } = harness({
      results: input => (input.destination === THEM ? 'retry' : 'delivered'),
    });
    // Two origins this deployment hosts, both sending to the same stuck destination: the
    // peer dedups on (origin, txnId), so these are independent transactions.
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, origin: 'bob.example', destination: THEM, pdus: [ pdu('$b') ] });
    const report = await outbox.flush({ scope: SCOPE });
    expect(report.deferred).toHaveLength(2);
    expect(sent.map(entry => entry.origin)).toEqual([ US, 'bob.example' ]);
  });

  it('lets a healthy destination through while another is stuck', async () => {
    const { outbox, sent } = harness({
      results: input => (input.destination === THEM ? 'retry' : 'delivered'),
    });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: OTHER, pdus: [ pdu('$b') ] });
    const report = await outbox.flush({ scope: SCOPE });

    expect(report.delivered).toHaveLength(1);
    expect(report.deferred).toHaveLength(1);
    // Both destinations were attempted; only the failing one holds its own queue.
    expect(sent.map(entry => entry.destination)).toEqual([ THEM, OTHER ]);
  });

  it('can flush a single origin', async () => {
    const { outbox, store, sent } = harness();
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, origin: 'bob.example', destination: THEM, pdus: [ pdu('$b') ] });
    const report = await outbox.flush({ scope: SCOPE, origin: 'bob.example' });
    expect(report.delivered).toEqual([ 'txn-2' ]);
    expect(sent.map(entry => entry.origin)).toEqual([ 'bob.example' ]);
    expect((await store.pending(SCOPE)).map(batch => batch.origin)).toEqual([ US ]);
  });

  it('can flush a single destination', async () => {
    const { outbox, store, sent } = harness();
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: OTHER, pdus: [ pdu('$b') ] });
    const report = await outbox.flush({ scope: SCOPE, destination: OTHER });

    expect(report.delivered).toEqual([ 'txn-2' ]);
    expect(sent.map(entry => entry.destination)).toEqual([ OTHER ]);
    expect((await store.pending(SCOPE)).map(batch => batch.destination)).toEqual([ THEM ]);
  });

  it('passes EDUs on the wire and reports nothing to do as nothing done', async () => {
    const { outbox, send, sent } = harness();
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$a') ], edus: [ { edu_type: 'm.typing' } ] });
    await outbox.flush({ scope: SCOPE });
    expect(sent[0].edus).toEqual([ { edu_type: 'm.typing' } ]);

    send.mockClear();
    const empty = await outbox.flush({ scope: SCOPE });
    expect(empty).toEqual({ delivered: [], rejected: [], deferred: [], blocked: [], waiting: [], abandoned: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('orders a batch so an event never precedes the events it depends on', async () => {
    const { outbox, store } = harness();
    const create = { event_id: '$create', type: 'm.room.create', prev_events: [], auth_events: [] };
    const join = { event_id: '$join', type: 'm.room.member', prev_events: [ '$create' ], auth_events: [ '$create' ] };
    const invite = { event_id: '$invite', type: 'm.room.member', prev_events: [ '$join' ], auth_events: [ '$create', '$join' ] };

    // Queued in the order a room is built, but the invite arrives first.
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ invite ] });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ create, join ] });
    const [ batch ] = await store.pending(SCOPE);
    expect(batch.pdus.map(p => (p as { event_id: string }).event_id)).toEqual([ '$create', '$join', '$invite' ]);
  });

  it('retries the PDUs a delivered transaction refused, under a new transaction id', async () => {
    const clock = { now: 1_000 };
    const { outbox, store, sent } = harness({
      clock,
      // The peer refuses $bad while its dependencies are missing, and takes it once they
      // are there — the retry is what makes that possible.
      pduResults: input => Object.fromEntries(input.pdus.map(p => {
        const id = (p as { event_id: string }).event_id;
        return [ id, id === '$bad' && input.txnId === 'txn-1' ? { error: 'missing auth events' } : {} ];
      })),
      retryRefused: { initialBackoffMs: 500, maxBackoffMs: 10_000, maxAttempts: 4 },
    });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$good'), pdu('$bad') ] });
    const first = await outbox.flush({ scope: SCOPE });

    // The accepted PDU is done; the refused one waits under a *new* id, because the peer
    // would replay its stored answer for the old one.
    expect(first.delivered).toEqual([]);
    expect(first.deferred).toEqual([ { txnId: 'txn-2', destination: THEM, reason: 'missing auth events' } ]);
    expect(sent.map(entry => entry.txnId)).toEqual([ 'txn-1' ]);
    const pending = await store.pending(SCOPE);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ txnId: 'txn-2', attempts: 1, notBefore: 1_500, lastReason: 'missing auth events' });
    expect(pending[0].pdus.map(p => (p as { event_id: string }).event_id)).toEqual([ '$bad' ]);

    // The waiting retry does not hold the queue: what is behind it may be the very
    // dependencies it is missing, so those are sent while it backs off.
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$later') ] });
    const meanwhile = await outbox.flush({ scope: SCOPE });
    expect(meanwhile).toMatchObject({
      waiting: [ { txnId: 'txn-2', destination: THEM } ],
      blocked: [],
      delivered: [ 'txn-3' ],
    });
    clock.now += 600;
    const after = await outbox.flush({ scope: SCOPE });
    expect(after.delivered).toEqual([ 'txn-2' ]);
    expect(sent.map(entry => entry.txnId)).toEqual([ 'txn-1', 'txn-3', 'txn-2' ]);
  });

  it('gives up on a PDU the peer keeps refusing, instead of retrying forever', async () => {
    const clock = { now: 0 };
    const { outbox, sent } = harness({
      clock,
      pduResults: () => ({ $bad: { error: 'not allowed' } }),
      retryRefused: { initialBackoffMs: 100, maxBackoffMs: 1_000, maxAttempts: 3 },
    });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$bad') ] });

    const reports = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      reports.push(await outbox.flush({ scope: SCOPE }));
      clock.now += 5_000;
    }
    expect(sent).toHaveLength(3);
    expect(reports[2].abandoned).toEqual([ { txnId: 'txn-3', destination: THEM, reason: 'not allowed' } ]);
    // Nothing is left to retry once the attempts are used up.
    expect(reports[3]).toMatchObject({ delivered: [], deferred: [], waiting: [] });
  });

  it('keeps a PDU the peer did not name at all', async () => {
    const clock = { now: 0 };
    const { outbox, store } = harness({
      clock,
      // The peer answered 200 with results for one PDU only.
      pduResults: () => ({ $known: {} }),
      retryRefused: { initialBackoffMs: 0, maxBackoffMs: 0, maxAttempts: 3 },
    });
    await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: [ pdu('$known'), pdu('$unmentioned') ] });
    await outbox.flush({ scope: SCOPE });
    const [ pending ] = await store.pending(SCOPE);
    // Silence is not acceptance: an unnamed PDU is retried.
    expect(pending.pdus.map(p => (p as { event_id: string }).event_id)).toEqual([ '$unmentioned' ]);
  });

  it('generates distinct transaction ids by default', async () => {
    const store = new InMemoryMatrixOutboundStore();
    const outbox = new MatrixOutbox({ store, send: async input => ({ ...outcome('delivered'), txnId: input.txnId }) });
    const batches = await outbox.enqueue({ scope: SCOPE, origin: US, destination: THEM, pdus: Array.from({ length: 120 }, (_, i) => pdu(`$${i}`)) });
    const ids = batches.map((batch: MatrixOutboundBatch) => batch.txnId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => id.length > 0 && !id.includes('/'))).toBe(true);
  });
});

describe('ordering PDUs by their dependencies', () => {
  it('puts parents and authorisers first, and leaves unrelated PDUs in place', () => {
    const a = { event_id: '$a' };
    const b = { event_id: '$b', prev_events: [ '$a' ] };
    const c = { event_id: '$c', auth_events: [ [ '$b', { sha256: 'x' } ] ] };
    const lone = { event_id: '$lone' };
    expect(orderByDependencies([ c, b, lone, a ]).map(p => (p as { event_id: string }).event_id))
      .toEqual([ '$lone', '$a', '$b', '$c' ]);
  });

  it('ignores dependencies that are not in the batch, and keeps a cycle in input order', () => {
    const a = { event_id: '$a', prev_events: [ '$outside' ] };
    const x = { event_id: '$x', prev_events: [ '$y' ] };
    const y = { event_id: '$y', prev_events: [ '$x' ] };
    expect(orderByDependencies([ a ])).toEqual([ a ]);
    expect(orderByDependencies([ x, y ])).toEqual([ x, y ]);
  });

  it('leaves PDUs without an event id at the end, in input order', () => {
    const withId = { event_id: '$a' };
    const anonymous = { type: 'm.room.message' };
    expect(orderByDependencies([ anonymous, withId ])).toEqual([ withId, anonymous ]);
  });
});
