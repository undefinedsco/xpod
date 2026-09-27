/**
 * The membership handshakes, minus the HTTP transport: join, leave and invite.
 *
 * `GET /make_join` + `PUT /send_join` (v2) and `GET /make_leave` + `PUT /send_leave` (v2) are one
 * protocol: a server that wants a membership event asks a server already in the room for a
 * *template*, fills in what only the sender can know, signs it, and submits it back.
 *
 * `PUT /invite` (v2) is the odd one, and deliberately so. There is no template to ask for — the
 * inviting server is in the room and builds the event itself — and the invited server usually does
 * not know the room at all: it is asked for one thing only, its own signature on an invite for one
 * of its users. So it verifies the event's structure and signature (`verifyInboundPdu`) and does
 * **not** judge authorisation; the room's servers judge that when the invite reaches them in a
 * transaction. That is also why its answer carries no state: the invitee has none to compare.
 *
 * Why the template comes from the resident server at all: `prev_events`, `auth_events` and
 * `depth` are part of the event, are covered by its hash and signature, and only a server that
 * can see the room's graph can choose them. The specification says the joining server adds or
 * replaces `origin`, `origin_server_ts` and `event_id` — everything else is used as received,
 * which is why the template is built with `roomGraphPosition`, the same selection the local write
 * path uses: a member who joins through this handshake and one who joins locally attach to the
 * room by the same rules.
 *
 * Neither half trusts the other for anything it can derive:
 *
 * - the joining server checks that the template is about the room and the user it asked for (the
 *   specification requires discarding a mismatched template rather than joining with it);
 * - the resident server checks that the submission is a `m.room.member` event for a user on the
 *   server that signed the request, that the path's event id is the event's own derived id, and
 *   then runs the ordinary inbound PDU pipeline — signature, content hash, auth rules
 *   (`validateInboundPdu`) — instead of a second, weaker path.
 *
 * The resident adds its own signature to an accepted event before the joining server sees it,
 * which is what the joining server hands to its clients as the one event everyone agrees on.
 *
 * Three deliberate gaps, all recorded in `docs/matrix-collaboration-decisions.md`:
 *
 * - **which Pod** the room lives in, and who may write it, stay with the caller (`acceptEvent` in
 *   `inboundRoute.ts` is the same boundary): this module decides the protocol, not the deployment.
 * - **`/invite` v1 is not implemented.** It is deprecated (v1.1), it exists for room versions 1
 *   and 2 only, and this deployment serves room version 11, so there is nothing to fall back to.
 * - **`omit_members` is a hint we do not take.** The specification *permits* omitting membership
 *   events from the answer when asked, and never requires it, so this server always answers with
 *   the resolved state and never sets `members_omitted` — the flag would claim an omission that
 *   did not happen. (Answering with a partial state and claiming the omission would be worse:
 *   the joining server would have to go and fetch what it was not told.)
 */
import { authorizeEvent, isUserId, serverNameOf, SUPPORTED_ROOM_VERSION, type AuthEvent } from '../protocol/authRules';
import { computeEventId } from '../protocol/eventIntegrity';
import { eventReferenceIds } from '../protocol/eventReferences';
import { roomGraphPosition } from '../protocol/roomGraph';
import { storedGraphEvent, storedProtocolEvent } from '../storedEvent';
import { stateSnapshotBeforeParents } from './roomStateSnapshot';
import { strippedRoomState, strippedStateWarnings } from './strippedState';
import { normalizeInboundPdu, validateInboundPdu, verifyInboundPdu, type InboundPduResult } from './inboundPdu';
import type { MatrixServerKeySource } from './serverKeys';
import type { MatrixEventRecord } from '../types';

/** The membership events with a template-and-submit handshake. */
export type MembershipKind = 'join' | 'leave' | 'knock';

/** What a submission may claim to be: the three above, plus an invite (which has no template). */
export type MembershipSubmissionKind = MembershipKind | 'invite';

