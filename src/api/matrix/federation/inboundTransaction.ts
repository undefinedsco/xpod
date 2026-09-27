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
import { eventReferenceIds } from '../protocol/eventReferences';
import { encodeCanonicalJson } from '../protocol/canonicalJson';
import { encodeUnpaddedBase64, sha256 } from '../protocol/eventIntegrity';
import type { AuthEvent } from '../protocol/authRules';
import { validateInboundPdu, type InboundPduResult } from './inboundPdu';
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
  /**
   * Forget a first attempt that did not finish, so the sender's retry may try again.
   *
   * A reservation whose processing threw would otherwise answer "still being processed" for ever,
   * and the sender would retry into a transaction nobody is working on. Releasing is safe because
   * the retry re-runs the whole pipeline and accepting an event is idempotent by event id: what the
   * failed attempt already wrote stays as it is, and is not written twice.
   */
  release(scope: string, key: { origin: string; transactionId: string }): Promise<void>;
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

  public async release(scope: string, key: { origin: string; transactionId: string }): Promise<void> {
    this.records.delete(transactionKey(scope, key.origin, key.transactionId));
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
  /**
   * Ask the server that sent this PDU for the events that authorise it, when the receiver
   * does not have them (the specification's `/event_auth`). Returns the chain oldest-first,
   * or `undefined` when the peer could not be reached.
   *
   * Absent means "this receiver cannot fetch", and a PDU whose auth events are missing is
   * then reported as an error, exactly as before.
   */
  fetchAuthChain?: (input: {
    eventId: string;
    pdu: Record<string, unknown>;
    origin: string;
  }) => Promise<readonly Record<string, unknown>[] | undefined>;
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
  try {
    for (const [ index, pdu ] of input.pdus.entries()) {
      const authEventIds = referencedAuthEventIds(pdu);
      const authEvents = authEventIds.length > 0 ? await input.resolveAuthEvents(authEventIds, pdu) : [];
      let result = await validateInboundPdu(pdu, { keys: input.keys, authEvents, now });
      if (result.outcome === 'deferred' && input.fetchAuthChain && result.eventId) {
        // The events that authorise this one are not here. Asking the sender is the
        // specification's answer, and it is the only way a PDU that arrives before its
        // dependencies can ever be accepted instead of merely reported.
        result = await fetchAndRetry(input, pdu, result, authEventIds, now);
      }
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
  } catch (error) {
    // Nothing here is worth keeping: the attempt did not finish, so the reservation goes and the
    // sender's retry gets to try again instead of meeting its own unfinished transaction. Releasing
    // is safe because the retry re-runs the whole pipeline and accepting an event is idempotent by
    // event id — what the failed attempt already wrote stays as it is, and is not written twice.
    await input.store.release(input.scope, { origin: input.origin, transactionId: input.transactionId });
    throw error;
  }
}

/**
 * Fetch the auth chain of a deferred PDU, store what it proves, and check the PDU again.
 *
 * One round, deliberately: the chain arrives oldest-first, so each event can be validated
 * against what is already there, and anything the chain itself still cannot authorise is
 * skipped rather than chased further. A receiver that kept fetching recursively could be
 * walked around a room by a peer that never sends the events it promised.
 */
async function fetchAndRetry(
  input: HandleInboundTransactionInput,
  pdu: unknown,
  deferred: InboundPduResult,
  authEventIds: readonly string[],
  now: () => number,
): Promise<InboundPduResult> {
  const eventId = deferred.eventId!;
  let chain: readonly Record<string, unknown>[] | undefined;
  try {
    chain = await input.fetchAuthChain!({ eventId, pdu: asRecord(pdu), origin: input.origin });
  } catch {
    // An unreachable peer leaves the PDU deferred, not rejected: the sender can retry.
    return deferred;
  }
  if (!chain || chain.length === 0) return deferred;

  for (const chained of chain) {
    const ids = referencedAuthEventIds(chained);
    const authEvents = ids.length > 0 ? await input.resolveAuthEvents(ids, chained) : [];
    const stored = await validateInboundPdu(chained, { keys: input.keys, authEvents, now });
    if (stored.outcome === 'accepted' && stored.event) await input.acceptEvent(stored.event);
  }
  const resolved = authEventIds.length > 0 ? await input.resolveAuthEvents(authEventIds, pdu) : [];
  return await validateInboundPdu(pdu, { keys: input.keys, authEvents: resolved, now });
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
  return eventReferenceIds(pdu, 'auth_events');
}

function transactionKey(scope: string, origin: string, transactionId: string): string {
  return JSON.stringify([ scope, origin, transactionId ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
