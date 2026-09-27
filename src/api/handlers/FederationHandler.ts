/**
 * The federation HTTP surface: what a peer's request arrives on.
 *
 * `handleFederationSend` decides everything about a transaction; this module is the transport
 * around it — find the name the request was addressed to, read the body with a bound, hand it
 * over, and write the answer back. Keeping that split is what lets the whole inbound path be
 * tested without a socket, and this file stays small enough to read in one sitting.
 *
 * The read endpoints (`/event_auth`, `/state`, `/state_ids`, `/backfill`, `/get_missing_events`) share
 * the same three steps — who is asking, which Pod the room is in, and which pure function answers —
 * so they share one preamble here and differ only in the question they ask and the shape they
 * answer with.
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
 *
 * The credentials the store is read and written with are the deployment's decision, not this
 * module's: `contextFor` turns a routed participant into a context, and the deployment says whether
 * it acts with that participant's task-layer grant, with a service session, or not at all. A shell
 * that invented a context would be deciding who the deployment is allowed to be.
 */
import { readBoundedRequestBody } from './readBoundedRequestBody';
import { handleFederationSend, type FederationSendResult } from '../matrix/federation/inboundRoute';
import { selectAuthChain } from '../matrix/federation/authChain';
import { selectBackfill } from '../matrix/federation/roomHistory';
import { selectMissingEvents } from '../matrix/federation/missingEvents';
import { stateIdsBefore, stateSnapshotBefore } from '../matrix/federation/roomStateSnapshot';
import { recordOfProtocolEvent } from '../matrix/storedEvent';
import { authenticateXMatrixRequest } from '../matrix/federation/requestAuth';
import type { FederationSendTarget } from '../matrix/federation/inboundRoute';
import type { InMemoryMatrixInboundTransactionStore } from '../matrix/federation/inboundTransaction';
import type { MatrixInboundTransactionStore } from '../matrix/federation/inboundTransaction';
import type { MatrixServerKeySource } from '../matrix/federation/serverKeys';
import type { MatrixParticipantRoutes, MatrixServerRoute } from '../matrix/participantRoutes';
import type { AuthEvent } from '../matrix/protocol/authRules';
import type { MatrixEventRecord, MatrixStoreContext } from '../matrix/types';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ServerResponse } from 'node:http';

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
  /**
   * The context the store is read and written with for a routed participant.
   *
   * Deployment policy, and the only place it is decided: a deployment writes into a participant's
   * Pod with that participant's grant (`{ webId, podUrl, service: {} }`), and the store refuses if
   * there is none. The default carries no authority at all, which a real Pod refuses — that is the
   * honest default for a caller that has not said who it is.
   */
  contextFor?: (route: MatrixServerRoute) => MatrixStoreContext | Promise<MatrixStoreContext>;
  now?: () => number;
}

export function registerFederationRoutes(server: ApiServer, options: FederationHandlerOptions): void {
  // `public: true` because federation requests are authenticated by their `X-Matrix` signature,
  // not by a Solid/OIDC session: these routes never see a user's credentials.
  const publicRoute = { public: true } as const;
  server.put('/_matrix/federation/v1/send/:txnId', createFederationSendHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/event_auth/:roomId/:eventId', createEventAuthHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/state/:roomId', createStateHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/state_ids/:roomId', createStateIdsHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/backfill/:roomId', createBackfillHandler(options), publicRoute);
  server.post('/_matrix/federation/v1/get_missing_events/:roomId', createMissingEventsHandler(options), publicRoute);
}

/**
 * The `GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}` handler: the events that authorise
 * one event, including itself, oldest first.
 */
export function createEventAuthHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
    const room = await readRoom({ request, response, options, roomId: decode(params.roomId) });
    if (!room) return;
    const { chain } = selectAuthChain(room.events, decode(params.eventId));
    sendJson(response, 200, { auth_chain: chain });
  };
}

/** `GET /state/{roomId}?event_id=…`: the resolved state before an event, and its auth chain. */
export function createStateHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
    const room = await readRoom({ request, response, options, roomId: decode(params.roomId) });
    if (!room) return;
    const eventId = queryOf(request).get('event_id');
    if (!eventId) return void fail(response, 400, 'M_MISSING_PARAM', 'event_id is required');
    const snapshot = stateSnapshotBefore(room.events.map(recordOfProtocolEvent), eventId);
    if (!snapshot) return void fail(response, 404, 'M_NOT_FOUND', `This server does not know ${eventId}`);
    sendJson(response, 200, { pdus: snapshot.pdus, auth_chain: snapshot.authChain });
  };
}

/** The same answer as ids, which is all a server that already has the events needs. */
export function createStateIdsHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
    const roomId = decode(params.roomId);
    const room = await readRoom({ request, response, options, roomId });
    if (!room) return;
    const eventId = queryOf(request).get('event_id');
    if (!eventId) return void fail(response, 400, 'M_MISSING_PARAM', 'event_id is required');
    const snapshot = stateIdsBefore(room.events.map(recordOfProtocolEvent), eventId);
    if (!snapshot) return void fail(response, 404, 'M_NOT_FOUND', `This server does not know ${eventId}`);
    sendJson(response, 200, { pdu_ids: snapshot.pduIds, auth_chain_ids: snapshot.authChainIds });
  };
}