export interface MembershipTemplateInput {
  roomId: string;
  /** The user the membership event is for; the joining or leaving server's own user. */
  userId: string;
  membership: MembershipKind;
  /** The name of the server answering: it signs nothing yet, but it names the template's origin. */
  serverName: string;
  /** The room as this server sees it. */
  records: readonly MatrixEventRecord[];
  /**
   * The room versions the asking server said it supports, from the `ver` query parameter.
   * Absent means the specification's default, `['1']` — not "everything". `make_knock` is the
   * exception: there the parameter is required (knocking arrived in room version 7), so a request
   * without it is invalid rather than version 1.
   */
  versions?: readonly string[];
  now?: () => number;
}

export interface MembershipHandshakeResponse {
  status: number;
  body: Record<string, unknown>;
  /**
   * Things the specification says to report rather than refuse: today, the invite's
   * `invite_room_state` for the room version this deployment serves. The caller logs them.
   */
  warnings?: string[];
}

/** A server that can add its own signature to an event it accepts. */
export interface MatrixEventSigner {
  signEvent(event: Record<string, unknown>): Record<string, unknown>;
}

/**
 * The template for `/make_join` or `/make_leave`.
 *
 * The room's version is checked against what the asking server supports *before* anything else:
 * a template the asker cannot build an event for is useless, and the specification makes this the
 * one error that carries `room_version` so the asker can report it.
 *
 * The user's own permission is decided here, on the template, with the same auth rules the write
 * path will apply to the finished event: the resident is the only side that can see the room, and
 * a `403` now is better than a round trip that ends in a rejected event. Missing auth events mean
 * this server's copy of the room is incomplete — it cannot authorise anything, and says so rather
 * than handing out a template whose event the room would refuse.
 */
export function buildMembershipTemplate(input: MembershipTemplateInput): MembershipHandshakeResponse {
  // An unknown room is not a room this server can hand out a template for, and saying so is not
  // the same as refusing the user: `403` would claim we know the room and the room says no.
  if (!input.records.some(record => record.type === 'm.room.create')) {
    return { status: 404, body: { errcode: 'M_NOT_FOUND', error: `This server does not know ${input.roomId}` } };
  }
  const roomVersion = roomVersionOf(input.records);
  if (input.versions === undefined && input.membership === 'knock') {
    return { status: 400, body: { errcode: 'M_MISSING_PARAM', error: 'make_knock requires the ver parameter' } };
  }
  const versions = input.versions ?? [ '1' ];
  if (!versions.includes(roomVersion)) {
    return {
      status: 400,
      body: {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error: `This room is version ${roomVersion}, which the requesting server did not offer to support`,
        room_version: roomVersion,
      },
    };
  }

  const position = roomGraphPosition(input.records.map(storedGraphEvent), {
    type: 'm.room.member',
    sender: input.userId,
    stateKey: input.userId,
    content: { membership: input.membership },
  });
  const authEvents = resolveAuthEvents(input.records, position.authEvents);
  if (!authEvents) {
    return forbidden(`This server cannot authorise an event in ${input.roomId}: its auth events are not all available here`);
  }
  const decision = authorizeEvent({
    type: 'm.room.member',
    sender: input.userId,
    room_id: input.roomId,
    state_key: input.userId,
    content: { membership: input.membership },
    prev_events: position.prevEvents,
  }, authEvents);
  if (!decision.allowed) return forbidden(decision.reason);

  return {
    status: 200,
    body: {
      room_version: roomVersion,
      event: {
        room_id: input.roomId,
        type: 'm.room.member',
        sender: input.userId,
        state_key: input.userId,
        origin: input.serverName,
        origin_server_ts: (input.now ?? Date.now)(),
        content: { membership: input.membership },
        depth: position.depth,
        prev_events: position.prevEvents,
        auth_events: position.authEvents,
      },
    },
  };
}

export interface MembershipTemplateCheck {
  ok: boolean;
  reason: string;
}

/**
 * What the asking server must check about a template before signing it.
 *
 * A template that names another room, another user, another event type or another membership is
 * not a template for the event that was asked for, and the specification says to discard it: it
 * would be signed by this server and attributed to its user. The room version is held to the list
 * this server offered to support for the same reason — a version it does not implement is not an
 * event it can build or hash.
 */
