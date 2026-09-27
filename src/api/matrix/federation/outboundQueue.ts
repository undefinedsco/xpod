/**
 * The queue of transactions this deployment still owes other servers.
 *
 * `outboundTransaction.ts` knows how to send *one* transaction and when retrying is
 * worth anything; this module decides *what* to send and *in which order*, which is
 * where the specification's other federation rule lives:
 *
 * > the sending server must wait and retry for a 200 OK response before sending a
 * > transaction with a different `txnId` to the receiving server
 *
 * So a *(origin, destination)* pair is a strictly ordered queue: while one transaction is
 * undelivered, nothing behind it is attempted (it would be a different txnId), and a queue
 * that is stuck does not hold up any other. The origin is part of the pair because each
 * participant is their own server and the peer's dedup key is (origin, txnId): two
 * origins this deployment hosts are two independent senders. A batch therefore owns its
 * transaction id from the moment it is created until it is delivered or refused — the id
 * is the peer's dedup key, so re-minting one mid-flight is exactly the bug this prevents.
 *
 * Two consequences that are easy to get wrong, and are decided here:
 *
 * - **PDUs may only be appended to a batch that has never been attempted.** Appending to
 *   a batch the peer may already have processed would put the new PDUs behind a
 *   transaction id whose *stored response* the peer replays (see `inboundTransaction.ts`),
 *   so they would be silently dropped forever.
 * - **A refusal unblocks the queue, a failure does not.** A 4xx means the peer decided
 *   about that transaction; treating it as retryable would wedge the destination.
 *
 * The store is scope-sharded and whole-record keyed, so the durable (control Pod) carrier
 * can replace the in-memory one without touching this logic.
 */
import { randomBytes } from 'node:crypto';
import { MAX_EDUS_PER_TRANSACTION, MAX_PDUS_PER_TRANSACTION, type MatrixDeliveryOutcome } from './outboundTransaction';

export interface MatrixOutboundBatch {
  txnId: string;
  /**
   * The server this transaction is sent *as*. Each participant is their own server, so a
   * batch belongs to one origin, and the peer's dedup key is (origin, txnId).
   */
  origin: string;
  destination: string;
  pdus: unknown[];
  edus: unknown[];
  createdAt: number;
  /** How many times this batch (under this id) has been attempted. */
  attempts: number;
  /** Why the last attempt did not deliver it, for logs and operators. */
  lastReason?: string;
}

export interface MatrixOutboundStore {
  /** Batches still to send, oldest first. */
  pending(scope: string, filter?: { origin?: string; destination?: string }): Promise<MatrixOutboundBatch[]>;
  /** Insert or replace one batch, keyed by transaction id. */
  put(scope: string, batch: MatrixOutboundBatch): Promise<void>;
  /** Drop a batch that has settled: delivered, or refused by the destination. */
  remove(scope: string, txnId: string): Promise<void>;
}

export interface MatrixOutboxReport {
  delivered: string[];
  rejected: { txnId: string; destination: string; reason: string }[];
  deferred: { txnId: string; destination: string; reason: string }[];
  /** Batches left alone because an earlier transaction to that destination is pending. */
  blocked: { txnId: string; destination: string }[];
}

export interface MatrixOutboxOptions {
  store: MatrixOutboundStore;
  /**
   * Sends one transaction. In production this is `MatrixFederationClient.deliverTransaction`,
   * which already spends a bounded number of retries with backoff; a batch that is still
   * undelivered after that stays queued here, so this queue absorbs longer outages.
   */
  send(input: { origin: string; destination: string; txnId: string; pdus: readonly unknown[]; edus?: readonly unknown[] }): Promise<MatrixDeliveryOutcome>;
  now?: () => number;
  /** Transaction ids are opaque; this is injectable so tests are deterministic. */
  newTransactionId?: () => string;
  maxPdusPerTransaction?: number;
  maxEdusPerTransaction?: number;
}

export interface EnqueueInput {
  scope: string;
  /** The server the PDUs are from; it signs the transaction. */
  origin: string;
  destination: string;
  pdus?: readonly unknown[];
  edus?: readonly unknown[];
}

export class MatrixOutbox {
  private readonly store: MatrixOutboundStore;
  private readonly send: MatrixOutboxOptions['send'];
  private readonly now: () => number;
  private readonly newTransactionId: () => string;
  private readonly maxPdus: number;
  private readonly maxEdus: number;

  public constructor(options: MatrixOutboxOptions) {
    this.store = options.store;
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.newTransactionId = options.newTransactionId ?? (() => randomBytes(18).toString('base64url'));
    this.maxPdus = options.maxPdusPerTransaction ?? MAX_PDUS_PER_TRANSACTION;
    this.maxEdus = options.maxEdusPerTransaction ?? MAX_EDUS_PER_TRANSACTION;
  }

