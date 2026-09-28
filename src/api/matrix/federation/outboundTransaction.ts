/**
 * Making signed federation requests to another server.
 *
 * `sendTransaction` is the one this module is named for: the other methods ask a peer for
 * something — missing events, an auth chain, history, state, a membership template — or submit a
 * membership event to it. All of them go through the same execution: resolve the destination,
 * sign the request that is actually sent, and classify the answer.
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
import { checkMembershipTemplate, type MembershipKind } from './membershipHandshake';
import { computeEventId } from '../protocol/eventIntegrity';
import { SUPPORTED_ROOM_VERSION } from '../protocol/authRules';
import type { FederationFetchTarget } from './federationFetch';
import type { MatrixResolvedServer } from './serverNameResolution';
import { isMatrixServerName, splitServerName } from '../protocol/serverName';

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

/** What any signed request produced, before a caller interprets the body. */
export interface FederationCallOutcome {
  status: 'ok' | 'retry' | 'rejected';
  reason: string;
  retryAfterMs?: number;
}

/** What a request for events produced: the peer's answer, or why there is none. */
export interface FederationEventsOutcome extends FederationCallOutcome {
  /** The peer's answer, when it was readable. */
  events?: Record<string, unknown>[];
  /** `/state` answers with a state and the auth chain it rests on. */
  authChain?: Record<string, unknown>[];
}

/** What a request for a room's state ids produced. */
export interface StateIdsOutcome extends FederationCallOutcome {
  pduIds?: string[];
  authChainIds?: string[];
}

/** What a `/make_join` or `/make_leave` request produced. */
export interface MembershipTemplateOutcome extends FederationCallOutcome {
  /** The room's version, as the resident server named it. */
  roomVersion?: string;
  /** The template to fill in and sign; checked against the request before it is returned. */
  event?: Record<string, unknown>;
}

/** What a `/version` request produced: which implementation is answering. */
export interface VersionOutcome extends FederationCallOutcome {
  server?: { name?: string; version?: string };
}

/** What a `/query/profile` request produced: the fields the queried server publishes. */
export interface ProfileQueryOutcome extends FederationCallOutcome {
  profile?: Record<string, unknown>;
}

/** What a `/query/directory` request produced: the room an alias names, and its servers. */
export interface DirectoryQueryOutcome extends FederationCallOutcome {
  roomId?: string;
  servers?: string[];
}

/** What a `/send_knock` request produced: the stripped state to show the knocking user. */
export interface SendKnockOutcome extends FederationCallOutcome {
  knockRoomState?: Record<string, unknown>[];
}

/** What an `/invite` request produced: the invite event with the invited server's signature. */
export interface SendInviteOutcome extends FederationCallOutcome {
  event?: Record<string, unknown>;
}

/** What a `/send_join` request produced: the room, and the join event as it was accepted. */
export interface SendJoinOutcome extends FederationCallOutcome {
  /** The room's resolved state *before* the join. */
  state?: Record<string, unknown>[];
  /** The auth chain that state rests on. */
  authChain?: Record<string, unknown>[];
  /** The join event as the resident accepted it, with the resident's own signature. */
  event?: Record<string, unknown>;
  /** Set by resident servers that omitted membership events; this deployment never does. */
  membersOmitted?: boolean;
  /** The servers with joined members before the join, when the resident sent the list. */
  serversInRoom?: string[];
}

export interface MatrixFederationClientOptions {
  /** The identity this deployment sends as. */
  identity: XMatrixSigner & { serverName: string };
  /** Where a destination server name is reached, and under which `Host`. */
  resolve: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  /**
   * Where a destination's *native* endpoint is. Defaults to the name itself on ordinary HTTPS
   * (`MatrixServerNameResolver.resolveNative`), because a native call is not federation traffic
   * and has nothing to discover. A test injects its own address here.
   */
  resolveNative?: (serverName: string) => Promise<MatrixResolvedServer | undefined>;
  fetch: typeof fetch;
  /**
   * A transport that can present the server name a delegated endpoint must prove (SNI and `Host`).
   * Absent means `fetch`, which is fine for a deployment whose peers are reached at their own name.
   */
  fetchTarget?: FederationFetchTarget;
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

/** Delivery policy before a caller overrides any part of it. */
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
  private readonly fetchTarget?: FederationFetchTarget;
  private readonly now: () => number;
  private readonly random: () => number;