export function checkMembershipTemplate(
  body: unknown,
  expected: { roomId: string; userId: string; membership: MembershipKind; versions?: readonly string[] },
): MembershipTemplateCheck {
  if (!isRecord(body)) return { ok: false, reason: 'the answer is not a JSON object' };
  const event = body.event;
  if (!isRecord(event)) return { ok: false, reason: 'the answer carries no event template' };
  if (event.room_id !== expected.roomId) return { ok: false, reason: `the template is for room ${String(event.room_id)}` };
  if (event.sender !== expected.userId) return { ok: false, reason: `the template is sent by ${String(event.sender)}` };
  if (event.state_key !== expected.userId) return { ok: false, reason: `the template sets the membership of ${String(event.state_key)}` };
  if (event.type !== 'm.room.member') return { ok: false, reason: `the template is a ${String(event.type)} event` };
  const content = isRecord(event.content) ? event.content : undefined;
  if (content?.membership !== expected.membership) {
    return { ok: false, reason: `the template's membership is ${String(content?.membership)}` };
  }
  if (typeof body.room_version !== 'string') return { ok: false, reason: 'the answer names no room version' };
  // The version has to be one we offered to support: a template for another room version is not
  // an event this server can build, hash or sign.
  if (expected.versions && !expected.versions.includes(body.room_version)) {
    return { ok: false, reason: `the template is for room version ${body.room_version}` };
  }
  return { ok: true, reason: 'the template matches the request' };
}

interface MembershipSubmissionBase {
  roomId: string;
  /** The event id from the request path; it must be the id the event itself has. */
  eventId: string;
  /** The submitted event: the body itself for `/send_*`, `body.event` for `/invite`. */
  event: unknown;
  /** The server name that signed the request, from `authenticateXMatrixRequest`. */
  origin: string;
  /** Verify keys of the servers involved; typically `MatrixServerKeyFetcher`. */
  keys: MatrixServerKeySource;
  /** Adds this server's signature to an accepted event; without one nothing is signed. */
  counterSign?: MatrixEventSigner;
  now?: () => number;
}

/** A `/send_join`, `/send_leave` or `/send_knock`: this server knows the room, so it judges the event. */
export interface RoomMembershipSubmission extends MembershipSubmissionBase {
  membership: MembershipKind;
  /** The room as this server sees it; the caller resolved the auth events from it already. */
  records: readonly MatrixEventRecord[];
  /** The events the submitted event's `auth_events` name, resolved by the caller. */
  authEvents: readonly AuthEvent[];
}

/**
 * An `/invite` submission. There is no room to judge the event against — the invited server need
 * not know it, and the room's own servers decide authorisation when the invite reaches them — so
 * the only things here are the event, the room version it claims to be, and the display state the
 * inviting server thought would help.
 */
export interface InviteMembershipSubmission extends MembershipSubmissionBase {
  membership: 'invite';
  /** The name this request was addressed to: the invited user must be one of *its* users. */
  serverName: string;
  /** The room version the invite claims, from the request body. */
  roomVersion: string;
  /** The stripped state the inviting server sent, from the request body. */
  inviteRoomState?: unknown;
}

export type MembershipSubmissionInput = RoomMembershipSubmission | InviteMembershipSubmission;

/**
 * The decision a resident server makes about a submitted membership event, and the answer.
 *
 * The membership-specific checks come first because the specification names them (`M_INVALID_PARAM`
 * for a wrong type, membership, sender server or `state_key`), and they are cheap: they reject a
 * body that is not the event the endpoint is for before any key is fetched. The id check is the
 * same idea one step further: room v11 derives the event id from the event, so an event whose
 * derived id is not the id in the path is not the event the sender thinks it sent — accepting it
 * under either id would break the sender's own de-duplication.
 *
 * What remains is the ordinary inbound PDU pipeline, so a join accepted here and a join received in
 * a transaction are held to exactly the same standard; `refusal` maps its outcome onto the answer
 * the submitting server needs to see. An invite is the exception (see the module note): it is
 * verified, not authorised, and answered with the signed event alone.
 *
 * The three room-side answers differ only in what the submitting server needs back: the resolved
 * state prior to a join, nothing at all for a leave, and the stripped state that lets a knocking
 * server's client show what it is knocking on.
 */