  /**
   * Queue what a destination does not know yet. Returns the batches that were created or
   * extended, so a caller can flush immediately instead of reading the queue back.
   */
  public async enqueue(input: EnqueueInput): Promise<MatrixOutboundBatch[]> {
    const pending = await this.store.pending(input.scope, { origin: input.origin, destination: input.destination });
    const queued = new Set(pending.flatMap(batch => batch.pdus.map(eventIdOf).filter((id): id is string => id !== undefined)));
    const pdus = [ ...(input.pdus ?? []) ];
    const edus = [ ...(input.edus ?? []) ];
    // The same event reaching the queue twice is the normal case (a peer already relayed
    // it), and the peer would dedup it by event id anyway; the queue just avoids the trip.
    const fresh = pdus.filter(pdu => {
      const id = eventIdOf(pdu);
      return id === undefined || !queued.has(id);
    });
    if (fresh.length === 0 && edus.length === 0) return [];

    const batches: MatrixOutboundBatch[] = [];
    // A never-attempted batch has room, and its id has not been seen by the peer yet.
    const open = pending.filter(batch => batch.attempts === 0).at(-1);
    let restPdus = fresh;
    let restEdus = edus;
    if (open && open.pdus.length + fresh.length <= this.maxPdus && open.edus.length + edus.length <= this.maxEdus) {
      const extended: MatrixOutboundBatch = { ...open, pdus: [ ...open.pdus, ...fresh ], edus: [ ...open.edus, ...edus ] };
      await this.store.put(input.scope, extended);
      batches.push(extended);
      return batches;
    }

    while (restPdus.length > 0 || restEdus.length > 0) {
      const batch: MatrixOutboundBatch = {
        txnId: this.newTransactionId(),
        origin: input.origin,
        destination: input.destination,
        pdus: restPdus.slice(0, this.maxPdus),
        edus: restEdus.slice(0, this.maxEdus),
        createdAt: this.now(),
        attempts: 0,
      };
      restPdus = restPdus.slice(this.maxPdus);
      restEdus = restEdus.slice(this.maxEdus);
      await this.store.put(input.scope, batch);
      batches.push(batch);
    }
    return batches;
  }

  /**
   * Try to send what is pending, oldest first, one transaction at a time per destination.
   * A transaction that defers stops its own queue there, as the specification requires.
   */
  public async flush(input: { scope: string; origin?: string; destination?: string }): Promise<MatrixOutboxReport> {
    const report: MatrixOutboxReport = { delivered: [], rejected: [], deferred: [], blocked: [] };
    const pending = await this.store.pending(input.scope, {
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.destination === undefined ? {} : { destination: input.destination }),
    });
    // A transaction is a pair: the peer dedups on (origin, txnId), so two origins this
    // deployment hosts are two independent queues even towards the same destination.
    const byPair = new Map<string, MatrixOutboundBatch[]>();
    for (const batch of pending) {
      const key = `${batch.origin}\u0000${batch.destination}`;
      const list = byPair.get(key);
      if (list) list.push(batch);
      else byPair.set(key, [ batch ]);
    }

    for (const batches of byPair.values()) {
      const { origin, destination } = batches[0];
      for (const [ index, batch ] of batches.entries()) {
        const outcome = await this.send({
          origin,
          destination,
          txnId: batch.txnId,
          pdus: batch.pdus,
          ...(batch.edus.length === 0 ? {} : { edus: batch.edus }),
        });
        if (outcome.status === 'delivered') {
          await this.store.remove(input.scope, batch.txnId);
          report.delivered.push(batch.txnId);
          continue;
        }
        if (outcome.status === 'rejected') {
          // The peer decided; the queue is free to move on to the next transaction.
          await this.store.remove(input.scope, batch.txnId);
          report.rejected.push({ txnId: batch.txnId, destination, reason: outcome.reason });
          continue;
        }
        await this.store.put(input.scope, {
          ...batch,
          attempts: batch.attempts + 1,
          lastReason: outcome.reason,
        });
        report.deferred.push({ txnId: batch.txnId, destination, reason: outcome.reason });
        // Anything behind this batch would be a different txnId to the same server.
        for (const behind of batches.slice(index + 1)) {
          report.blocked.push({ txnId: behind.txnId, destination });
        }
        break;
      }
    }
    return report;
  }
}

/** The `event_id` a PDU carries, when it has one; PDUs without one cannot be deduped. */
function eventIdOf(pdu: unknown): string | undefined {
  if (typeof pdu !== 'object' || pdu === null || Array.isArray(pdu)) return undefined;
  const id = (pdu as Record<string, unknown>).event_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The in-memory carrier; the control Pod implementation replaces it behind the same port. */
export class InMemoryMatrixOutboundStore implements MatrixOutboundStore {
  private readonly batches = new Map<string, MatrixOutboundBatch[]>();

  public async pending(scope: string, filter?: { origin?: string; destination?: string }): Promise<MatrixOutboundBatch[]> {
    const all = this.batches.get(scope) ?? [];
    return all
      .filter(batch => (filter?.origin === undefined || batch.origin === filter.origin)
        && (filter?.destination === undefined || batch.destination === filter.destination))
      .map(batch => structuredClone(batch))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  public async put(scope: string, batch: MatrixOutboundBatch): Promise<void> {
    const all = this.batches.get(scope) ?? [];
    const index = all.findIndex(existing => existing.txnId === batch.txnId);
    const stored = structuredClone(batch);
    if (index >= 0) all[index] = stored;
    else all.push(stored);
    this.batches.set(scope, all);
  }

  public async remove(scope: string, txnId: string): Promise<void> {
    const all = this.batches.get(scope);
    if (!all) return;
    this.batches.set(scope, all.filter(batch => batch.txnId !== txnId));
  }
}
