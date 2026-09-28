/**
 * The Pod carrier for inbound transaction receipts.
 *
 * `InMemoryMatrixInboundTransactionStore` answers a peer's retry correctly for as long as the
 * process lives; this one answers it after a restart too, which is the whole reason the contract
 * puts the record in the Pod. Both implement the same port, so nothing above changes.
 *
 * Reserving is **best effort, not a compare-and-swap**: records share a day document (the models
 * layout for records that accumulate), and a shared document cannot be created once per key. Two
 * callers racing for one transaction id can both be told they claimed it; what holds instead is
 * that the record is written once and a replay is answered from it. `controlRecords.ts` carries the
 * measurement and the reasoning, and the contract's §6.3 says what was traded away and why it is
 * safe here: accepting an event is idempotent by event id, so two processors write the same events
 * and only the stored response can differ.
 *
 * The resolved Pod arrives per call rather than in the constructor. The transaction layer already
 * resolved it once for this request — that is where "which Pod, and with whose authority" is
 * decided — and a store that resolved it again would be a second decision about the same thing.
 * `scope` stays in the interface and is checked against the handle: a record must never be read or
 * written in a Pod other than the one the caller has authority for, and a store handed no authority
 * refuses instead of guessing which Pod a key meant.
 */
import { MatrixError } from '../MatrixError';
import {
  deleteControlRecord,
  readControlRecord,
  updateControlRecord,
  writeControlRecord,
  type MatrixControlRecord,
  type MatrixControlRecordTarget,
} from '../controlRecords';
import type {
  MatrixInboundTransactionRecord,
  MatrixInboundTransactionStore,
  MatrixSendResponse,
} from './inboundTransaction';

/** The Pod a keyed control record belongs to, and the authority to write it. */
export type MatrixControlRecordHandle = MatrixControlRecordTarget;

/** The row's `metadata` payload for one transaction: the key facts, readable in the Pod. */
interface InboundRecordMetadata {
  protocol: 'matrix';
  kind: 'inbound-transaction';
  origin: string;
  transactionId: string;
  payloadFingerprint: string;
  receivedAt: string;
  response?: MatrixSendResponse;
  completedAt?: string;
  conflictAt?: string;
  [key: string]: unknown;
}

/** `taskResource.status`: a reservation is work in hand, a receipt is work done. */
const STATUS_RESERVED = 'active';
const STATUS_COMPLETED = 'completed';

export class PodMatrixInboundTransactionStore implements MatrixInboundTransactionStore {
  /**
   * Claim a transaction id, or return the record that already holds it.
   *
   * A record that exists but is not complete is *not* answered from here: the caller is told to
   * retry, because the first attempt may still be writing. A record whose payload differs is
   * marked, never replaced — the first attempt's answer is the one the peer must get back.
   *
   * Claiming is best effort (see the module note): a caller told `created: true` may have a
   * concurrent twin. Everything downstream is idempotent by event id, so the cost is a second
   * validation pass, not a second event.
   */
  public async reserve(
    scope: string,
    input: { origin: string; transactionId: string; payloadFingerprint: string; receivedAt: string },
    handle?: MatrixControlRecordHandle,
  ): Promise<{ record: MatrixInboundTransactionRecord; created: boolean }> {
    const target = requireHandle(scope, handle);
    const key = transactionKey(input.origin, input.transactionId);
    const { record, created } = await writeControlRecord(target, {
      key,
      at: input.receivedAt,
      instruction: `Record the inbound Matrix transaction ${input.origin}/${input.transactionId}`,
      status: STATUS_RESERVED,
      metadata: {
        protocol: 'matrix',
        kind: 'inbound-transaction',
        origin: input.origin,
        transactionId: input.transactionId,
        payloadFingerprint: input.payloadFingerprint,
        receivedAt: input.receivedAt,
      },
    });
    const decoded = decode(record);
    if (!created && decoded.payloadFingerprint !== input.payloadFingerprint && decoded.conflictAt === undefined) {
      // The first record stands. The conflict is written down so an operator can see that a sender
      // reused a transaction id for a different payload, and so a later retry does not re-mark it.
      decoded.conflictAt = input.receivedAt;
      await updateControlRecord(target, record, {
        status: record.status,
        metadata: { ...record.metadata, conflictAt: decoded.conflictAt },
      });
    }
    return { record: decoded, created };
  }

  /** Attach what the first attempt answered. Only the winner of `reserve` calls this. */
  public async complete(
    scope: string,
    key: { origin: string; transactionId: string },
    response: MatrixSendResponse,
    completedAt: string,
    handle?: MatrixControlRecordHandle,
  ): Promise<void> {
    const target = requireHandle(scope, handle);
    const recordKey = transactionKey(key.origin, key.transactionId);
    const existing = await readControlRecord(target, recordKey);
    if (!existing) throw new MatrixError(500, 'M_UNKNOWN', 'Matrix inbound transaction disappeared');
    await updateControlRecord(target, existing, {
      status: STATUS_COMPLETED,
      metadata: { ...existing.metadata, response, completedAt },
    });
  }

  /**
   * Forget a reservation whose processing threw, so the peer's retry may try again.
   *
   * Deleting is what makes the retry a *new* create-once, which is safe because accepting an event
   * is idempotent by event id: what the failed attempt already wrote stays as it is.
   */
  public async release(
    scope: string,
    key: { origin: string; transactionId: string },
    handle?: MatrixControlRecordHandle,
  ): Promise<void> {
    const target = requireHandle(scope, handle);
    const recordKey = transactionKey(key.origin, key.transactionId);
    const existing = await readControlRecord(target, recordKey);
    if (existing) await deleteControlRecord(target, existing);
  }

  public async find(
    scope: string,
    key: { origin: string; transactionId: string },
    handle?: MatrixControlRecordHandle,
  ): Promise<MatrixInboundTransactionRecord | undefined> {
    const target = requireHandle(scope, handle);
    const record = await readControlRecord(target, transactionKey(key.origin, key.transactionId));
    return record ? decode(record) : undefined;
  }
}

function requireHandle(scope: string, handle: MatrixControlRecordHandle | undefined): MatrixControlRecordTarget {
  if (!handle) {
    throw new MatrixError(500, 'M_UNKNOWN',
      'A Pod-backed transaction store needs the resolved Pod handle; without it there is no Pod to write');
  }
  if (handle.scope !== scope) {
    throw new MatrixError(500, 'M_UNKNOWN',
      `Transaction scope ${scope} does not match the resolved Pod ${handle.scope}`);
  }
  return handle;
}

/**
 * The record key for a transaction.
 *
 * The Pod is not part of the key: a record's document is already inside one Pod, and the scope is
 * checked against the handle instead, so the same transaction in two Pods cannot collide.
 */
function transactionKey(origin: string, transactionId: string): string {
  return JSON.stringify([ origin, transactionId ]);
}

function decode(record: MatrixControlRecord): MatrixInboundTransactionRecord {
  const metadata = record.metadata as InboundRecordMetadata;
  return {
    origin: String(metadata.origin),
    transactionId: String(metadata.transactionId),
    payloadFingerprint: String(metadata.payloadFingerprint),
    response: isResponse(metadata.response) ? metadata.response : { pdus: {}},
    receivedAt: String(metadata.receivedAt),
    ...(typeof metadata.completedAt === 'string' ? { completedAt: metadata.completedAt } : {}),
    ...(typeof metadata.conflictAt === 'string' ? { conflictAt: metadata.conflictAt } : {}),
  };
}

function isResponse(value: unknown): value is MatrixSendResponse {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { pdus?: unknown }).pdus === 'object';
}
