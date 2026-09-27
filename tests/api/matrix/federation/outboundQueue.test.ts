import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMatrixOutboundStore,
  MatrixOutbox,
  type MatrixOutboundBatch,
} from '../../../../src/api/matrix/federation/outboundQueue';
import type { MatrixDeliveryOutcome, MatrixDeliveryStatus } from '../../../../src/api/matrix/federation/outboundTransaction';

const SCOPE = 'https://pod.example/alice/';
const THEM = 'remote.example';
const OTHER = 'other.example';

function pdu(id: string) {
  return { event_id: id, type: 'm.room.message', content: { body: id } };
}

function outcome(status: MatrixDeliveryStatus, reason = status): MatrixDeliveryOutcome {
  return { status, origin: 'pod.example', destination: THEM, txnId: '-', reason };
}

function harness(options: {
  results?: MatrixDeliveryStatus[] | ((input: { destination: string; txnId: string }) => MatrixDeliveryStatus);
  store?: InMemoryMatrixOutboundStore;
} = {}) {
  const store = options.store ?? new InMemoryMatrixOutboundStore();
  let index = 0;
  const sent: { destination: string; txnId: string; pdus: readonly unknown[]; edus?: readonly unknown[] }[] = [];
  const send = vi.fn(async (input: { destination: string; txnId: string; pdus: readonly unknown[]; edus?: readonly unknown[] }) => {
    sent.push(input);
    const status = typeof options.results === 'function'
      ? options.results(input)
      : options.results?.[index] ?? 'delivered';
    index += 1;
    return { ...outcome(status), destination: input.destination, txnId: input.txnId };
  });
  let counter = 0;
  const outbox = new MatrixOutbox({
    store,
    send,
    now: () => 1_000,
    newTransactionId: () => `txn-${++counter}`,
  });
  return { outbox, store, send, sent };
}

describe('queueing outbound transactions', () => {
  it('creates one batch per destination with its own transaction id', async () => {
    const { outbox, store } = harness();
    const batches = await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a'), pdu('$b') ] });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ destination: THEM, txnId: 'txn-1', attempts: 0, createdAt: 1_000 });
    expect(batches[0].pdus.map(p => (p as { event_id: string }).event_id)).toEqual([ '$a', '$b' ]);
    expect(await store.pending(SCOPE)).toHaveLength(1);
    expect(await store.pending(SCOPE, OTHER)).toEqual([]);
  });

  it('splits more PDUs than a transaction may carry, preserving order', async () => {
    const { outbox } = harness();
    const pdus = Array.from({ length: 120 }, (_, i) => pdu(`$${i}`));
    const batches = await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus });

    expect(batches.map(batch => batch.pdus.length)).toEqual([ 50, 50, 20 ]);
    expect(batches.map(batch => batch.txnId)).toEqual([ 'txn-1', 'txn-2', 'txn-3' ]);
    const flattened = batches.flatMap(batch => batch.pdus.map(p => (p as { event_id: string }).event_id));
    expect(flattened).toEqual(pdus.map(p => (p as { event_id: string }).event_id));
  });

  it('drops PDUs it already owes that destination, and does not dedup what has no id', async () => {
    const { outbox } = harness();
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] });
    const second = await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a'), pdu('$b'), { type: 'x' }, { type: 'x' } ] });

    // Appended to the batch that has never been attempted, so it keeps its transaction id.
    expect(second).toHaveLength(1);
    expect(second[0].txnId).toBe('txn-1');
    const ids = second[0].pdus.map(p => (p as { event_id?: string }).event_id ?? 'anonymous');
    expect(ids).toEqual([ '$a', '$b', 'anonymous', 'anonymous' ]);
  });

  it('is a no-op when there is nothing to send', async () => {
    const { outbox, store } = harness();
    await expect(outbox.enqueue({ scope: SCOPE, destination: THEM })).resolves.toEqual([]);
    await expect(outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] })).resolves.toHaveLength(1);
    // Everything already queued: nothing new to say.
    await expect(outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] })).resolves.toEqual([]);
    expect(await store.pending(SCOPE)).toHaveLength(1);
  });

  it('never appends to a batch the destination may already have seen', async () => {
    const { outbox, store } = harness({ results: [ 'retry' ] });
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.flush({ scope: SCOPE });

    const batches = await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$b') ] });
    // Appending to txn-1 would hide $b behind a stored response the peer replays, so a new
    // transaction id has to be minted instead.
    expect(batches).toHaveLength(1);
    expect(batches[0].txnId).toBe('txn-2');
    const pending = await store.pending(SCOPE);
    expect(pending.map(batch => batch.txnId)).toEqual([ 'txn-1', 'txn-2' ]);
  });

  it('keeps scopes and destinations apart', async () => {
    const { outbox, store } = harness();
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, destination: OTHER, pdus: [ pdu('$b') ] });
    await outbox.enqueue({ scope: 'https://pod.example/bob/', destination: THEM, pdus: [ pdu('$c') ] });

    expect((await store.pending(SCOPE)).map(batch => batch.destination)).toEqual([ THEM, OTHER ]);
    expect((await store.pending('https://pod.example/bob/')).map(batch => batch.destination)).toEqual([ THEM ]);
  });

  it('carries EDUs, including a transaction with no PDUs at all', async () => {
    const { outbox, store } = harness();
    await outbox.enqueue({ scope: SCOPE, destination: THEM, edus: [ { edu_type: 'm.typing' } ] });
    const [ batch ] = await store.pending(SCOPE);
    expect(batch.pdus).toEqual([]);
    expect(batch.edus).toEqual([ { edu_type: 'm.typing' } ]);
  });
});