export async function handleMembershipSubmission(
  input: MembershipSubmissionInput,
): Promise<MembershipHandshakeResponse> {
  if (input.membership === 'invite') return await handleInvite(input);
  const submitted = normalizeSubmission(input, { kind: 'sender' });
  if (!submitted.event) return invalid(submitted.reason);
  if (submitted.eventId !== input.eventId) {
    return invalid(`The event's own id ${submitted.eventId} is not the ${input.eventId} in the request path`);
  }

  const result = await validateInboundPdu(submitted.event, {
    keys: input.keys,
    authEvents: input.authEvents,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (result.outcome !== 'accepted' || !result.event) return refusal(result, input.membership);

  // The resident's own signature goes on before anything else reads the event, and covers the
  // event as accepted, including a redaction the content hash required.
  const accepted = input.counterSign ? input.counterSign.signEvent(result.event) : result.event;
  if (input.membership === 'leave') return { status: 200, body: {} };
  // A knock asks to be let in; the answer is what the knocking user's client needs to show them
  // what they are asking to join. The event itself is not handed back, per the endpoint's shape.
  if (input.membership === 'knock') {
    return { status: 200, body: { knock_room_state: strippedRoomState(input.records) } };
  }

  // `state` is the resolved state *prior to* the join event, so it is taken from the parents the
  // event names — the join itself is not in the room yet, and must not be part of its own answer.
  const snapshot = stateSnapshotBeforeParents(input.records, eventReferenceIds(accepted, 'prev_events'));
  return {
    status: 200,
    body: {
      state: snapshot.pdus,
      auth_chain: snapshot.authChain,
      event: accepted,
    },
  };
}

/**
 * `/invite`: add this server's signature and hand the event back.
 *
 * The invited server's signature is the whole point of the endpoint — the inviting server needs it
 * before it can send the invite to the room — so a deployment with no signing identity cannot serve
 * it, and says so rather than answering with an event it did not sign.
 *
 * The `invite_room_state` is checked and reported, never refused: the specification tells servers
 * to warn rather than error for room versions 1–11, and this deployment serves room version 11.
 * The invited server keeps none of it — the inviting server sends the invite on to the room's
 * servers, and the invitee reads the room through the ordinary sync once it joins.
 */
async function handleInvite(input: InviteMembershipSubmission): Promise<MembershipHandshakeResponse> {
  if (input.roomVersion !== SUPPORTED_ROOM_VERSION) {
    return {
      status: 400,
      body: {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error: `This server cannot verify an event for room version ${input.roomVersion}`,
        room_version: input.roomVersion,
      },
    };
  }
  if (!input.counterSign) {
    return { status: 500, body: { errcode: 'M_UNKNOWN', error: 'This deployment has no signing identity to add to the invite' } };
  }
  const submitted = normalizeSubmission(input, { kind: 'receiving', serverName: input.serverName });
  if (!submitted.event) return invalid(submitted.reason);
  if (submitted.eventId !== input.eventId) {
    return invalid(`The event's own id ${submitted.eventId} is not the ${input.eventId} in the request path`);
  }

  const verified = await verifyInboundPdu(submitted.event, {
    keys: input.keys,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (verified.outcome !== 'accepted' || !verified.event) return refusal(verified, 'invite');

  const warnings = strippedStateWarnings(input.inviteRoomState);
  return {
    status: 200,
    body: { event: input.counterSign.signEvent(verified.event) },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

interface NormalizedSubmission {
  event?: Record<string, unknown>;
  eventId: string;
  reason: string;
}

/**
 * The membership-specific preconditions, then the event as it should be judged.
 *
 * The id is derived here rather than read from the body: room v11 computes it from the event, and a
 * body cannot be trusted to carry its own identity.
 *
 * Whose user the `state_key` must name is the one rule that differs across the family. A join or a
 * leave changes the sender's own membership. An invite changes somebody else's, and the
 * specification's precondition is that the target is a user of the *receiving* server — that is
 * what makes the invite worth signing for us.
 */
function normalizeSubmission(
  input: MembershipSubmissionInput,
  stateKey: { kind: 'sender' } | { kind: 'receiving'; serverName: string },
): NormalizedSubmission {
  const shape = normalizeInboundPdu(input.event);
  if (!shape.event) return { eventId: '', reason: shape.reason };
  const event = shape.event;
  if (event.type !== 'm.room.member') return { eventId: '', reason: `a ${input.membership} submission must be an m.room.member event` };
  const content = isRecord(event.content) ? event.content : undefined;
  if (content?.membership !== input.membership) {
    return { eventId: '', reason: `the event's membership is ${String(content?.membership)}, not ${input.membership}` };
  }
  if (serverNameOf(String(event.sender)) !== input.origin) {
    return { eventId: '', reason: `the event's sender ${String(event.sender)} is not a user of ${input.origin}` };
  }
  if (stateKey.kind === 'sender') {
    if (event.state_key !== event.sender) return { eventId: '', reason: 'the event changes somebody else\'s membership' };
  } else {
    const invited = String(event.state_key ?? '');
    if (!isUserId(invited) || serverNameOf(invited) !== stateKey.serverName) {
      return { eventId: '', reason: `the invite is for ${invited || 'nobody'}, who is not a user of ${stateKey.serverName}` };
    }
  }
  if (event.room_id !== input.roomId) return { eventId: '', reason: `the event is for room ${String(event.room_id)}` };
  return { event, eventId: computeEventId(event), reason: 'a membership event for a user of the requesting server' };
}

/**
 * How a refused event is reported to the server that submitted it.
 *
 * The specification nominates `M_INVALID_PARAM` for a failed signature check and for a body that
 * is not the membership event the endpoint is for, and `M_FORBIDDEN` for an authorisation the room
 * refuses. A dependency gap is neither: the event is well formed and may well be allowed, this
 * server simply cannot decide, so it answers with the errcode the specification gives for "ask a
 * different server" — the joining server's next resident may hold the auth chain.
 */
function refusal(result: InboundPduResult, membership: MembershipSubmissionKind): MembershipHandshakeResponse {
  if (result.stage === 'authorisation') return forbidden(result.reason);
  if (result.stage === 'dependencies') {
    // `M_UNABLE_TO_GRANT_JOIN` is the specification's code for "ask a different server", and it is
    // named for joining; knocking has no such code, so it keeps the mandated `M_INVALID_PARAM` and
    // says in the reason what is actually missing.
    return {
      status: 400,
      body: {
        errcode: membership === 'join' ? 'M_UNABLE_TO_GRANT_JOIN' : 'M_INVALID_PARAM',
        error: result.reason,
      },
    };
  }
  return invalid(result.reason);
}

/** The room's version, from the create event. Rooms without one are the version this server serves. */
function roomVersionOf(records: readonly MatrixEventRecord[]): string {
  for (const record of records) {
    if (record.type !== 'm.room.create') continue;
    const version = record.content.room_version;
    if (typeof version === 'string' && version) return version;
  }
  return SUPPORTED_ROOM_VERSION;
}

/** The events named by `ids`, or `undefined` when any of them is not in the room's copy. */
function resolveAuthEvents(records: readonly MatrixEventRecord[], ids: readonly string[]): AuthEvent[] | undefined {
  const byId = new Map(records.map(record => [ record.eventId, record ]));
  const resolved: AuthEvent[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (!record) return undefined;
    resolved.push(storedProtocolEvent(record) as AuthEvent);
  }
  return resolved;
}

function forbidden(reason: string): MembershipHandshakeResponse {
  return { status: 403, body: { errcode: 'M_FORBIDDEN', error: reason } };
}

function invalid(reason: string): MembershipHandshakeResponse {
  return { status: 400, body: { errcode: 'M_INVALID_PARAM', error: reason } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