/** `GET /backfill/{roomId}?v=…&limit=…`: a window of history, newest first, named events included. */
export function createBackfillHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
    const room = await readRoom({ request, response, options, roomId: decode(params.roomId) });
    if (!room) return;
    const query = queryOf(request);
    const from = query.getAll('v');
    const limit = Number(query.get('limit'));
    if (from.length === 0) return void fail(response, 400, 'M_MISSING_PARAM', 'at least one v is required');
    if (!Number.isSafeInteger(limit) || limit < 0) {
      return void fail(response, 400, 'M_MISSING_PARAM', 'limit must be a non-negative integer');
    }
    const window = selectBackfill(room.events, { from, limit });
    sendJson(response, 200, {
      origin: room.serverName,
      origin_server_ts: (options.now ?? Date.now)(),
      pdus: window.pdus,
    });
  };
}

/**
 * `POST /get_missing_events/{roomId}`: the parents a requester is missing, oldest first.
 *
 * Its request is a body, so the body is read (bounded) and parsed before authentication — the
 * signature covers it, and a body this server cannot read has no content to verify.
 */
export function createMissingEventsHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
    let content: Record<string, unknown>;
    try {
      const raw = Buffer.concat(await readBoundedRequestBody(request, MAX_FEDERATION_BODY_BYTES,
        'The request body is larger than this server accepts')).toString('utf8');
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!isRecord(parsed)) return void fail(response, 400, 'M_BAD_JSON', 'Request body is not a JSON object');
      content = parsed;
    } catch (error) {
      return void fail(response, 400, 'M_BAD_JSON',
        error instanceof Error ? error.message : 'The request body could not be read');
    }
    const room = await readRoom({ request, response, options, roomId: decode(params.roomId), content });
    if (!room) return;
    const earliest = stringList(content.earliest_events);
    const latest = stringList(content.latest_events);
    if (earliest === undefined || latest === undefined) {
      return void fail(response, 400, 'M_MISSING_PARAM', 'earliest_events and latest_events must be arrays of ids');
    }
    const selection = selectMissingEvents(room.events, {
      earliestEvents: earliest,
      latestEvents: latest,
      ...(Number.isSafeInteger(content.limit) ? { limit: Number(content.limit) } : {}),
      ...(Number.isSafeInteger(content.min_depth) ? { minDepth: Number(content.min_depth) } : {}),
    });
    sendJson(response, 200, { events: selection.events });
  };
}

/** The room a read endpoint was asked about, or why the answer is an error instead. */
async function readRoom(input: {
  request: AuthenticatedRequest;
  response: ServerResponse;
  options: FederationHandlerOptions;
  roomId: string;
  content?: unknown;
}): Promise<{ origin: string; serverName: string; events: Record<string, unknown>[] } | undefined> {
  const { options, request, response, roomId } = input;
  const serverName = await addressedServerName(request, options);
  if (!serverName) {
    return fail(response, 403, 'M_FORBIDDEN', `This deployment does not serve ${hostOf(request)}`);
  }
  const authentication = await authenticateXMatrixRequest({
    authorization: headerValue(request.headers.authorization),
    method: (request.method ?? 'GET').toUpperCase(),
    uri: requestTarget(request),
    ...(input.content === undefined ? {} : { content: input.content }),
    keys: options.keys,
    serverName,
  });
  if (!authentication.valid || !authentication.origin) {
    return fail(response, 401, 'M_UNAUTHORIZED', authentication.reason);
  }
  const context = await contextForName(serverName, options);
  if (!context) return fail(response, 403, 'M_FORBIDDEN', `This deployment does not serve ${serverName}`);
  const events = await options.store.protocolEvents(roomId, context);
  if (events.length === 0) return fail(response, 404, 'M_NOT_FOUND', `This server does not know ${roomId}`);
  return { origin: authentication.origin, serverName, events };
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
  const context = await contextForName(destination, options);
  if (!context) return undefined;
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
    scope: context.podUrl ?? '',
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
 * The context a server name's Pod is read and written with.
 *
 * `contextFor` is the deployment's answer to "who is this, then" (see the module note); without it
 * the context carries no authority at all, which is the honest default for a caller that has not
 * said who it is.
 */
async function contextForName(serverName: string, options: FederationHandlerOptions): Promise<MatrixStoreContext | undefined> {
  const answer = await options.routes.route(serverName);
  if (answer.kind !== 'served') return undefined;
  return options.contextFor
    ? await options.contextFor(answer.route)
    : { webId: answer.route.webId, podUrl: answer.route.podUrl };
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

/** Answer with a Matrix error and report that nothing more should be written. */
function fail(response: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void },
  status: number, errcode: string, error: string): undefined {
  sendJson(response, status, { errcode, error });
  return undefined;
}

/** A path parameter, decoded; a malformed escape is the value as sent rather than a crash. */
function decode(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? '');
  } catch {
    return value ?? '';
  }
}

function queryOf(request: { url?: string | undefined }): URLSearchParams {
  const index = (request.url ?? '').indexOf('?');
  return new URLSearchParams(index < 0 ? '' : (request.url ?? '').slice(index + 1));
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
