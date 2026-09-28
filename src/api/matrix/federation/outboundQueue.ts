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
 * - **A 200 is not the same as "every PDU was taken".** The peer answers 200 with a
 *   per-PDU result, and a PDU it refused (most often because it lacks the events that
 *   authorise it) is retried — under a **new transaction id**, because the peer stores its
 *   answer for the old one and would replay it (see `inboundTransaction.ts`). Retries are
 *   bounded and backed off, and a batch that runs out of attempts is reported as abandoned
 *   rather than retried forever.
 *
 * A transaction's PDUs are ordered so that an event never travels before the events it
 * names in `prev_events`/`auth_events` when both are in the same batch: the receiver checks
 * authorisation as it processes them, and a dependent that arrives first can only be refused.
 *
 * The store is scope-sharded and whole-record keyed, so the durable (control Pod) carrier
 * can replace the in-memory one without touching this logic.
 */
import { randomBytes } from 'node:crypto';
import { eventReferenceIds } from '../protocol/eventReferences';
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
  /** How many times this batch's PDUs have been attempted, across transaction ids. */
  attempts: number;
  /** Not before this moment, so a retry cannot become a hot loop. */
  notBefore?: number;
  /** Why the last attempt did not deliver it, for logs and operators. */
  lastReason?: string;
}

export interface MatrixOutboundStore {
  /** The scopes holding work, so a scheduler can flush without being told which Pods exist. */
  scopes(): Promise<readonly string[]>;
  /** Batches still to send, oldest first. */
  pending(scope: string, filter?: { origin?: string; destination?: string }): Promise<MatrixOutboundBatch[]>;
  /** Insert or replace one batch, keyed by transaction id. */
  put(scope: string, batch: MatrixOutboundBatch): Promise<void>;
  /** Drop a batch that has settled: delivered, or refused by the destination. */
  /**
   * Forget a batch. The whole batch rather than its id, because a carrier that addresses batches by
   * document needs to know which queue the id belonged to — a transaction id is only unique within
   * one (origin, destination).
   */
  remove(scope: string, batch: Pick<MatrixOutboundBatch, 'origin' | 'destination' | 'txnId'>): Promise<void>;
}

export interface MatrixOutboxReport {
  delivered: string[];
  rejected: { txnId: string; destination: string; reason: string }[];
  /** Batches that were attempted and are waiting to be retried, under a new transaction id. */
  deferred: { txnId: string; destination: string; reason: string }[];
  /** Batches left alone because an earlier transaction in the same queue is not settled. */
  blocked: { txnId: string; destination: string }[];
  /** Batches whose backoff has not elapsed, so this flush did not touch them. */
  waiting: { txnId: string; destination: string }[];
  /** Batches that used up their attempts and were dropped, with the last reason. */
  abandoned: { txnId: string; destination: string; reason: string }[];
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
  /** How a PDU the peer refused inside a delivered transaction is retried. */
  retryRefused?: {
    /** Attempts per batch, including the first one. Defaults to 5. */
    maxAttempts?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
  };
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
  private readonly retryRefused: Required<NonNullable<MatrixOutboxOptions['retryRefused']>>;

  public constructor(options: MatrixOutboxOptions) {
    this.store = options.store;
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.newTransactionId = options.newTransactionId ?? (() => randomBytes(18).toString('base64url'));
    this.maxPdus = options.maxPdusPerTransaction ?? MAX_PDUS_PER_TRANSACTION;
    this.maxEdus = options.maxEdusPerTransaction ?? MAX_EDUS_PER_TRANSACTION;
    this.retryRefused = {
      maxAttempts: options.retryRefused?.maxAttempts ?? 5,
      initialBackoffMs: options.retryRefused?.initialBackoffMs ?? 1_000,
      maxBackoffMs: options.retryRefused?.maxBackoffMs ?? 60_000,
    };
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
      const extended: MatrixOutboundBatch = {
        ...open,
        pdus: orderByDependencies([ ...open.pdus, ...fresh ]),
        edus: [ ...open.edus, ...edus ],
      };
      await this.store.put(input.scope, extended);
      batches.push(extended);
      return batches;
    }

