/**
 * The `PUT /_matrix/federation/v1/send/{txnId}` handler, minus the HTTP transport.
 *
 * Everything a receiving server has to decide lives here, in the order the specification
 * puts it: the body must be JSON, the request must carry a valid `X-Matrix` signature over
 * *this* request (see `requestAuth.ts`), the transaction must name the same origin that
 * signed it, and the PDUs must fit a transaction. Then the transaction layer takes over —
 * which is what makes a retry safe: the peer's id is reserved before anything is written,
 * an unfinished transaction answers "retry", and a replay is answered from the first
 * attempt instead of processing the PDUs twice.
 *
 * Two things are deliberately *not* decided here, because they are deployment policy
 * rather than protocol:
 *
 * - **which Pod** a transaction is written to. The handler asks for a target by the server
 *   name the request was addressed to; a deployment that cannot serve that name refuses
 *   with `403` instead of writing somebody else's room into an arbitrary Pod. That answer is
 *   derived rather than recorded (`participantRoutes.ts`): a participant's server name comes from
 *   their WebID, and the Pod is the one already registered to it — a name more than one
 *   participant claims is refused, because the choice could not be undone.
 * - **who may read and write that Pod.** `acceptEvent` and `resolveAuthEvents` are the
 *   caller's, so the Pod authority stays where it is decided rather than being assumed
 *   from an unauthenticated HTTP request.
 */
import { MatrixError } from '../MatrixError';
import { MAX_PDUS_PER_TRANSACTION } from './outboundTransaction';
import { authenticateXMatrixRequest } from './requestAuth';
import {
  handleInboundTransaction,
  type MatrixInboundTransactionStore,
} from './inboundTransaction';
import type { AuthEvent } from '../protocol/authRules';
import type { MatrixServerKeySource } from './serverKeys';

/** The Pod a transaction belongs to, and how to reach it. */
export interface FederationSendTarget {
  /** Pod scope the accepted events belong to. */
  scope: string;
  /** Persist one accepted event; the caller owns the Pod write. */
  acceptEvent(event: Record<string, unknown>): Promise<void>;
  /** Resolve the events a PDU's `auth_events` name, within that scope. */
  resolveAuthEvents(eventIds: readonly string[], pdu: unknown): Promise<readonly AuthEvent[]>;
  /**
   * Fetch the auth chain of a deferred event from the server that sent it, when this
   * deployment can. Absent means a PDU whose dependencies are missing is reported instead.
   */
  fetchAuthChain?(input: {
    eventId: string;
    pdu: Record<string, unknown>;
    origin: string;
  }): Promise<readonly Record<string, unknown>[] | undefined>;
}

export interface HandleFederationSendInput {
  /** Raw `Authorization` header value. */
  authorization: string | undefined;
  method: string;
  /** Request target including the query string, exactly as signed. */
  uri: string;
  /** Raw request body. */
  body: string;
  /** The server name this request is addressed to. */
  serverName: string;
  /** Verify keys of the servers that may send to us. */
  keys: MatrixServerKeySource;
  /**
   * The Pod that serves this destination, or `undefined` when this deployment does not
   * serve it. Called only after the request authenticated.
   */
  resolveTarget(destination: string): Promise<FederationSendTarget | undefined>;
  transactions: MatrixInboundTransactionStore;
  now?: () => number;
}

export interface FederationSendResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleFederationSend(input: HandleFederationSendInput): Promise<FederationSendResult> {
  const content = parseJsonObject(input.body);
  if (!content) return failure(400, 'M_NOT_JSON', 'Request body is not a JSON object');

  // The signature is what makes the header's claims usable, so nothing else is read
  // before it verifies — including the transaction id, which is part of the signed URI.
  const authentication = await authenticateXMatrixRequest({
    authorization: input.authorization,
    method: input.method,
    uri: input.uri,
    content,
    keys: input.keys,
    serverName: input.serverName,
  });
  if (!authentication.valid || !authentication.origin) {
    return failure(401, 'M_UNAUTHORIZED', authentication.reason);
  }
  const origin = authentication.origin;

  const transactionId = transactionIdFromUri(input.uri);
  if (!transactionId) return failure(404, 'M_UNRECOGNIZED', 'Not a federation transaction endpoint');

  // A transaction that claims a different origin than the one that signed it would be
  // attributing somebody else's request to us; the peer dedups on (origin, txnId), so the
  // two have to agree.
  if (content.origin !== origin) {
    return failure(400, 'M_BAD_JSON', `Transaction origin ${String(content.origin)} does not match the signed origin ${origin}`);
  }
  const pdus = content.pdus;
  if (!Array.isArray(pdus)) return failure(400, 'M_BAD_JSON', 'A transaction must carry a pdus array');
  if (pdus.length > MAX_PDUS_PER_TRANSACTION) {
    return failure(400, 'M_TOO_LARGE', `A transaction carries at most ${MAX_PDUS_PER_TRANSACTION} PDUs`);
  }

  const target = await input.resolveTarget(input.serverName);
  if (!target) return failure(403, 'M_FORBIDDEN', `This deployment does not serve ${input.serverName}`);

  try {
    const response = await handleInboundTransaction({
      scope: target.scope,
      origin,
      transactionId,
      pdus,
      store: input.transactions,
      keys: input.keys,
      resolveAuthEvents: target.resolveAuthEvents,
      acceptEvent: target.acceptEvent,
      ...(target.fetchAuthChain === undefined ? {} : { fetchAuthChain: target.fetchAuthChain }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return { status: 200, body: response as unknown as Record<string, unknown> };
  } catch (error) {
    if (error instanceof MatrixError) return failure(error.status, error.errcode, error.message);
    // A backend failure is ours, not the peer's: say nothing about it beyond "unknown".
    return failure(500, 'M_UNKNOWN', 'Failed to process the transaction');
  }
}

/** The transaction id is the last path segment; the query string is not part of it. */
export function transactionIdFromUri(uri: string): string | undefined {
  const path = uri.split('?')[0].split('#')[0];
  const match = /\/send\/([^/]+)$/u.exec(path);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape is not a transaction id we could ever match on a retry.
    return undefined;
  }
}

function failure(status: number, errcode: string, error: string): FederationSendResult {
  return { status, body: { errcode, error } };
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}
