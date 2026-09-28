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
import {
  buildMembershipTemplate,
  handleMembershipSubmission,
  type MatrixEventSigner,
  type MembershipKind,
} from '../matrix/federation/membershipHandshake';
import { eventReferenceIds } from '../matrix/protocol/eventReferences';
import { serverNameOf, toAuthEvent } from '../matrix/protocol/authRules';
import { deploymentVersion, IMPLEMENTATION_NAME } from '../../runtime/deploymentVersion';
import { NATIVE_INBOUND_PATH, type FederationSendTarget } from '../matrix/federation/inboundRoute';
import type {
  InMemoryMatrixInboundTransactionStore,
  MatrixInboundRecordHandle,
  MatrixInboundTransactionStore,
} from '../matrix/federation/inboundTransaction';
import type { MatrixServerKeySource } from '../matrix/federation/serverKeys';
import type { MatrixParticipantRoutes, MatrixServerRoute } from '../matrix/participantRoutes';
import { getLoggerFor } from 'global-logger-factory';
import { MatrixError } from '../matrix/MatrixError';
import type { AuthEvent } from '../matrix/protocol/authRules';
import type { MatrixEventRecord, MatrixStoreContext } from '../matrix/types';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ServerResponse } from 'node:http';

const logger = getLoggerFor('MatrixFederation');

/** How much of a request body this server will read: 50 PDUs with room to spare. */
export const MAX_FEDERATION_BODY_BYTES = 4 * 1024 * 1024;

/** What the inbound path needs of the store: read a room's events, write one received event. */
export interface FederationPodStore {
  acceptReceivedEvent(input: { event: Record<string, unknown>; context: MatrixStoreContext }): Promise<MatrixEventRecord>;
  protocolEvents(roomId: string, context: MatrixStoreContext): Promise<Record<string, unknown>[]>;
  /** The room a Pod holds under a room alias, for `/query/directory`. */
  findRoomByAlias(alias: string, context: MatrixStoreContext): Promise<{ roomId: string } | undefined>;
  /** The servers with a joined member in a room, for `/query/directory`'s answer. */
  roomServers(roomId: string, context: MatrixStoreContext): Promise<string[]>;
  /** The MXID a WebID has under a server name, so a query about a user can be recognised. */
  matrixUserIdFor(webId: string, serverName: string): string;
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
  /**
   * The resolved Pod handle a Pod-backed transaction store writes its receipts to.
   *
   * Built from the same context the events are written with, so "where the record goes" and "who
   * may write it" stay one decision. Absent means the transaction store is not Pod-backed (or
   * refuses); the in-memory store ignores it.
   */
  recordsFor?: (context: MatrixStoreContext) => Promise<MatrixInboundRecordHandle>;
  /**
   * What `/version` reports. Defaults to this deployment's own name and version; a test or an
   * embedding passes its own so the answer does not depend on the build it happens to run in.
   */
  implementation?: { name: string; version: string };
  /**
   * The identity that countersigns what this deployment accepts under a server name. A join
   * accepted into a participant's Pod is signed by *that participant*, not by the deployment, so
   * the signer is looked up per name; absent means accepted events are stored unsigned by us.
   */
  signerFor?: (serverName: string) => Promise<MatrixEventSigner | undefined>;
  now?: () => number;
}

