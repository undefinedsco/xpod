/**
 * Making signed federation requests to another server.
 *
 * `sendTransaction` is the one this module is named for; `getMissingEvents` asks a peer for
 * the events a received PDU depends on. Both go through the same execution: resolve the
 * destination, sign the request that is actually sent, and classify the answer.
 *
 * `PUT /_matrix/federation/v1/send/{txnId}` is how live room activity leaves this
 * deployment. The specification attaches two rules that shape this module:
 *
 * - a transaction carries at most 50 PDUs and 100 EDUs; and
 * - **the sending server must wait and retry for a 200 before sending a transaction
 *   with a different `txnId`**. The transaction id is what the peer stores to
 *   recognise a retry (see `inboundTransaction.ts`), so a retry has to reuse the id:
 *   minting a new one per attempt would make the peer process the same PDUs twice.
 *   That rule is why `deliverTransaction` takes the id from its caller and never
 *   invents one.
 *
 * One attempt is classified as `delivered`, `retry` or `rejected`, and only the middle
 * one is worth trying again: a 4xx (other than rate limiting) means the peer has made a
 * decision about this request, while 5xx, network failures and rate limiting mean the
 * peer has not.
 *
 * Every attempt is signed as `X-Matrix` over the request that is actually sent, so the
 * receiver can verify it without trusting anything in the body.
 */
import { buildXMatrixAuthorization, type XMatrixSigner } from './requestAuth';
import type { MatrixResolvedServer } from './serverNameResolution';

/** The specification's per-transaction limits. */
export const MAX_PDUS_PER_TRANSACTION = 50;
export const MAX_EDUS_PER_TRANSACTION = 100;

/** How a transaction fared with one destination. */
export type MatrixDeliveryStatus = 'delivered' | 'retry' | 'rejected';

export interface MatrixDeliveryOutcome {
  status: MatrixDeliveryStatus;
  origin: string;
  destination: string;
  txnId: string;
  /** Per-PDU results from the peer; an entry with `error` is a PDU it refused. */
  pdus?: Record<string, { error?: string }>;
  /** How long the peer asked us to wait before retrying, when it said so. */
  retryAfterMs?: number;
  reason: string;
}

/** The outcome of one signed request, before a caller interprets the body. */
type MatrixRequestOutcome =
  | { status: 'ok'; body: unknown; reason: string }
  | { status: 'retry'; reason: string; retryAfterMs?: number }
  | { status: 'rejected'; reason: string };

/** What a request for events produced: the peer's answer, or why there is none. */
export interface FederationEventsOutcome {
  status: 'ok' | 'retry' | 'rejected';
  /** The peer's answer, when it was readable. */
  events?: Record<string, unknown>[];
  /** `/state` answers with a state and the auth chain it rests on. */
  authChain?: Record<string, unknown>[];
  reason: string;
  retryAfterMs?: number;
}

/** What a request for a room's state ids produced. */
export interface StateIdsOutcome {
  status: 'ok' | 'retry' | 'rejected';
  pduIds?: string[];
  authChainIds?: string[];
  reason: string;
  retryAfterMs?: number;
}

export interface MatrixFederationClientOptions {
  /** The identity this deployment sends as. */
  identity: XMatrixSigner & { serverName: string };
  /** Where a destination server name is reached, and under which `Host`. */
  resolve: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  fetch: typeof fetch;
  now?: () => number;
}

export interface SendTransactionInput {
  destination: string;
  /** Owned by the caller and reused across retries; see the note above. */
  txnId: string;
  pdus: readonly unknown[];
  edus?: readonly unknown[];
}

export interface DeliverTransactionInput extends SendTransactionInput {
  policy?: MatrixDeliveryPolicy;
  /** Injectable so retry behaviour is testable without waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export interface MatrixDeliveryPolicy {
  maxAttempts?: number;
  initialBackoffMs?: number;
  /** Ceiling for both our own backoff and any hint the peer sends. */
  maxBackoffMs?: number;
  /** Fraction of the delay that may be added or removed, so peers do not retry in lockstep. */
  jitter?: number;
}

