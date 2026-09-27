/**
 * A peer's transaction: reserve it once, answer the same way every time after.
 *
 * `PUT /_matrix/federation/v1/send/{txnId}` is retried by senders whenever a response
 * is lost, so the receiving side has to be idempotent per (origin server, transaction
 * id): a replay returns the response the first attempt produced, and a retry that
 * carries *different* PDUs under the same id must not overwrite the first record.
 *
 * The record is kept behind `MatrixInboundTransactionStore` on purpose. The decision
 * this belongs to — a control-Pod record with a recoverable payload, per the service
 * contract — is not made yet, and the one property a Pod implementation needs is the
 * one an in-memory map cannot prove: reserving must be atomic, which depends on
 * conditional writes being atomic in this storage (an open experiment). Until then the
 * interface is what the endpoint talks to, and the in-memory store is what tests use.
 *
 * A transaction that exists but is not yet complete is not answered from its record:
 * the caller is told to retry, because the first attempt may still be writing.
 */
import { MatrixError } from '../MatrixError';
import { encodeCanonicalJson } from '../protocol/canonicalJson';
import { encodeUnpaddedBase64, sha256 } from '../protocol/eventIntegrity';
import type { AuthEvent } from '../protocol/authRules';
import { validateInboundPdu } from './inboundPdu';
import type { MatrixServerKeySource } from './serverKeys';

/** The `/_matrix/federation/v1/send` response body: one entry per PDU. */
export interface MatrixSendResponse {
  pdus: Record<string, Record<string, unknown>>;
}

export interface MatrixInboundTransactionRecord {
  origin: string;
  transactionId: string;
  /** Fingerprint of the PDUs the first attempt carried. */
  payloadFingerprint: string;
  /** What the first attempt answered; replayed verbatim. */
  response: MatrixSendResponse;
  receivedAt: string;
  completedAt?: string;
  /** Set when a later attempt presented different PDUs; the first record still stands. */
  conflictAt?: string;
}

export interface MatrixInboundTransactionStore {
  /**
   * Record a first attempt, or return the record already stored under this key.
   *
   * `created` distinguishes the caller that may process the PDUs from the one that must
   * answer from the record. A Pod-backed implementation has to make this atomic; an
   * in-memory one is atomic by construction.
   */
  reserve(
    scope: string,
    input: { origin: string; transactionId: string; payloadFingerprint: string; receivedAt: string },
  ): Promise<{ record: MatrixInboundTransactionRecord; created: boolean }>;
  /** Attach the response the first attempt produced. */
  complete(scope: string, key: { origin: string; transactionId: string }, response: MatrixSendResponse, completedAt: string): Promise<void>;
  find(scope: string, key: { origin: string; transactionId: string }): Promise<MatrixInboundTransactionRecord | undefined>;
}

export class InMemoryMatrixInboundTransactionStore implements MatrixInboundTransactionStore {
  private readonly records = new Map<string, MatrixInboundTransactionRecord>();

  public async reserve(
    scope: string,
    input: { origin: string; transactionId: string; payloadFingerprint: string; receivedAt: string },
  ): Promise<{ record: MatrixInboundTransactionRecord; created: boolean }> {
    const key = transactionKey(scope, input.origin, input.transactionId);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.payloadFingerprint !== input.payloadFingerprint && existing.conflictAt === undefined) {
        // The first record stands; the conflict is recorded so an operator can see that
        // a sender reused a transaction id for a different payload.
        existing.conflictAt = input.receivedAt;
      }
      return { record: { ...existing }, created: false };
    }
    const record: MatrixInboundTransactionRecord = {
      origin: input.origin,
      transactionId: input.transactionId,
      payloadFingerprint: input.payloadFingerprint,
      response: { pdus: {} },
      receivedAt: input.receivedAt,
    };
    this.records.set(key, record);
    return { record: { ...record }, created: true };
  }

  public async complete(
    scope: string,
    key: { origin: string; transactionId: string },
    response: MatrixSendResponse,
    completedAt: string,
  ): Promise<void> {
    const stored = this.records.get(transactionKey(scope, key.origin, key.transactionId));
    if (!stored) throw new MatrixError(500, 'M_UNKNOWN', 'Matrix inbound transaction disappeared');
    stored.response = response;
    stored.completedAt = completedAt;
  }

  public async find(
    scope: string,
    key: { origin: string; transactionId: string },
  ): Promise<MatrixInboundTransactionRecord | undefined> {
    const stored = this.records.get(transactionKey(scope, key.origin, key.transactionId));
    return stored ? { ...stored } : undefined;
  }
}