export function registerFederationRoutes(server: ApiServer, options: FederationHandlerOptions): void {
  // `public: true` because federation requests are authenticated by their `X-Matrix` signature,
  // not by a Solid/OIDC session: these routes never see a user's credentials.
  const publicRoute = { public: true } as const;
  server.put('/_matrix/federation/v1/send/:txnId', createFederationSendHandler(options), publicRoute);
  // The same inbound work, reached the way two Xpod deployments talk to each other: an ordinary
  // signed API call to the peer's own server name, with no Matrix federation semantics in the
  // transport. Matrix-facing peers keep using `/send`, which is why this is additive.
  server.post(`${NATIVE_INBOUND_PATH}/:txnId`, createNativeInboundHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/event_auth/:roomId/:eventId', createEventAuthHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/state/:roomId', createStateHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/state_ids/:roomId', createStateIdsHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/backfill/:roomId', createBackfillHandler(options), publicRoute);
  server.post('/_matrix/federation/v1/get_missing_events/:roomId', createMissingEventsHandler(options), publicRoute);

  // The membership handshakes. A template is answered from the room; the submission is judged by
  // the same code a transaction goes through, with this deployment's signature added.
  server.get('/_matrix/federation/v1/make_join/:roomId/:userId', createTemplateHandler(options, 'join'), publicRoute);
  server.get('/_matrix/federation/v1/make_leave/:roomId/:userId', createTemplateHandler(options, 'leave'), publicRoute);
  server.get('/_matrix/federation/v1/make_knock/:roomId/:userId', createTemplateHandler(options, 'knock'), publicRoute);
  server.put('/_matrix/federation/v2/send_join/:roomId/:eventId', createSubmissionHandler(options, 'join'), publicRoute);
  server.put('/_matrix/federation/v2/send_leave/:roomId/:eventId', createSubmissionHandler(options, 'leave'), publicRoute);
  server.put('/_matrix/federation/v1/send_knock/:roomId/:eventId', createSubmissionHandler(options, 'knock'), publicRoute);
  server.put('/_matrix/federation/v2/invite/:roomId/:eventId', createInviteHandler(options), publicRoute);

  // What a peer asks before it can join anything: which room an alias of ours names, and who else
  // is in it.
  server.get('/_matrix/federation/v1/query/directory', createDirectoryQueryHandler(options), publicRoute);

  // The first thing a peer may ask, and the only endpoint here that is deliberately unsigned: it
  // says which implementation is answering, not anything that needs authenticating.
  server.get('/_matrix/federation/v1/version', createVersionHandler(options), publicRoute);
  server.get('/_matrix/federation/v1/query/profile', createProfileQueryHandler(options), publicRoute);
}

/**
 * `GET /query/profile?user_id=…&field=…`: what this deployment publishes about one of its users.
 *
 * The user has to be ours, and "ours" is computed rather than looked up: an MXID here is derived
 * from the participant's WebID (`@u_<sha256(webId)>:<server name>`), so recognising one is a
 * comparison against each served participant — the same rule the store uses when it names a sender.
 *
 * **The answer is deliberately empty today.** Xpod has no federated profile: a display name would
 * have to come from the participant's Solid profile, and publishing that to any peer that asks is a
 * decision about the person's data, not a formatting choice — while an avatar would have to be an
 * `mxc://` URI and this deployment has no media repository (it is on the register's "not doing"
 * list). The endpoint still answers instead of refusing, with the fields left out, which is what
 * the specification allows for a field a user has not set; when a profile source is decided, this
 * is where it is published.
 */
export function createProfileQueryHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response) => {
    const userId = queryOf(request).get('user_id');
    if (!userId) return void fail(response, 400, 'M_MISSING_PARAM', 'user_id is required');
    const serverName = serverNameOf(userId);
    if (!serverName) return void fail(response, 400, 'M_INVALID_PARAM', `${userId} is not a user id`);
    const context = await contextForName(serverName, options);
    if (!context) return void fail(response, 404, 'M_NOT_FOUND', `This deployment does not serve ${serverName}`);
    const authentication = await authenticateXMatrixRequest({
      authorization: headerValue(request.headers.authorization),
      method: 'GET',
      uri: requestTarget(request),
      keys: options.keys,
      serverName,
    });
    if (!authentication.valid || !authentication.origin) {
      return void fail(response, 401, 'M_UNAUTHORIZED', authentication.reason);
    }
    if (options.store.matrixUserIdFor(context.webId, serverName) !== userId) {
      return void fail(response, 404, 'M_NOT_FOUND', `${userId} is not a user of ${serverName}`);
    }

    // Nothing is published, so the answer is the empty profile whether a peer asked for one field
    // or for everything public: an unset field is omitted, which is what the specification allows.
    sendJson(response, 200, {});
  });
}