export interface MatrixDeliveryResult {
  outcome: MatrixDeliveryOutcome;
  /** How many attempts were made, including the last one. */
  attempts: number;
  /** How long was spent waiting between attempts. */
  waitedMs: number;
}

const DEFAULT_POLICY: Required<MatrixDeliveryPolicy> = {
  maxAttempts: 5,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  jitter: 0.2,
};

export class MatrixFederationClient {
  private readonly identity: XMatrixSigner & { serverName: string };
  private readonly resolve: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;

  public constructor(options: MatrixFederationClientOptions & { random?: () => number }) {
    this.identity = options.identity;
    this.resolve = options.resolve;
    this.fetch = options.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * One attempt, with no retrying of its own: the outcome says whether trying again is
   * worth anything. Retries belong to `deliverTransaction`, which keeps the txnId.
   */
  public async sendTransaction(input: SendTransactionInput): Promise<MatrixDeliveryOutcome> {
    const { destination, txnId } = input;
    const base: Pick<MatrixDeliveryOutcome, 'origin' | 'destination' | 'txnId'> = {
      origin: this.identity.serverName,
      destination,
      txnId,
    };
    if (!txnId.trim()) return { ...base, status: 'rejected', reason: 'a transaction needs an id' };
    if (input.pdus.length > MAX_PDUS_PER_TRANSACTION) {
      throw new Error(`A transaction carries at most ${MAX_PDUS_PER_TRANSACTION} PDUs`);
    }
    if ((input.edus?.length ?? 0) > MAX_EDUS_PER_TRANSACTION) {
      throw new Error(`A transaction carries at most ${MAX_EDUS_PER_TRANSACTION} EDUs`);
    }

    const content: Record<string, unknown> = {
      origin: this.identity.serverName,
      origin_server_ts: this.now(),
      pdus: [ ...input.pdus ],
    };
    // An empty `edus` would be a field the peer has to interpret for nothing.
    if (input.edus && input.edus.length > 0) content.edus = [ ...input.edus ];

    // The signed URI must be exactly the request target the peer will reconstruct,
    // including the encoded transaction id, so the signature covers the endpoint too.
    const uri = `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`;
    const result = await this.execute({ destination, method: 'PUT', uri, content });
    if (result.status === 'retry') {
      return { ...base, status: 'retry', ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }), reason: result.reason };
    }
    if (result.status === 'rejected') return { ...base, status: 'rejected', reason: result.reason };