    while (restPdus.length > 0 || restEdus.length > 0) {
      const batch: MatrixOutboundBatch = {
        txnId: this.newTransactionId(),
        origin: input.origin,
        destination: input.destination,
        pdus: orderByDependencies(restPdus.slice(0, this.maxPdus)),
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
  /** The scopes with work queued, for whoever drives delivery. */
  public async scopes(): Promise<readonly string[]> {
    return await this.store.scopes();
  }

  public async flush(input: { scope: string; origin?: string; destination?: string }): Promise<MatrixOutboxReport> {
    const report: MatrixOutboxReport = { delivered: [], rejected: [], deferred: [], blocked: [], waiting: [], abandoned: [] };
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
        // A batch that is backing off is skipped, but it does **not** hold the queue: it is
        // usually waiting for events that are queued behind it (a PDU the peer refused for
        // missing dependencies), and blocking those would deadlock the queue.
        if (batch.notBefore !== undefined && batch.notBefore > this.now()) {
          report.waiting.push({ txnId: batch.txnId, destination });
          continue;
        }
        const outcome = await this.send({
          origin,
          destination,
          txnId: batch.txnId,
          pdus: batch.pdus,
          ...(batch.edus.length === 0 ? {} : { edus: batch.edus }),
        });
        if (outcome.status === 'rejected') {
          // The peer decided; the queue is free to move on to the next transaction.
          await this.store.remove(input.scope, batch);
          report.rejected.push({ txnId: batch.txnId, destination, reason: outcome.reason });
          continue;
        }
        if (outcome.status === 'delivered') {
          await this.store.remove(input.scope, batch);
          const refused = refusedPdus(batch.pdus, outcome.pdus);
          if (refused.length === 0) {
            report.delivered.push(batch.txnId);
            continue;
          }
          // A 200 answers the transaction, not every PDU in it. The refused ones are retried
          // under a new id — the peer would replay its stored answer for this one.
          const attempts = batch.attempts + 1;
          const reason = refusedReason(batch.pdus, outcome.pdus);
          if (attempts >= this.retryRefused.maxAttempts) {
            report.abandoned.push({ txnId: batch.txnId, destination, reason });
            continue;
          }
          const retry: MatrixOutboundBatch = {
            txnId: this.newTransactionId(),
            origin,
            destination,
            pdus: refused,
            edus: batch.edus,
            createdAt: this.now(),
            attempts,
            notBefore: this.now() + this.backoffMs(attempts),
            lastReason: reason,
          };
          await this.store.put(input.scope, retry);
          report.deferred.push({ txnId: retry.txnId, destination, reason });
          // Later batches keep their turn: the dependencies this one is missing may well be
          // among them, and holding them back would be a deadlock.
          continue;
        }
        // A transaction the peer never answered is retried under the *same* id, and the
        // queue behind it waits: those events may depend on this one, and the peer has not
        // seen any of it yet.
        await this.store.put(input.scope, {
          ...batch,
          attempts: batch.attempts + 1,
          lastReason: outcome.reason,
        });
        report.deferred.push({ txnId: batch.txnId, destination, reason: outcome.reason });
        blockBehind(report, batches.slice(index + 1), destination);
        break;
      }
    }
    return report;
  }

  /** Exponential backoff for a batch that keeps being refused, bounded. */
  private backoffMs(attempts: number): number {
    return Math.min(this.retryRefused.initialBackoffMs * 2 ** Math.max(0, attempts - 1), this.retryRefused.maxBackoffMs);
  }
}

function blockBehind(report: MatrixOutboxReport, behind: readonly MatrixOutboundBatch[], destination: string): void {
  for (const batch of behind) report.blocked.push({ txnId: batch.txnId, destination });
}

/**
 * The PDUs the peer did not take. A transaction answered 200 without any per-PDU results is
 * taken as delivered wholesale — there is nothing to act on — but once the peer reports
 * results, an entry it did not name is *not* evidence that it accepted the PDU, so that PDU
 * is kept and retried rather than silently dropped.
 */
function refusedPdus(pdus: readonly unknown[], results: Record<string, { error?: string }> | undefined): unknown[] {
  if (!results) return [];
  return pdus.filter(pdu => {
    const id = eventIdOf(pdu);
    if (id === undefined) return true;
    const result = results[id];
    return result === undefined || result.error !== undefined;
  });
}

function refusedReason(pdus: readonly unknown[], results: Record<string, { error?: string }> | undefined): string {
  const reasons = pdus
    .map(pdu => (eventIdOf(pdu) === undefined ? 'a PDU without an event id' : results?.[eventIdOf(pdu)!]?.error))
    .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
  return reasons.length > 0 ? reasons.join('; ') : 'the peer did not report these PDUs as handled';
}

/**
 * Order a batch so an event never precedes the events it names in `prev_events` or
 * `auth_events` when they are in the same batch. Dependencies outside the batch are ignored
 * (they are the peer's problem, and it fetches them); a cycle keeps the input order, which
 * is the best a single pass can honestly do.
 */
export function orderByDependencies(pdus: readonly unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  for (const pdu of pdus) {
    const id = eventIdOf(pdu);
    if (id !== undefined && !byId.has(id)) byId.set(id, pdu);
  }
  const dependencies = new Map<string, string[]>();
  for (const [ id, pdu ] of byId) {
    dependencies.set(id, [
      ...eventReferenceIds(pdu, 'prev_events'),
      ...eventReferenceIds(pdu, 'auth_events'),
    ].filter(reference => byId.has(reference)));
  }

  const ordered: unknown[] = [];
  const emitted = new Set<string>();
  let remaining = [ ...byId.keys() ];
  while (remaining.length > 0) {
    const ready = remaining.filter(id => (dependencies.get(id) ?? []).every(dep => emitted.has(dep)));
    // Nothing is ready: a cycle (or a self reference), so keep the remaining input order.
    const batch = ready.length > 0 ? ready : remaining;
    for (const id of batch) {
      ordered.push(byId.get(id));
      emitted.add(id);
    }
    remaining = remaining.filter(id => !emitted.has(id));
  }
  // PDUs without an event id cannot be ordered; they keep their place at the end.
  return [ ...ordered, ...pdus.filter(pdu => eventIdOf(pdu) === undefined) ];
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

  public async scopes(): Promise<readonly string[]> {
    return [ ...this.batches.keys() ].filter(scope => (this.batches.get(scope) ?? []).length > 0).sort();
  }

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

  public async remove(scope: string, batch: Pick<MatrixOutboundBatch, 'origin' | 'destination' | 'txnId'>): Promise<void> {
    const all = this.batches.get(scope);
    if (!all) return;
    this.batches.set(scope, all.filter(existing => existing.txnId !== batch.txnId));
  }
}