  public constructor(options: MatrixFederationClientOptions & { random?: () => number }) {
    this.identity = options.identity;
    this.resolve = options.resolve;
    this.fetch = options.fetch;
    this.fetchTarget = options.fetchTarget;
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
   * Ask a resident server for a join template (`GET /make_join`).
   *
   * The answer is checked against the request before it is returned, because the template is what
   * this server is about to sign: the specification requires discarding one that names another
   * room, user, event type or membership, and a signature on it would attribute somebody else's
   * event to our user.
   *
   * `versions` is what this server offers to support. Absent means the room version this
   * deployment implements; an empty list sends no `ver` parameter at all, which the specification
   * defines as `['1']` — worth doing deliberately, not by accident.
   */
  public async makeJoin(input: {
    destination: string;
    roomId: string;
    userId: string;
    versions?: readonly string[];
  }): Promise<MembershipTemplateOutcome> {
    const versions = input.versions ?? [ SUPPORTED_ROOM_VERSION ];
    return await this.membershipTemplate({
      destination: input.destination,
      membership: 'join',
      uri: `/_matrix/federation/v1/make_join/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.userId)}${versionsQuery(versions)}`,
      expected: { roomId: input.roomId, userId: input.userId, membership: 'join', ...(versions.length === 0 ? {} : { versions }) },
    });
  }

  /** Ask a resident server for a leave template (`GET /make_leave`), for leaving or rejecting. */
  public async makeLeave(input: {
    destination: string;
    roomId: string;
    userId: string;
  }): Promise<MembershipTemplateOutcome> {
    return await this.membershipTemplate({
      destination: input.destination,
      membership: 'leave',
      uri: `/_matrix/federation/v1/make_leave/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.userId)}`,
      expected: { roomId: input.roomId, userId: input.userId, membership: 'leave' },
    });
  }

  /**
   * Submit a signed join event to a resident server (`PUT /send_join`, v2).
   *
   * The answer carries the room's state before the join and the auth chain it rests on, which is
   * what lets the joining server authorise the room's later events, plus the join event as the
   * resident accepted it. An event that is not the one submitted — judged by its own derived id,
   * which redaction preserves — is refused rather than returned: this server hands that event to
   * its own clients as the membership everyone agrees on.
   */
  public async sendJoin(input: {
    destination: string;
    roomId: string;
    eventId: string;
    event: Record<string, unknown>;
    /** Ask the resident to leave membership events out of `state`; only a hint. */
    omitMembers?: boolean;
  }): Promise<SendJoinOutcome> {
    const query = input.omitMembers ? '?omit_members=true' : '';
    const uri = `/_matrix/federation/v2/send_join/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.eventId)}${query}`;
    const result = await this.execute({ destination: input.destination, method: 'PUT', uri, content: input.event });
    if (result.status !== 'ok') return result;

    const body = isRecord(result.body) ? result.body : undefined;
    const state = body?.state;
    const authChain = body?.auth_chain;
    if (!Array.isArray(state) || !Array.isArray(authChain)) {
      return { status: 'retry', reason: 'destination answered 200 without state and auth_chain' };
    }
    const event = body?.event;
    if (event !== undefined) {
      const id = derivedEventId(event);
      if (id !== input.eventId) {
        return { status: 'rejected', reason: `destination answered with ${id ?? 'an unusable'} join event, not ${input.eventId}` };
      }
    }
    const serversInRoom = Array.isArray(body?.servers_in_room) ? body.servers_in_room.map(String) : undefined;
    return {
      status: 'ok',
      state: state as Record<string, unknown>[],
      authChain: authChain as Record<string, unknown>[],
      ...(isRecord(event) ? { event } : {}),
      ...(body?.members_omitted === true ? { membersOmitted: true } : {}),
      ...(serversInRoom === undefined ? {} : { serversInRoom }),
      reason: 'ok',
    };
  }

  /**
   * Ask a resident server for a knock template (`GET /make_knock`).
   *
   * Knocking is the join handshake with a different membership and a different answer, and the one
   * request-shape difference is that `ver` is required: knocking arrived in room version 7, so a
   * knocking server always has to say what it supports.
   */
  public async makeKnock(input: {
    destination: string;
    roomId: string;
    userId: string;
    versions?: readonly string[];
  }): Promise<MembershipTemplateOutcome> {
    const versions = input.versions ?? [ SUPPORTED_ROOM_VERSION ];
    return await this.membershipTemplate({
      destination: input.destination,
      membership: 'knock',
      uri: `/_matrix/federation/v1/make_knock/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.userId)}${versionsQuery(versions)}`,
      expected: { roomId: input.roomId, userId: input.userId, membership: 'knock', ...(versions.length === 0 ? {} : { versions }) },
    });
  }

  /**
   * Submit a signed knock event to a resident server (`PUT /send_knock`).
   *
   * The answer is the room's stripped state — what the knocking user's client shows while they wait
   * to be let in — and nothing about the knock itself.
   */
  public async sendKnock(input: {
    destination: string;
    roomId: string;
    eventId: string;
    event: Record<string, unknown>;
  }): Promise<SendKnockOutcome> {
    const uri = `/_matrix/federation/v1/send_knock/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.eventId)}`;
    const result = await this.execute({ destination: input.destination, method: 'PUT', uri, content: input.event });
    if (result.status !== 'ok') return result;
    const state = isRecord(result.body) ? result.body.knock_room_state : undefined;
    if (!Array.isArray(state)) return { status: 'retry', reason: 'destination answered 200 without knock_room_state' };
    return { status: 'ok', knockRoomState: state as Record<string, unknown>[], reason: 'ok' };
  }

  /**
   * Submit a signed leave event to a resident server (`PUT /send_leave`, v2).
   *
   * There is nothing to read back: the resident accepts the event, relays it, and answers with an
   * empty object.
   */
  public async sendLeave(input: {
    destination: string;
    roomId: string;
    eventId: string;
    event: Record<string, unknown>;
  }): Promise<FederationCallOutcome> {
    const uri = `/_matrix/federation/v2/send_leave/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.eventId)}`;
    const result = await this.execute({ destination: input.destination, method: 'PUT', uri, content: input.event });
    if (result.status !== 'ok') return result;
    return { status: 'ok', reason: 'ok' };
  }

  /**
   * Ask a peer to sign an invite for one of its users (`PUT /invite`, v2).
   *
   * The body is a container — `{room_version, event, invite_room_state?}` — rather than the bare
   * event, and the answer is the same event with the invited server's signature added. Its
   * signature is the reason the request was made, and the caller still has to verify it against
   * that server's keys before the invite goes out to the room (this client holds no key source);
   * a 200 without a usable event, or without that server's signature on it, is answered as worth
   * retrying, and an event that is not the one submitted as a refusal.
   */
  public async sendInvite(input: {
    destination: string;
    roomId: string;
    eventId: string;
    event: Record<string, unknown>;
    /** The room version the invite is for; the version this deployment implements by default. */
    roomVersion?: string;
    /** Stripped state to help the invited server's user identify the room. */
    inviteRoomState?: Record<string, unknown>[];
  }): Promise<SendInviteOutcome> {
    const content: Record<string, unknown> = {
      room_version: input.roomVersion ?? SUPPORTED_ROOM_VERSION,
      event: input.event,
    };
    // An empty list would be a field the peer has to interpret for nothing.
    if (input.inviteRoomState && input.inviteRoomState.length > 0) content.invite_room_state = [ ...input.inviteRoomState ];
    const uri = `/_matrix/federation/v2/invite/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.eventId)}`;
    const result = await this.execute({ destination: input.destination, method: 'PUT', uri, content });
    if (result.status !== 'ok') return result;

    const event = isRecord(result.body) ? result.body.event : undefined;
    if (!isRecord(event)) return { status: 'retry', reason: 'destination answered 200 without the signed invite event' };
    const id = derivedEventId(event);
    if (id !== input.eventId) {
      return { status: 'rejected', reason: `destination signed ${id ?? 'an unusable'} invite event, not ${input.eventId}` };
    }
    const signatures = isRecord(event.signatures) ? event.signatures : undefined;
    if (!isRecord(signatures?.[input.destination])) {
      return { status: 'retry', reason: `destination answered 200 without its own signature on the invite` };
    }
    return { status: 'ok', event, reason: 'ok' };
  }

  /**
   * Ask a server which implementation it is (`GET /version`).
   *
   * The one request that is not signed, because it is the question a peer asks before it trusts
   * anything: it says who is answering, and the answer is a name and a version, nothing more.
   */
  public async getVersion(input: { destination: string }): Promise<VersionOutcome> {
    const uri = '/_matrix/federation/v1/version';
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    const server = isRecord(result.body) ? result.body.server : undefined;
    if (!isRecord(server)) return { status: 'retry', reason: 'destination answered 200 without a server object' };
    return {
      status: 'ok',
      server: {
        ...(typeof server.name === 'string' ? { name: server.name } : {}),
        ...(typeof server.version === 'string' ? { version: server.version } : {}),
      },
      reason: 'ok',
    };
  }

  /**
   * Ask a server which room one of its aliases names (`GET /query/directory`).
   *
   * The alias has to belong to the server being asked; a peer that asks elsewhere is asking a
   * server that cannot know, and the answer is a 404 rather than a guess.
   */
  public async queryDirectory(input: {
    destination: string;
    roomAlias: string;
  }): Promise<DirectoryQueryOutcome> {
    const uri = `/_matrix/federation/v1/query/directory?${new URLSearchParams({ room_alias: input.roomAlias }).toString()}`;
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    const roomId = isRecord(result.body) ? result.body.room_id : undefined;
    const servers = isRecord(result.body) ? result.body.servers : undefined;
    if (typeof roomId !== 'string' || !Array.isArray(servers)) {
      return { status: 'retry', reason: 'destination answered 200 without a room_id and servers' };
    }
    return { status: 'ok', roomId, servers: servers.map(String), reason: 'ok' };
  }

  /**
   * Ask a server what it publishes about one of its users (`GET /query/profile`).
   *
   * The user has to belong to the server being asked; the answer may legitimately be empty, because
   * a field a user has not set is omitted rather than invented.
   */
  public async queryProfile(input: {
    destination: string;
    userId: string;
    field?: 'displayname' | 'avatar_url';
  }): Promise<ProfileQueryOutcome> {
    const query = new URLSearchParams({ user_id: input.userId });
    if (input.field !== undefined) query.set('field', input.field);
    const uri = `/_matrix/federation/v1/query/profile?${query.toString()}`;
    const result = await this.execute({ destination: input.destination, method: 'GET', uri });
    if (result.status !== 'ok') return result;
    if (!isRecord(result.body)) return { status: 'retry', reason: 'destination answered 200 without a profile' };
    return { status: 'ok', profile: result.body, reason: 'ok' };
  }

  /** All three templates are the same request shape with a different endpoint and membership. */
  private async membershipTemplate(input: {
    destination: string;
    membership: MembershipKind;
    uri: string;
    expected: { roomId: string; userId: string; membership: MembershipKind; versions?: readonly string[] };
  }): Promise<MembershipTemplateOutcome> {
    const result = await this.execute({ destination: input.destination, method: 'GET', uri: input.uri });
    if (result.status !== 'ok') return result;
    const check = checkMembershipTemplate(result.body, input.expected);
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    const body = result.body as Record<string, unknown>;
    return { status: 'ok', roomVersion: String(body.room_version), event: body.event as Record<string, unknown>, reason: 'ok' };
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
    const sent = await this.sendSigned(request);
    if ('failure' in sent) return sent.failure;
    return await this.classify(sent.response, sent.text, request.destination);
  }

  /** Resolve, sign and send one request; the answer is unread, because callers read it differently. */
  private async sendSigned(request: {
    destination: string;
    method: string;
    uri: string;
    content?: Record<string, unknown>;
  }): Promise<{ response: Response; text: string } | { failure: MatrixRequestOutcome }> {
    const target = await this.resolve(request.destination);
    if (!target) return { failure: { status: 'rejected', reason: `cannot resolve ${request.destination}` } };

    const authorization = buildXMatrixAuthorization({
      origin: this.identity.serverName,
      destination: request.destination,
      method: request.method,
      uri: request.uri,
      ...(request.content === undefined ? {} : { content: request.content }),
    }, this.identity);

    const url = `${target.baseUrl}${request.uri}`;
    const init: RequestInit = {
      method: request.method,
      headers: {
        ...(request.content === undefined ? {} : { 'content-type': 'application/json' }),
        authorization,
      },
      ...(request.content === undefined ? {} : { body: JSON.stringify(request.content) }),
    };
    let response: Response;
    try {
      // A resolved target carries both the address and the name it must prove; only a transport
      // that can set both is able to present them, which is what delegation requires.
      response = this.fetchTarget
        ? await this.fetchTarget({ url, init, target })
        : await this.fetch(url, init);
    } catch (error) {
      // Unreachable is "the peer has not decided", never "the peer refused".
      return { failure: { status: 'retry', reason: `could not reach ${request.destination}: ${describeError(error)}` } };
    }
    return { response, text: await response.text().catch(() => '') };
  }

  /** What a peer's answer means, once the request went out. */
  private async classify(response: Response, text: string, destination: string): Promise<MatrixRequestOutcome> {
    if (response.status === 200) return { status: 'ok', body: parseJson(text), reason: 'ok' };

    const retryAfterMs = readRetryAfter(text, response.headers.get('retry-after'), this.now());
    if (response.status === 429) {
      return { status: 'retry', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: 'destination rate limited the request' };
    }
    if (response.status >= 500) {
      return { status: 'retry', ...(retryAfterMs === undefined ? {} : { retryAfterMs }), reason: `destination answered ${response.status}` };
    }
    // A refusal is a decision, and the peer's own words are what an operator needs to act on it:
    // "refused with 403" alone sends them to a log they do not have.
    const refusal = parseJson(text);
    const detail = isRecord(refusal) && typeof refusal.error === 'string'
      ? ` (${String(refusal.errcode ?? 'M_UNKNOWN')}: ${refusal.error})`
      : '';
    return { status: 'rejected', reason: `destination refused the request with ${response.status}${detail}` };
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

/** `?ver=…` repeated, as the specification's array parameter is encoded; an empty list sends none. */
function versionsQuery(versions: readonly string[]): string {
  if (versions.length === 0) return '';
  const query = new URLSearchParams();
  for (const version of versions) query.append('ver', version);
  return `?${query.toString()}`;
}

/** The id an event has by its own content, or `undefined` when it cannot be one of ours. */
function derivedEventId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  try {
    return computeEventId(value);
  } catch {
    // Values canonical JSON refuses cannot be an event this server submitted.
    return undefined;
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