/**
 * `GET /version`: the implementation name and version, which is how a peer identifies who it is
 * talking to before it trusts anything else.
 */
export function createVersionHandler(options: FederationHandlerOptions): RouteHandler {
  return async (_request, response) => {
    sendJson(response, 200, {
      server: {
        name: options.implementation?.name ?? IMPLEMENTATION_NAME,
        version: options.implementation?.version ?? deploymentVersion(),
      },
    });
  };
}

/**
 * `GET /query/directory?room_alias=…`: the room an alias names, and the servers holding it.
 *
 * The alias carries the server it belongs to, and that is the Pod the answer comes from — an alias
 * is a field on the room's own record, so no directory service is involved and no Pod is searched
 * beyond the one the alias names. A peer is told which servers are in the room from the room's
 * resolved state, which is the same selection the outbound path delivers to.
 *
 * The addressed name is the one in the alias, not `Host`: this is the one endpoint whose subject is
 * a *server other than the one being talked to* in general, and the signed `destination` a peer
 * writes is the server it is asking about. A peer that addressed somebody else fails the check,
 * which is what a query about another server's alias should do.
 */
export function createDirectoryQueryHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response) => {
    const alias = queryOf(request).get('room_alias');
    if (!alias) return void fail(response, 400, 'M_MISSING_PARAM', 'room_alias is required');
    const match = /^#(?<localpart>[^:]+):(?<serverName>.+)$/u.exec(alias);
    if (!match?.groups) return void fail(response, 400, 'M_INVALID_PARAM', `${alias} is not a room alias`);

    // The query is addressed to the alias's own server, which is where the room's record lives.
    const serverName = match.groups.serverName;
    const context = await contextForName(serverName, options);
    if (!context) return void fail(response, 404, 'M_NOT_FOUND', `This deployment does not serve ${serverName}`);
    const authentication = await authenticateXMatrixRequest({
      authorization: headerValue(request.headers.authorization),
      method: 'GET',
      uri: requestTarget(request),
      keys: options.keys,
      serverName,
    });
    if (!authentication.valid || !authentication.origin) {
      return void fail(response, 401, 'M_UNAUTHORIZED', authentication.reason);
    }

    const room = await options.store.findRoomByAlias(alias, context);
    if (!room) return void fail(response, 404, 'M_NOT_FOUND', `No room is aliased ${alias}`);
    sendJson(response, 200, {
      room_id: room.roomId,
      servers: await options.store.roomServers(room.roomId, context),
    });
  });
}

/**
 * `GET /make_join`, `/make_leave`, `/make_knock`: the template the asking server fills in and signs.
 *
 * The room's version is checked against the `ver` the asking server offered, and its own permission
 * is decided here — on the template, with the same auth rules the finished event will meet — so a
 * refusal comes back as one answer instead of a signed event the room would reject.
 */
