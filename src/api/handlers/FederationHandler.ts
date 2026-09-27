/**
 * The federation HTTP surface: what a peer's request arrives on.
 *
 * `handleFederationSend` decides everything about a transaction; this module is the transport
 * around it — find the name the request was addressed to, read the body with a bound, hand it
 * over, and write the answer back. Keeping that split is what lets the whole inbound path be
 * tested without a socket, and this file stays small enough to read in one sitting.
 *
 * Three things are decided here rather than in the handler:
 *
 * - **Which name was addressed.** A federation request is addressed to a server name, and the
 *   `Host` header is where HTTP keeps that. A peer connecting to the implicit federation port has
 *   `alice.example:8448` in `Host` while the server name it used (and signed into `destination`)
 *   is `alice.example`, so both spellings are candidates and the one this deployment serves wins;
 *   a name it does not serve is refused with `403`, exactly as the handler does for an event that
 *   arrives for somebody else's Pod.
 * - **One room read per transaction, not one per PDU.** The auth events a PDU names have to be
 *   resolved from the Pod, and every PDU in a transaction usually names events from the same room.
 *   The index is built once per room and patched with what we accept, so a PDU that depends on an
 *   event accepted earlier in the same transaction still resolves — without a second read.
 * - **The body bound.** A transaction carries at most 50 PDUs, but nothing stops a peer from
 *   sending a gigabyte; the body is read with a limit and a `413` rather than buffered.
 */
import { readBoundedRequestBody } from './readBoundedRequestBody';
import { handleFederationSend, type FederationSendResult } from '../matrix/federation/inboundRoute';
import type { FederationSendTarget } from '../matrix/federation/inboundRoute';
import type { InMemoryMatrixInboundTransactionStore } from '../matrix/federation/inboundTransaction';
import type { MatrixInboundTransactionStore } from '../matrix/federation/inboundTransaction';
import type { MatrixServerKeySource } from '../matrix/federation/serverKeys';
import type { MatrixParticipantRoutes } from '../matrix/participantRoutes';
import type { AuthEvent } from '../matrix/protocol/authRules';
import type { MatrixEventRecord, MatrixStoreContext } from '../matrix/types';
import type { ApiServer, RouteHandler } from '../ApiServer';

/** How much of a request body this server will read: 50 PDUs with room to spare. */
export const MAX_FEDERATION_BODY_BYTES = 4 * 1024 * 1024;

/** What the inbound path needs of the store: read a room's events, write one received event. */
export interface FederationPodStore {
  acceptReceivedEvent(input: { event: Record<string, unknown>; context: MatrixStoreContext }): Promise<MatrixEventRecord>;
  protocolEvents(roomId: string, context: MatrixStoreContext): Promise<Record<string, unknown>[]>;
}

/** Fetching the auth chain of a deferred event from the server that sent it. */
export type FederationAuthChainFetcher = (input: {
  roomId: string;
  eventId: string;
  pdu: Record<string, unknown>;
  /** The server that sent us the transaction: the one to ask. */
  sender: string;
  /** The name we were addressed as, and therefore sign the question as. */
  servedName: string;
}) => Promise<readonly Record<string, unknown>[] | undefined>;

export interface FederationHandlerOptions {
  /** Which Pod a server name routes to; derived from the Pod registrations. */
  routes: Pick<MatrixParticipantRoutes, 'route'>;
  store: FederationPodStore;
  /** Verify keys of the servers that send to us. */
  keys: MatrixServerKeySource;
  /** Transaction dedup, so a peer's retry is answered instead of processed twice. */
  transactions: MatrixInboundTransactionStore | InMemoryMatrixInboundTransactionStore;
  /**
   * How to ask the sender for the auth chain of an event we cannot authorise yet. Absent means a
   * PDU with a dependency gap is reported as deferred rather than fetched.
   */
  fetchAuthChain?: FederationAuthChainFetcher;
  now?: () => number;
}

export function registerFederationRoutes(server: ApiServer, options: FederationHandlerOptions): void {
  // `public: true` because federation requests are authenticated by their `X-Matrix` signature,
  // not by a Solid/OIDC session: this route never sees a user's credentials.
  server.put('/_matrix/federation/v1/send/:txnId', createFederationSendHandler(options), { public: true });
}

/**
 * The `PUT /_matrix/federation/v1/send/:txnId` handler, as a value so it can be tested without a
 * socket and registered as many times as a deployment has names to serve.
 */