    const pdus = isRecord(result.body) ? result.body.pdus : undefined;
    if (!isRecord(pdus)) {
      // A 200 we cannot read leaves us unable to say which PDUs were handled; retrying
      // is safe because the peer keys its own dedup on the transaction id.
      return { ...base, status: 'retry', reason: 'destination answered 200 without PDU results' };
    }
    return { ...base, status: 'delivered', pdus: pdus as Record<string, { error?: string }>, reason: 'delivered' };
  }

  /**
   * Ask a peer for the events a received PDU depends on.
   *
   * `earliest_events` are the events we already have, `latest_events` the ones whose parents
   * we are missing; the peer walks back from there. A 200 we cannot read is worth retrying
   * for the same reason as a transaction: the peer has not told us anything we can act on.
   */
  public async getMissingEvents(input: {
    destination: string;
    roomId: string;
    earliestEvents: readonly string[];
    latestEvents: readonly string[];
    limit?: number;
    minDepth?: number;
  }): Promise<FederationEventsOutcome> {
    const content: Record<string, unknown> = {
      earliest_events: [ ...input.earliestEvents ],
      latest_events: [ ...input.latestEvents ],
    };
    if (input.limit !== undefined) content.limit = input.limit;
    if (input.minDepth !== undefined) content.min_depth = input.minDepth;
    const uri = `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(input.roomId)}`;
    const result = await this.execute({ destination: input.destination, method: 'POST', uri, content });
    if (result.status !== 'ok') return result;
    const events = isRecord(result.body) ? result.body.events : undefined;
    if (!Array.isArray(events)) return { status: 'retry', reason: 'destination answered 200 without an events array' };
    return { status: 'ok', events: events as Record<string, unknown>[], reason: 'ok' };
  }

  /**
   * Ask a peer for the events that authorise one event.
   *
   * This is the endpoint for authorisation, not for history: an event's auth events are
   * usually its ancestors, but state resolution can pick one that is not on the
   * `prev_events` walk, so `/get_missing_events` would never reach it.
   */
  public async getAuthChain(input: {
    destination: string;
    roomId: string;
    eventId: string;
  }): Promise<FederationEventsOutcome> {
    const uri = `/_matrix/federation/v1/event_auth/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.eventId)}`;
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    const authChain = isRecord(result.body) ? result.body.auth_chain : undefined;
    if (!Array.isArray(authChain)) return { status: 'retry', reason: 'destination answered 200 without an auth_chain array' };
    return { status: 'ok', events: authChain as Record<string, unknown>[], reason: 'ok' };
  }

  /**
   * Ask a peer for history before the events we name.
   *
   * `/backfill` is the endpoint for a sliding window of the past: the events we name and what
   * preceded them, newest first, which is the direction a server paging backwards wants.
   */
  public async backfill(input: {
    destination: string;
    roomId: string;
    from: readonly string[];
    limit: number;
  }): Promise<FederationEventsOutcome> {
    const query = new URLSearchParams();
    for (const eventId of input.from) query.append('v', eventId);
    query.set('limit', String(input.limit));
    const uri = `/_matrix/federation/v1/backfill/${encodeURIComponent(input.roomId)}?${query.toString()}`;
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    const pdus = isRecord(result.body) ? result.body.pdus : undefined;
    if (!Array.isArray(pdus)) return { status: 'retry', reason: 'destination answered 200 without a pdus array' };
    return { status: 'ok', events: pdus as Record<string, unknown>[], reason: 'ok' };
  }

  /** The room's state before an event, as ids: `auth_chain_ids` and `pdu_ids`. */
  public async getStateIds(input: {
    destination: string;
    roomId: string;
    eventId: string;
  }): Promise<StateIdsOutcome> {
    const uri = `/_matrix/federation/v1/state_ids/${encodeURIComponent(input.roomId)}?${new URLSearchParams({ event_id: input.eventId }).toString()}`;
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    const pduIds = isRecord(result.body) ? result.body.pdu_ids : undefined;
    const authChainIds = isRecord(result.body) ? result.body.auth_chain_ids : undefined;
    if (!Array.isArray(pduIds) || !Array.isArray(authChainIds)) {
      return { status: 'retry', reason: 'destination answered 200 without pdu_ids and auth_chain_ids' };
    }
    return {
      status: 'ok',
      pduIds: pduIds.map(String),
      authChainIds: authChainIds.map(String),
      reason: 'ok',
    };
  }

  /** The room's state before an event, as PDUs, with the auth chain it rests on. */
  public async getState(input: {
    destination: string;
    roomId: string;
    eventId: string;
  }): Promise<FederationEventsOutcome> {
    const uri = `/_matrix/federation/v1/state/${encodeURIComponent(input.roomId)}?${new URLSearchParams({ event_id: input.eventId }).toString()}`;
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    const pdus = isRecord(result.body) ? result.body.pdus : undefined;
    const authChain = isRecord(result.body) ? result.body.auth_chain : undefined;
    if (!Array.isArray(pdus) || !Array.isArray(authChain)) {
      return { status: 'retry', reason: 'destination answered 200 without pdus and auth_chain' };
    }
    return { status: 'ok', events: pdus as Record<string, unknown>[], authChain: authChain as Record<string, unknown>[], reason: 'ok' };
  }

  /**
   * Sign and send one request, then classify the answer. The signature covers the request
   * that is actually sent — method, target and body — so the peer needs to trust nothing
   * inside the body.
   */
  private async execute(request: {
    destination: string;
    method: string;
    uri: string;
    /** Absent for a request with no body, e.g. `GET /event_auth`; then no `content` is signed. */
    content?: Record<string, unknown>;
  }): Promise<MatrixRequestOutcome> {
    const target = await this.resolve(request.destination);
    if (!target) return { status: 'rejected', reason: `cannot resolve ${request.destination}` };

    const authorization = buildXMatrixAuthorization({
      origin: this.identity.serverName,
      destination: request.destination,
      method: request.method,
      uri: request.uri,
      ...(request.content === undefined ? {} : { content: request.content }),
    }, this.identity);

    let response: Response;
    try {
      response = await this.fetch(`${target.baseUrl}${request.uri}`, {
        method: request.method,
        headers: {
          ...(request.content === undefined ? {} : { 'content-type': 'application/json' }),
          authorization,
        },
        ...(request.content === undefined ? {} : { body: JSON.stringify(request.content) }),
      });
    } catch (error) {
      // Unreachable is "the peer has not decided", never "the peer refused".
      return { status: 'retry', reason: `could not reach ${request.destination}: ${describeError(error)}` };
    }

    const text = await response.text().catch(() => '');
    if (response.status === 200) return { status: 'ok', body: parseJson(text), reason: 'ok' };

    const retryAfterMs = readRetryAfter(text, response.headers.get('retry-after'), this.now());
    if (response.status === 429) {
      return { status: 'retry', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: 'destination rate limited the request' };
    }
    if (response.status >= 500) {
      return { status: 'retry', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: `destination answered ${response.status}` };
    }
    return { status: 'rejected', reason: `destination refused the request with ${response.status}` };
  }

  /**
   * Keep sending the *same* transaction until the peer delivers it or refuses it, backing
   * off between attempts. The peer's own retry hint wins when it sent one.
   */
  public async deliverTransaction(input: DeliverTransactionInput): Promise<MatrixDeliveryResult> {
    const policy = { ...DEFAULT_POLICY, ...input.policy };
    if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }
    const sleep = input.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });
    let waitedMs = 0;
    let outcome = await this.sendTransaction(input);
    let attempts = 1;
    while (outcome.status === 'retry' && attempts < policy.maxAttempts) {
      const delay = this.retryDelay(outcome, attempts, policy);
      await sleep(delay);
      waitedMs += delay;
      outcome = await this.sendTransaction(input);
      attempts += 1;
    }
    return { outcome, attempts, waitedMs };
  }

  /** Exponential backoff, bounded, jittered, and overridden by the peer's hint. */
  private retryDelay(
    outcome: MatrixDeliveryOutcome,
    attempt: number,
    policy: Required<MatrixDeliveryPolicy>,
  ): number {
    if (outcome.retryAfterMs !== undefined) return Math.min(outcome.retryAfterMs, policy.maxBackoffMs);
    const base = Math.min(policy.initialBackoffMs * 2 ** (attempt - 1), policy.maxBackoffMs);
    if (policy.jitter <= 0) return base;
    // Centred on `base`: the peer's other senders are not on our clock.
    const spread = (this.random() * 2 - 1) * policy.jitter;
    return Math.max(0, Math.round(base * (1 + spread)));
  }
}

/** `retry_after_ms` from the body (Matrix's rate-limit field), else `Retry-After`. */
export function readRetryAfter(text: string, header: string | null, now: number): number | undefined {
  const parsed = parseJson(text);
  const fromBody = isRecord(parsed) ? parsed.retry_after_ms : undefined;
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) return Math.round(fromBody);
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