export function createTemplateHandler(options: FederationHandlerOptions, membership: MembershipKind): RouteHandler {
  return async (request, response, params) => {
    const roomId = decode(params.roomId);
    const room = await readRoom({ request, response, options, roomId });
    if (!room) return;
    // `make_knock` requires the parameter; the others default to the specification's `['1']`.
    const versions = queryOf(request).getAll('ver');
    const answer = buildMembershipTemplate({
      roomId,
      userId: decode(params.userId),
      membership,
      serverName: room.serverName,
      records: room.events.map(recordOfProtocolEvent),
      ...(versions.length === 0 ? {} : { versions }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    sendJson(response, answer.status, answer.body);
  };
}

/**
 * `PUT /send_join`, `/send_leave`, `/send_knock`: the signed membership event, judged and countersigned.
 *
 * The event is resolved against the room this deployment holds — that is what the auth events and
 * the state a join answers with come from — and the countersignature is that room's server, which
 * is the name this request was addressed to.
 */
export function createSubmissionHandler(
  options: FederationHandlerOptions,
  membership: MembershipKind,
): RouteHandler {
  return async (request, response, params) => {
    const body = await readJsonBody(request);
    if (!body.ok) return void fail(response, body.status, body.errcode, body.error);
    const roomId = decode(params.roomId);
    const room = await readRoom({ request, response, options, roomId, content: body.body });
    if (!room) return;

    const signer = await signerForName(room.serverName, options);
    const answer = await handleMembershipSubmission({
      membership,
      roomId,
      eventId: decode(params.eventId),
      event: body.body,
      origin: room.origin,
      keys: options.keys,
      authEvents: authEventsNamed(room.events, body.body),
      records: room.events.map(recordOfProtocolEvent),
      ...(signer === undefined ? {} : { counterSign: signer }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    reportWarnings(answer, roomId);
    // A resident that accepts a membership event accepts it into the room's graph: validating and
    // countersigning is not the same as keeping it, and a join the resident only *answered* would
    // exist solely in the joining server's Pod. Stored the way any received event is — verbatim and
    // marked as somebody else's — because that is what it is here.
    if (answer.status === 200 && isRecord(answer.body.event)) {
      await options.store.acceptReceivedEvent({ event: answer.body.event, context: room.context });
    }
    sendJson(response, answer.status, answer.body);
  };
}

/**
 * `PUT /invite`: add this deployment's signature to an invite for one of its users.
 *
 * No Pod is read: the invited server need not know the room, which is the whole shape of this
 * endpoint. The body is the specification's container, not the bare event.
 */
export function createInviteHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
    const body = await readJsonBody(request);
    if (!body.ok) return void fail(response, body.status, body.errcode, body.error);
    const serverName = await addressedServerName(request, options);
    if (!serverName) {
      return void fail(response, 403, 'M_FORBIDDEN', `This deployment does not serve ${hostOf(request)}`);
    }
    const authentication = await authenticateXMatrixRequest({
      authorization: headerValue(request.headers.authorization),
      method: (request.method ?? 'PUT').toUpperCase(),
      uri: requestTarget(request),
      content: body.body,
      keys: options.keys,
      serverName,
    });
    if (!authentication.valid || !authentication.origin) {
      return void fail(response, 401, 'M_UNAUTHORIZED', authentication.reason);
    }

    const signer = await signerForName(serverName, options);
    const answer = await handleMembershipSubmission({
      membership: 'invite',
      roomId: decode(params.roomId),
      eventId: decode(params.eventId),
      event: body.body.event,
      origin: authentication.origin,
      serverName,
      roomVersion: String(body.body.room_version ?? ''),
      ...(body.body.invite_room_state === undefined ? {} : { inviteRoomState: body.body.invite_room_state }),
      keys: options.keys,
      ...(signer === undefined ? {} : { counterSign: signer }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    reportWarnings(answer, decode(params.roomId));
    sendJson(response, answer.status, answer.body);
  };
}

/** The events a submitted membership event names as its authorisers, out of the room we hold. */
function authEventsNamed(events: readonly Record<string, unknown>[], event: Record<string, unknown>): AuthEvent[] {
  const index = new Map(events.map(entry => [ String(entry.event_id), entry ]));
  return eventReferenceIds(event, 'auth_events')
    .map(id => index.get(id))
    .filter((found): found is Record<string, unknown> => found !== undefined)
    .map(asAuthEvent);
}

/** The signer for a server name, or `undefined` when this deployment holds no key for it. */
async function signerForName(
  serverName: string,
  options: FederationHandlerOptions,
): Promise<MatrixEventSigner | undefined> {
  if (!options.signerFor) return undefined;
  try {
    return await options.signerFor(serverName);
  } catch {
    // A name this deployment holds no identity for is not an error here: it simply means the event
    // is accepted without our signature, and `/invite` says so for itself.
    return undefined;
  }
}

/**
 * Report what the specification says to warn about rather than refuse.
 *
 * Invites whose display state is malformed are the case today: for the room versions this
 * deployment serves the specification asks for a warning, and the invite stays usable.
 */
function reportWarnings(answer: { warnings?: string[] }, subject: string): void {
  for (const warning of answer.warnings ?? []) logger.warn(`${subject}: ${warning}`);
}

/**
 * The `GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}` handler: the events that authorise
 * one event, including itself, oldest first.
 */
export function createEventAuthHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response, params) => {
    const room = await readRoom({ request, response, options, roomId: decode(params.roomId) });
    if (!room) return;
    const { chain } = selectAuthChain(room.events, decode(params.eventId));
    sendJson(response, 200, { auth_chain: chain });
  });
}

/** `GET /state/{roomId}?event_id=…`: the resolved state before an event, and its auth chain. */
export function createStateHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response, params) => {
    const room = await readRoom({ request, response, options, roomId: decode(params.roomId) });
    if (!room) return;
    const eventId = queryOf(request).get('event_id');
    if (!eventId) return void fail(response, 400, 'M_MISSING_PARAM', 'event_id is required');
    const snapshot = stateSnapshotBefore(room.events.map(recordOfProtocolEvent), eventId);
    if (!snapshot) return void fail(response, 404, 'M_NOT_FOUND', `This server does not know ${eventId}`);
    sendJson(response, 200, { pdus: snapshot.pdus, auth_chain: snapshot.authChain });
  });
}

/** The same answer as ids, which is all a server that already has the events needs. */
export function createStateIdsHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response, params) => {
    const roomId = decode(params.roomId);
    const room = await readRoom({ request, response, options, roomId });
    if (!room) return;
    const eventId = queryOf(request).get('event_id');
    if (!eventId) return void fail(response, 400, 'M_MISSING_PARAM', 'event_id is required');
    const snapshot = stateIdsBefore(room.events.map(recordOfProtocolEvent), eventId);
    if (!snapshot) return void fail(response, 404, 'M_NOT_FOUND', `This server does not know ${eventId}`);
    sendJson(response, 200, { pdu_ids: snapshot.pduIds, auth_chain_ids: snapshot.authChainIds });
  });
}