export function createFederationSendHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response) => {
    const addressed = await addressedServerName(request, options);
    if (!addressed) {
      sendJson(response, 403, { errcode: 'M_FORBIDDEN', error: `This deployment does not serve ${hostOf(request)}` });
      return;
    }

    let body: string;
    try {
      body = Buffer.concat(await readBoundedRequestBody(request, MAX_FEDERATION_BODY_BYTES,
        'The request body is larger than this server accepts for a transaction')).toString('utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unreadable request body';
      sendJson(response, 413, { errcode: 'M_TOO_LARGE', error: message });
      return;
    }

    let result: FederationSendResult;
    try {
      result = await handleFederationSend({
        authorization: headerValue(request.headers.authorization),
        method: 'PUT',
        // The signature covers the request target the peer sent, query string included.
        uri: requestTarget(request),
        body,
        serverName: addressed,
        keys: options.keys,
        resolveTarget: async destination => await targetFor(destination, options),
        transactions: options.transactions,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (error) {
      // A failure here is ours, not the peer's: say nothing about it beyond "unknown".
      sendJson(response, 500, {
        errcode: 'M_UNKNOWN',
        error: error instanceof Error ? error.message : 'Failed to process the transaction',
      });
      return;
    }
    sendJson(response, result.status, result.body);
  };
}

/**
 * The Pod a destination routes to, with everything the transaction layer needs of it: where the
 * events go, and how to answer what they depend on.
 */
async function targetFor(destination: string, options: FederationHandlerOptions): Promise<FederationSendTarget | undefined> {
  const answer = await options.routes.route(destination);
  if (answer.kind !== 'served') return undefined;
  const context: MatrixStoreContext = { webId: answer.route.webId, podUrl: answer.route.podUrl };
  const rooms = new Map<string, Map<string, Record<string, unknown>>>();

  /** The room's events by id, read once and then kept as this transaction writes into it. */
  const indexOf = async (roomId: string): Promise<Map<string, Record<string, unknown>>> => {
    const known = rooms.get(roomId);
    if (known) return known;
    const index = new Map<string, Record<string, unknown>>();
    for (const event of await options.store.protocolEvents(roomId, context)) {
      const id = event.event_id;
      if (typeof id === 'string') index.set(id, event);
    }
    rooms.set(roomId, index);
    return index;
  };

  return {
    scope: answer.route.podUrl,
    async acceptEvent(event) {
      const record = await options.store.acceptReceivedEvent({ event, context });
      // A later PDU in the same transaction may name this one as an auth event, and the read that
      // answered the earlier ones is already done: patch the index instead of reading again.
      (await indexOf(record.roomId)).set(record.eventId, { ...record.event, event_id: record.eventId });
    },
    async resolveAuthEvents(ids, pdu) {
      const roomId = String((pdu as Record<string, unknown> | undefined)?.room_id ?? '');
      if (!roomId) return [];
      const index = await indexOf(roomId);
      const resolved: AuthEvent[] = [];
      for (const id of ids) {
        const event = index.get(id);
        if (event) resolved.push(asAuthEvent(event));
      }
      return resolved;
    },
    ...(options.fetchAuthChain === undefined ? {} : {
      fetchAuthChain: async ({ eventId, pdu, origin }: { eventId: string; pdu: Record<string, unknown>; origin: string }) =>
        await options.fetchAuthChain!({
          roomId: String(pdu.room_id ?? ''),
          eventId,
          pdu,
          sender: origin,
          servedName: destination,
        }),
    }),
  };
}

/**
 * The names this request could have been addressed to, most specific first.
 *
 * `Host` is the only thing HTTP gives us, and a peer that reached the implicit federation port
 * sends `alice.example:8448` for the server name `alice.example`. Both are offered, and the caller
 * picks the one this deployment actually serves — which is also the name the peer's signed
 * `destination` has to match, since the handler checks it against whatever we answer here.
 */
export function addressedNames(host: string | undefined): string[] {
  const trimmed = (host ?? '').trim();
  if (!trimmed) return [];
  const withoutDefaultPort = trimmed.replace(/:(?:8448|443)$/u, '');
  return withoutDefaultPort !== trimmed ? [ trimmed, withoutDefaultPort ] : [ trimmed ];
}

/** The name the request was addressed to, or `undefined` when this deployment serves none of them. */
async function addressedServerName(
  request: { headers: { host?: string | undefined } },
  options: Pick<FederationHandlerOptions, 'routes'>,
): Promise<string | undefined> {
  for (const name of addressedNames(request.headers.host)) {
    if ((await options.routes.route(name)).kind === 'served') return name;
  }
  return undefined;
}

/** A protocol event as the auth rules read it. */
function asAuthEvent(event: Record<string, unknown>): AuthEvent {
  return {
    event_id: typeof event.event_id === 'string' ? event.event_id : undefined,
    type: String(event.type ?? ''),
    sender: String(event.sender ?? ''),
    room_id: String(event.room_id ?? ''),
    content: (event.content ?? {}) as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { state_key: String(event.state_key) }),
    prev_events: [],
  };
}

function hostOf(request: { headers: { host?: string | undefined } }): string {
  return (request.headers.host ?? '').trim();
}

function requestTarget(request: { url?: string | undefined }): string {
  return request.url ?? '/';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
  status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}