describe('flushing the queue', () => {
  it('delivers oldest first and empties the queue', async () => {
    const { outbox, store, sent } = harness({ results: [ 'delivered', 'delivered' ] });
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: Array.from({ length: 60 }, (_, i) => pdu(`$${i}`)) });
    const report = await outbox.flush({ scope: SCOPE });

    expect(report.delivered).toEqual([ 'txn-1', 'txn-2' ]);
    expect(report.deferred).toEqual([]);
    expect(sent.map(entry => entry.txnId)).toEqual([ 'txn-1', 'txn-2' ]);
    expect(sent[0].pdus).toHaveLength(50);
    expect(sent[1].pdus).toHaveLength(10);
    expect(await store.pending(SCOPE)).toEqual([]);
  });

  it('stops a destination at the first failure, leaving later transactions alone', async () => {
    const { outbox, store, sent } = harness({ results: [ 'retry', 'delivered' ] });
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: Array.from({ length: 60 }, (_, i) => pdu(`$${i}`)) });
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
    const { outbox } = harness({ results: [ 'retry', 'retry', 'delivered' ] });
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] });

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
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: Array.from({ length: 60 }, (_, i) => pdu(`$${i}`)) });
    const report = await outbox.flush({ scope: SCOPE });

    expect(report.rejected).toEqual([ { txnId: 'txn-1', destination: THEM, reason: 'rejected' } ]);
    expect(report.delivered).toEqual([ 'txn-2' ]);
    expect(report.blocked).toEqual([]);
    expect(await store.pending(SCOPE)).toEqual([]);
  });

  it('lets a healthy destination through while another is stuck', async () => {
    const { outbox, sent } = harness({
      results: input => (input.destination === THEM ? 'retry' : 'delivered'),
    });
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, destination: OTHER, pdus: [ pdu('$b') ] });
    const report = await outbox.flush({ scope: SCOPE });

    expect(report.delivered).toHaveLength(1);
    expect(report.deferred).toHaveLength(1);
    // Both destinations were attempted; only the failing one holds its own queue.
    expect(sent.map(entry => entry.destination)).toEqual([ THEM, OTHER ]);
  });

  it('can flush a single destination', async () => {
    const { outbox, store, sent } = harness();
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ] });
    await outbox.enqueue({ scope: SCOPE, destination: OTHER, pdus: [ pdu('$b') ] });
    const report = await outbox.flush({ scope: SCOPE, destination: OTHER });

    expect(report.delivered).toEqual([ 'txn-2' ]);
    expect(sent.map(entry => entry.destination)).toEqual([ OTHER ]);
    expect((await store.pending(SCOPE)).map(batch => batch.destination)).toEqual([ THEM ]);
  });

  it('passes EDUs on the wire and reports nothing to do as nothing done', async () => {
    const { outbox, send, sent } = harness();
    await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: [ pdu('$a') ], edus: [ { edu_type: 'm.typing' } ] });
    await outbox.flush({ scope: SCOPE });
    expect(sent[0].edus).toEqual([ { edu_type: 'm.typing' } ]);

    send.mockClear();
    const empty = await outbox.flush({ scope: SCOPE });
    expect(empty).toEqual({ delivered: [], rejected: [], deferred: [], blocked: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('generates distinct transaction ids by default', async () => {
    const store = new InMemoryMatrixOutboundStore();
    const outbox = new MatrixOutbox({ store, send: async input => ({ ...outcome('delivered'), txnId: input.txnId }) });
    const batches = await outbox.enqueue({ scope: SCOPE, destination: THEM, pdus: Array.from({ length: 120 }, (_, i) => pdu(`$${i}`)) });
    const ids = batches.map((batch: MatrixOutboundBatch) => batch.txnId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => id.length > 0 && !id.includes('/'))).toBe(true);
  });
});