/** `GET /backfill/{roomId}?v=…&limit=…`: a window of history, newest first, named events included. */
export function createBackfillHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response, params) => {
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
  });
}

/**
 * `POST /get_missing_events/{roomId}`: the parents a requester is missing, oldest first.
 *
 * Its request is a body, so the body is read (bounded) and parsed before authentication — the
 * signature covers it, and a body this server cannot read has no content to verify.
 */
export function createMissingEventsHandler(options: FederationHandlerOptions): RouteHandler {
  return safely(async (request, response, params) => {
    const body = await readJsonBody(request);
    if (!body.ok) return void fail(response, body.status, body.errcode, body.error);
    const content = body.body;
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
  });
}

/**
 * A request body that is JSON, read with a bound.
 *
 * The signature covers the body, so it is read and parsed before anything is authenticated; a body
 * this server cannot read has no content to verify, and saying so is a 400 rather than a rejection.
 */
async function readJsonBody(request: AuthenticatedRequest): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number; errcode: string; error: string }
> {
  let raw: string;
  try {
    raw = Buffer.concat(await readBoundedRequestBody(request, MAX_FEDERATION_BODY_BYTES,
      'The request body is larger than this server accepts')).toString('utf8');
  } catch (error) {
    return { ok: false, status: 413, errcode: 'M_TOO_LARGE',
      error: error instanceof Error ? error.message : 'The request body could not be read' };
  }
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, status: 400, errcode: 'M_NOT_JSON', error: 'Request body is not JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 400, errcode: 'M_BAD_JSON', error: 'Request body is not a JSON object' };
  }
  return { ok: true, body: parsed };
}