export interface HandleInboundTransactionInput {
  scope: string;
  origin: string;
  transactionId: string;
  pdus: readonly unknown[];
  store: MatrixInboundTransactionStore;
  keys: MatrixServerKeySource;
  /**
   * The receiver resolves the events a PDU's `auth_events` name. The PDU comes along
   * because the events have to be looked up in *its* room: an event id alone does not say
   * which room's history to search.
   */
  resolveAuthEvents: (eventIds: readonly string[], pdu: unknown) => Promise<readonly AuthEvent[]>;
  /** Persist an accepted event; the caller owns the Pod write. */
  acceptEvent: (event: Record<string, unknown>) => Promise<void>;
  now?: () => number;
}

/**
 * Process a transaction once and answer a replay identically.
 *
 * Per PDU the response carries an empty object for an accepted event and an `error`
 * entry otherwise. A PDU whose dependencies are missing is reported as an error rather
 * than silently accepted: this deployment cannot fetch missing events yet, and telling
 * the sender to retry is better than pretending the event was taken.
 */
export async function handleInboundTransaction(input: HandleInboundTransactionInput): Promise<MatrixSendResponse> {
  const now = input.now ?? Date.now;
  const fingerprint = fingerprintPdus(input.pdus);
  const { record, created } = await input.store.reserve(input.scope, {
    origin: input.origin,
    transactionId: input.transactionId,
    payloadFingerprint: fingerprint,
    receivedAt: new Date(now()).toISOString(),
  });
  if (!created) {
    // A replay is answered from the first attempt — including one that presents a
    // different payload, which must not replace what was already recorded.
    if (record.completedAt === undefined) {
      throw new MatrixError(503, 'M_UNKNOWN', 'Transaction is still being processed; retry');
    }
    return record.response;
  }

  const pdus: Record<string, Record<string, unknown>> = {};
  for (const [ index, pdu ] of input.pdus.entries()) {
    const authEventIds = referencedAuthEventIds(pdu);
    const authEvents = authEventIds.length > 0 ? await input.resolveAuthEvents(authEventIds, pdu) : [];
    const result = await validateInboundPdu(pdu, { keys: input.keys, authEvents, now });
    if (result.outcome === 'accepted' && result.event && result.eventId) {
      await input.acceptEvent(result.event);
      pdus[result.eventId] = {};
      continue;
    }
    pdus[result.eventId ?? `unknown-${index}`] = { error: result.reason };
  }
  const response: MatrixSendResponse = { pdus };
  await input.store.complete(input.scope, { origin: input.origin, transactionId: input.transactionId },
    response, new Date(now()).toISOString());
  return response;
}

/** A stable identity for the PDUs of one attempt, so a retry can be compared with it. */
export function fingerprintPdus(pdus: readonly unknown[]): string {
  let encoded: string;
  try {
    encoded = encodeCanonicalJson({ pdus });
  } catch {
    // A malformed payload still gets a fingerprint: the transaction must be recorded
    // (and answered) even when its PDUs cannot be canonicalised.
    encoded = JSON.stringify(pdus);
  }
  return encodeUnpaddedBase64(sha256(encoded));
}

/** The `auth_events` ids a raw PDU names, for the caller's resolver. */
export function referencedAuthEventIds(pdu: unknown): string[] {
  if (!isRecord(pdu) || !Array.isArray(pdu.auth_events)) return [];
  const ids: string[] = [];
  for (const entry of pdu.auth_events) {
    if (typeof entry === 'string') ids.push(entry);
    else if (Array.isArray(entry) && typeof entry[0] === 'string') ids.push(entry[0]);
  }
  return ids;
}

function transactionKey(scope: string, origin: string, transactionId: string): string {
  return JSON.stringify([ scope, origin, transactionId ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