/** The room a read endpoint was asked about, or why the answer is an error instead. */
async function readRoom(input: {
  request: AuthenticatedRequest;
  response: ServerResponse;
  options: FederationHandlerOptions;
  roomId: string;
  content?: unknown;
}): Promise<{ origin: string; serverName: string; events: Record<string, unknown>[]; context: MatrixStoreContext } | undefined> {
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
  return { origin: authentication.origin, serverName, events, context };
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
 * `POST /_xpod/matrix/inbound/:txnId`: what one Xpod deployment sends another.
 *
 * The register's write-side decision (③): the sending deployment calls the peer's own API server and
 * the peer writes its Pod — its own authority, its own validation, its own records. So this is not a
 * second protocol. It carries exactly what a Matrix transaction carries (signed PDUs and the origin
 * that signed them) and reaches exactly the same decision code (`handleFederationSend`); what it
 * drops is the *federation transport*: no `:8448`, no SNI/Host gymnastics, no `.well-known`
 * discovery — just a signed request to the server name's ordinary HTTPS endpoint. `/send` stays for
 * peers that only speak Matrix.
 *
 * The response names results per event (`events`, not `pdus`) because this endpoint is ours; the
 * error codes are the same ones, so one core answers both and neither drifts from the other.
 */
export function createNativeInboundHandler(options: FederationHandlerOptions): RouteHandler {
  return async (request, response, params) => {
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
      sendJson(response, 413, { errcode: 'M_TOO_LARGE', error: error instanceof Error ? error.message : 'Unreadable request body' });
      return;
    }

    const transactionId = decode(params.txnId);
    let result: FederationSendResult;
    try {
      result = await handleFederationSend({
        authorization: headerValue(request.headers.authorization),
        method: 'POST',
        // The signature covers the request target the sender used, query string included.
        uri: requestTarget(request),
        // The native path names the transaction in its own segment; the transaction layer is told
        // rather than made to parse a Matrix route it never saw.
        transactionId,
        body,
        serverName: addressed,
        keys: options.keys,
        resolveTarget: async destination => await targetFor(destination, options),
        transactions: options.transactions,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (error) {
      sendJson(response, 500, {
        errcode: 'M_UNKNOWN',
        error: error instanceof Error ? error.message : 'Failed to process the transaction',
      });
      return;
    }
    sendJson(response, result.status, nativeAnswer(result.body));
  };
}

/** The same answer, under the names this endpoint uses: per-event results, errors unchanged. */
function nativeAnswer(body: Record<string, unknown>): Record<string, unknown> {
  const { pdus, ...rest } = body;
  return pdus === undefined ? rest : { events: pdus, ...rest };
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
    ...(options.recordsFor === undefined || context.podUrl === undefined
      ? {}
      : { records: await options.recordsFor(context) }),
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
const asAuthEvent = toAuthEvent;

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

/**
 * Run a federation handler, and answer with the status a failure actually has.
 *
 * A `MatrixError` is a *decision* — "this deployment holds no grant for that Pod", "the room is not
 * here" — and the peer has to see it as one (a 4xx it should not retry), not as an unknown failure.
 * Anything else is ours: it is logged as an internal error and answered as `500`, which a peer is
 * right to retry.
 */
function safely(run: RouteHandler): RouteHandler {
  return async (request, response, params) => {
    try {
      await run(request, response, params);
    } catch (error) {
      if (error instanceof MatrixError) {
        if (!response.headersSent) fail(response, error.status, error.errcode, error.message);
        return;
      }
      logger.error(`Federation route failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) fail(response, 500, 'M_UNKNOWN', 'Failed to answer the request');
    }
  };
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
