import { createHash, randomBytes } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  chatResource,
  messageResource,
  MessageRole,
  MessageStatus,
  threadResource,
  runResource,
  runStepResource,
  deliveryResource,
} from '@undefineds.co/models';
import {
  normalizeAgentUris,
  normalizeReconcilerOwner,
  reconcilerCoordinationMetadata,
  type ReconcilerOwner,
  type ServerGroupReconcilerService,
} from '../reconciler';
import { getProtocolMetadata, withProtocolMetadata, type ProtocolMetadata } from '../protocol-metadata';
import { MatrixError } from './MatrixError';
import { InMemoryMatrixEventJournal, type MatrixEventJournal, type MatrixTransactionReservation } from './MatrixEventJournal';
import { buildPersistedEvent, readPersistedEvent, type PersistedEventInput, type PersistedMatrixEvent } from './persistedEvent';
import { roomGraphPosition } from './protocol/roomGraph';
import { storedGraphEvent } from './storedEvent';
import { MatrixRoomState, MatrixRoomStateReplay, resolveRoomState } from './roomState';
import { serverNameOf, SUPPORTED_ROOM_VERSION } from './protocol/authRules';
import { eventDestinations } from './federation/destinations';
import { webIdServerName } from './protocol/serverName';
import {
  roomChatIri,
  roomMessagesDocumentIri,
  roomSurfaceId,
  roomThreadIri,
} from './roomResources';
import type { MatrixSigningIdentitySource } from './identityRegistry';
import { computeEventId, EventIntegrityError } from './protocol/eventIntegrity';
import type { MatrixServiceIdentity } from './protocol/serviceIdentity';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { SharedWakeAgentJob } from '../reconciler/coordination';
import { sharedWakeAgentJobId, type WakeAgentQueue } from '../reconciler/WakeAgentQueue';
import { isSolidAuth, type AuthContext } from '../auth/AuthContext';
import type {
  MatrixAccountInfo,
  MatrixClientEvent,
  MatrixCreateRoomRequest,
  MatrixEventRecord,
  MatrixRoomRecord,
  MatrixSendEventRequest,
  MatrixStoreContext,
  MatrixSyncResponse,
} from './types';

const schema = {
  chat: chatResource,
  thread: threadResource,
  message: messageResource,
  run: runResource,
  runStep: runStepResource,
  delivery: deliveryResource,
};

/**
 * Provisioning a participant's own signing identity when they enter a room.
 *
 * Which participants a deployment serves as their own server is a deployment policy;
 * *when* it happens follows from the data: a participant becomes part of a room's
 * history with their join event, and that event is signed by the server in their
 * `sender`. Provisioning after the fact would leave the same person with two MXIDs in
 * one room, so this runs before their first membership event is written.
 */
export interface MatrixParticipantIdentityRequest {
  /** The participant about to enter the room. */
  webId: string;
  /** The Pod this write targets; their own Pod may differ when a shared room Pod is selected. */
  targetPodUrl?: string;
  context: MatrixStoreContext;
}

export interface MatrixParticipantIdentityProvider {
  /**
   * Make sure the participant has a signing identity this deployment may use, or return
   * without one when this deployment does not serve them (they stay on the deployment's
   * own server name). Throwing aborts the write: a join recorded under one identity and
   * later moved to another is worse than a refused join.
   */
  ensureParticipantIdentity(input: MatrixParticipantIdentityRequest): Promise<void>;
}

/**
 * Provisioning must not come later than the first time this deployment *names* the
 * participant. A Matrix user id is `@localpart:server`, and only the server half depends
 * on provisioning (the localpart is a hash of the WebID), so a participant named before
 * their key exists is named under the deployment's server — and an invite addressed to
 * that name would no longer match once they are provisioned. Provisioning therefore runs
 * before `getAccount` reports an MXID and before any event of theirs is written.
 *
 * Rooms recorded under an earlier name are history: their membership state keeps the
 * MXID it was written with. Serving those rooms again needs a per-room identity choice,
 * which is the legacy boundary rather than something provisioning can undo.
 */

/**
 * What changed in a Pod since the last indexing pass, when the deployment can tell.
 *
 * `sync` reads every room because a row written straight into the Pod has no journal sequence
 * until a read registers it, and a room's own watermark cannot say whether that happened. A
 * deployment that watches the Pod's resources (Solid notifications) *can* say, and then only
 * the rooms that changed have to be read. Absent means "cannot tell", and every room is read.
 */
export interface MatrixRoomChangeSource {
  /**
   * The rooms with a change to pick up. `trust: 'all'` means the source cannot account for
   * everything (not watching, just started, dropped) and every room has to be read.
   */
  pending(input: { scope: string }): Promise<{ trust: 'all' | 'changed'; rooms: readonly string[] }>;
  /**
   * The pass has read those rooms. A source keeps reporting a change until this is called, so
   * a change that arrives while a pass runs is not forgotten.
   */
  settle(input: { scope: string; rooms: readonly string[] }): Promise<void>;
}

/**
 * Where a locally written event goes so the other servers in the room learn about it.
 *
 * A port rather than the concrete queue: the store decides *what* the room's other servers
 * are, and the federation layer decides how a transaction reaches them. `MatrixOutbox`
 * satisfies this.
 */
export interface MatrixFederationOutbox {
  enqueue(input: { scope: string; origin: string; destination: string; pdus: readonly unknown[] }): Promise<unknown>;
}

export interface PodMatrixStoreOptions {
  podAccess?: PodAccessFetchProvider;
  journal?: MatrixEventJournal;
  serverName?: string;
  serverGroupReconcilerService?: ServerGroupReconcilerService;
  /**
   * Signing identities by server name; absent means stored events carry no signature.
   * Every event is signed by the identity of the server named in its `sender`.
   */
  identities?: MatrixSigningIdentitySource;
  /**
   * How many rooms keep a resolved state in memory. `0` disables the cache, which
   * trades repeat replays for memory; the default bounds it at 64 rooms.
   */
  stateCacheLimit?: number;
  /** Supplies a participant's own signing identity as they enter a room. */
  participantIdentity?: MatrixParticipantIdentityProvider;
  /** Queues a written event for the other servers in the room; absent means local only. */
  outbound?: MatrixFederationOutbox;
  /** Tells `sync` which rooms changed; absent means every room is read every pass. */
  roomChanges?: MatrixRoomChangeSource;
  /**
   * How often every room is read anyway, so a change the source missed is picked up. Defaults
   * to five minutes; `0` makes every pass a full one, i.e. the source is never trusted.
   */
  roomChangeFullPassMs?: number;
}

type Db = any;
type JsonObjectSource = string | Record<string, unknown> | null | undefined;

interface MatrixRoomSource {
  id: string;
  title?: string | null;
  description?: string | null;
  author?: string | null;
  participants?: string[] | null;
  createdAt?: string | Date | null;
  metadata?: JsonObjectSource;
}

interface MatrixEventSource {
  id: string;
  maker?: string | null;
  content?: JsonObjectSource;
  role?: string;
  mentions?: string[] | null;
  routeTargetAgent?: string | null;
  createdAt?: string | Date | null;
  metadata?: JsonObjectSource;
}

interface MatrixRoomContext {
  metadata?: Record<string, unknown>;
  participants: string[];
}

export interface MatrixAgentGrant {
  agent: string;
  executor: string;
  workspace: string;
  allowedActors: string[];
  handoffTo: string[];
}

/** Whether a sync result carries anything a client has to be told about. */
function hasSyncNews(result: MatrixSyncResponse): boolean {
  return Object.values(result.rooms.join).some(room => room.timeline.events.length)
    || Object.keys(result.rooms.invite ?? {}).length > 0;
}

/** How many rooms keep a replay to answer repeat reads and extend on append. */
const STATE_CACHE_LIMIT = 64;

/** A plain object, as JSON fields must be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class PodMatrixStore {
  private readonly podAccess?: PodAccessFetchProvider;
  private readonly journal: MatrixEventJournal;
  private readonly identities?: MatrixSigningIdentitySource;
  private readonly participantIdentity?: MatrixParticipantIdentityProvider;
  private readonly outbound?: MatrixFederationOutbox;
  private readonly roomChanges?: MatrixRoomChangeSource;
  private readonly roomChangeFullPassMs: number;
  /** The watermark the last pass indexed: a caller at or above it is caught up. */
  private readonly indexedAt = new Map<string, number>();
  private readonly lastFullPassAt = new Map<string, number>();
  private readonly stateCache = new Map<string, MatrixRoomStateReplay>();
  private readonly stateCacheLimit: number;
  private readonly logger = getLoggerFor(this);
  private readonly serverName?: string;
  private readonly serverGroupReconcilerService?: ServerGroupReconcilerService;

  public constructor(options: PodMatrixStoreOptions) {
    this.serverName = options.serverName;
    this.podAccess = options.podAccess;
    this.journal = options.journal ?? new InMemoryMatrixEventJournal();
    this.identities = options.identities;
    this.participantIdentity = options.participantIdentity;
    this.outbound = options.outbound;
    this.roomChanges = options.roomChanges;
    this.roomChangeFullPassMs = options.roomChangeFullPassMs ?? 5 * 60 * 1000;
    this.stateCacheLimit = options.stateCacheLimit ?? STATE_CACHE_LIMIT;
    if (!Number.isSafeInteger(this.stateCacheLimit) || this.stateCacheLimit < 0) {
      throw new MatrixError(500, 'M_UNKNOWN', 'stateCacheLimit must be a non-negative integer');
    }
    this.serverGroupReconcilerService = options.serverGroupReconcilerService;
  }

  public async getAccount(context: MatrixStoreContext): Promise<MatrixAccountInfo> {
    // The MXID reported here is the one others will invite, so it has to be final before
    // it is handed out — never the deployment-name fallback that provisioning would move.
    await this.ensureParticipantIdentity(context);
    const matrixUserId = this.getMatrixUserId(context);
    return {
      userId: matrixUserId,
      deviceId: this.deviceId(context),
      displayName: this.displayNameFromUserId(matrixUserId),
    };
  }

  public async createRoom(input: MatrixCreateRoomRequest, context: MatrixStoreContext): Promise<MatrixRoomRecord> {
    const db = await this.getDb(context);
    for (const state of input.initial_state ?? []) {
      if (['m.room.create', 'm.room.member', 'm.room.encryption'].includes(state.type)) {
        throw new MatrixError(400, 'M_BAD_JSON', 'Unsupported initial state event');
      }
      if (state.type === 'co.undefineds.agents') this.validateAgentGrants(state.content ?? {});
    }
    if (input.creation_content?.room_version && input.creation_content.room_version !== SUPPORTED_ROOM_VERSION) {
      throw new MatrixError(400, 'M_UNSUPPORTED_ROOM_VERSION', `Only room version ${SUPPORTED_ROOM_VERSION} is supported`);
    }
    // Absent `m.federate` means the room federates, as the create event defines it. A
    // room whose participants are on different servers (the distributed target) must
    // not opt out, so only an explicit `false` is written.
    const federate = input.creation_content?.['m.federate'] !== false;
    await this.ensureParticipantIdentity(context);
    const sender = this.getMatrixUserId(context);
    const now = Date.now();
    const roomId = this.generateRoomId(context);
    const chatId = this.chatResourceIdFromRoomId(roomId);
    const threadId = this.threadResourceIdFromRoomId(roomId);
    const reconcilerOwner = 'server' as const;
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);

    await db.insert(chatResource).values({
      id: chatId,
      title: input.name ?? roomId,
      description: input.topic ?? null,
      author: context.webId,
      status: 'active',
      participants: [context.webId],
      metadata: withProtocolMetadata({
        '@id': `${this.chatIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        ...coordination,
      }, 'matrix', {
        roomId,
        canonicalAlias: input.room_alias_name ? `#${input.room_alias_name}:${this.getServerName(context)}` : null,
        visibility: input.visibility === 'public' ? 'public' : 'private',
        roomVersion: String(input.creation_content?.room_version ?? SUPPORTED_ROOM_VERSION),
        federate,
        members: [context.webId],
        preset: input.preset,
        invite: input.invite ?? [],
      }),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await db.insert(threadResource).values({
      id: threadId,
      parent: this.chatIri(roomId, context),
      title: input.name ?? roomId,
      status: 'active',
      metadata: withProtocolMetadata({
        '@id': `${this.threadIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(roomId),
        ...coordination,
      }, 'matrix', { roomId }),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    // The setup events form the start of the room's event graph: each one is
    // appended against what this call has already appended, so building a room
    // costs one Pod read fewer per event instead of re-reading the room each time.
    const appended: MatrixEventRecord[] = [];
    const append = async (event: {
      type: string;
      originServerTs: number;
      stateKey?: string;
      content: Record<string, unknown>;
    }): Promise<void> => {
      appended.push(await this.appendEvent(db, { roomId, reconcilerOwner, sender, ...event }, context, appended));
    };

    await append({
      type: 'm.room.create',
      originServerTs: now,
      stateKey: '',
      content: {
        // Room version 11 removed `creator` from create events (MSC3820); the
        // sender is the creator, and clients read it from there.
        room_version: String(input.creation_content?.room_version ?? SUPPORTED_ROOM_VERSION),
        type: input.creation_content?.type,
        ...(federate ? {} : { 'm.federate': false }),
      },
    });
    await append({
      type: 'm.room.member',
      originServerTs: now + 1,
      stateKey: sender,
      content: {
        membership: 'join',
        displayname: this.displayNameFromUserId(sender),
      },
    });
    if (input.name) {
      await append({ type: 'm.room.name', originServerTs: now + 2, stateKey: '', content: { name: input.name } });
    }
    if (input.topic) {
      await append({ type: 'm.room.topic', originServerTs: now + 3, stateKey: '', content: { topic: input.topic } });
    }
    for (const state of input.initial_state ?? []) {
      await append({
        type: state.type,
        originServerTs: Date.now(),
        stateKey: state.state_key ?? '',
        content: state.content ?? {},
      });
    }
    for (const invitee of input.invite ?? []) {
      // Each invite follows the previous one: the list passed in is the graph as it
      // stands, and the result is added to it for the next append.
      appended.push(await this.appendMembershipEvent(db, roomId, invitee, 'invite', context,
        { sender, reconcilerOwner, observed: appended }));
    }

    return {
      roomId,
      canonicalAlias: input.room_alias_name ? `#${input.room_alias_name}:${this.getServerName(context)}` : undefined,
      name: input.name,
      topic: input.topic,
      creator: sender,
      reconcilerOwner: coordination.reconcilerOwner,
      createdAt: now,
    };
  }

  public async joinRoom(roomIdOrAlias: string, context: MatrixStoreContext): Promise<{ roomId: string }> {
    const db = await this.getDb(context);
    const roomId = await this.resolveRoomId(db, roomIdOrAlias);
    const room = await this.roomSource(db, roomId, context);
    const before = this.getMatrixUserId(context);
    let existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', before, context);
    if (existing?.content.membership === 'join') return { roomId };

    // Entering the room is what makes the participant part of its history, so their own
    // signing identity has to exist before the join event names them — and provisioning
    // can *change* the MXID they are known by, so membership is looked up again under the
    // identity the event will actually carry.
    await this.ensureParticipantIdentity(context);
    const sender = this.getMatrixUserId(context);
    const banned = existing?.content.membership === 'ban';
    if (sender !== before) existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', sender, context);
    if (existing?.content.membership === 'join') return { roomId };
    if (existing?.content.membership !== 'invite' && room.author !== context.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'An invitation is required');
    }
    // A ban under either identity still blocks: provisioning must not be a way around one.
    if (banned || existing?.content.membership === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Banned from room');
    await this.appendMembershipEvent(db, roomId, sender, 'join', context);
    return { roomId };
  }

  public async inviteUser(roomId: string, userId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    await this.requireRoomOwner(db, roomId, context);
    if (!/^@[^:]+:.+$/u.test(userId)) throw new MatrixError(400, 'M_BAD_JSON', 'Invalid Matrix user id');
    await this.appendMembershipEvent(db, roomId, userId, 'invite', context);
  }

  public async leaveRoom(roomId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    await this.appendMembershipEvent(db, roomId, this.getMatrixUserId(context), 'leave', context);
  }

  public async sendEvent(roomId: string, eventType: string, txnId: string, content: MatrixSendEventRequest,
    context: MatrixStoreContext): Promise<MatrixEventRecord> {
    const db = await this.getDb(context);
    // Membership and grant checks share one timeline read; each extra read is a
    // full Pod document fetch with its own authorization cost.
    const events = await this.listEvents(db, roomId, context);
    await this.requireJoined(db, roomId, context, events);
    if (eventType !== 'm.room.message') throw new MatrixError(400, 'M_UNRECOGNIZED', 'Only m.room.message timeline events are supported');
    await this.authorizeTargets(db, roomId, content, context, events);
    const sender = this.getMatrixUserId(context);
    const contentHash = this.hash(this.canonicalJson(['user',context.webId,eventType,content]));
    // The graph position is part of the event, so it is fixed before the id is
    // reserved — including on a replay, which therefore has to attach to the same
    // place as the first attempt rather than to whatever the room looks like now.
    const eventInput = {
      roomId, type: eventType, sender, content,
      ...this.graphPosition(events, { type: eventType, sender, content }),
    };
    const transactionKey = JSON.stringify([this.deviceId(context), roomId, eventType, txnId]);
    const { reservation, proposal } = await this.reserveEventTransaction(context, transactionKey, eventInput, contentHash);
    if (reservation.contentHash !== contentHash) {
      throw new MatrixError(409, 'M_CONFLICT', 'Transaction already reserved with different content');
    }
    // A retry whose first attempt completed is answered from the Pod: the event is
    // already there, so nothing is rebuilt, re-signed or written again.
    const source = await db.findById(messageResource,this.messageResourceIdFromEvent(roomId,reservation.eventId,reservation.createdAt));
    if (source) {
      const existing = this.eventSourceToRecord(source,roomId,context);
      if (reservation.contentHash !== this.hash(this.canonicalJson(['user',existing.senderWebId,existing.type,existing.content]))) {
        throw new MatrixError(409,'M_CONFLICT','Stored event no longer matches its receipt');
      }
      existing.depth = await this.journal.registerEvent(this.scope(context),roomId,existing.eventId);
      await this.reconcileEvent(db, existing, context);
      return existing;
    }
    const active = await this.reservationInForce(context, transactionKey, reservation, proposal, eventInput, contentHash);
    return this.appendEvent(db, { roomId, type: eventType, sender, txnId,
      eventId: active.reservation.eventId, originServerTs: active.reservation.createdAt, content, event: active.event },
    context, events);
  }

  /**
   * Reserve a transaction for an event that does not exist yet.
   *
   * The event id is derived from the event, so an id can only be reserved by
   * building the event first. The proposal therefore supplies the id and the
   * timestamp; a retry at the same key must adopt the reservation rather than its
   * own proposal, which is what `eventForReservation` does. The proposal is
   * returned for the one caller that may legitimately replace a reservation.
   */
  /**
   * The identity that signs for this caller's server, or `undefined` when events are
   * written unsigned. A registry in use answers only for the server names it holds
   * keys for, so asking for another name fails instead of mis-attributing the event.
   */
  private async signingIdentity(context: MatrixStoreContext): Promise<MatrixServiceIdentity | undefined> {
    if (!this.identities) return undefined;
    return this.identities.identityFor(this.getServerName(context));
  }

  private async reserveEventTransaction(
    context: MatrixStoreContext,
    key: string,
    input: Omit<PersistedEventInput, 'originServerTs' | 'eventId'>,
    contentHash: string,
  ): Promise<{ reservation: MatrixTransactionReservation; proposal: PersistedMatrixEvent }> {
    const identity = await this.signingIdentity(context);
    const proposal = buildPersistedEvent({ ...input, originServerTs: Date.now() }, identity);
    const reservation = await this.journal.reserveTransaction(this.scope(context), key, {
      eventId: proposal.event_id!, createdAt: proposal.origin_server_ts as number, contentHash,
    });
    return { reservation, proposal };
  }

  /**
   * The reservation in force for this attempt, and the event it pins.
   *
   * Normally the reservation wins: a retry must land on the event the first attempt
   * reserved, so the event is rebuilt from the reservation's timestamp and id. The
   * room moves on, though, and `prev_events`/`auth_events`/`depth` are part of the
   * event: a reservation taken before other events landed pins an id that this
   * content can no longer derive. When that happens the proposal — built against
   * the room as it is now — takes the reservation over. That is only sound because
   * every caller checks first that the reserved event is not in the Pod, so no
   * event is orphaned; a concurrent attempt that lands afterwards becomes a branch
   * in the graph, which the still-open "unknown outcome" contract has to resolve.
   */
  private async reservationInForce(
    context: MatrixStoreContext,
    key: string,
    reservation: MatrixTransactionReservation,
    proposal: PersistedMatrixEvent,
    input: Omit<PersistedEventInput, 'originServerTs' | 'eventId'>,
    contentHash: string,
  ): Promise<{ reservation: MatrixTransactionReservation; event: PersistedMatrixEvent }> {
    try {
      return { reservation, event: await this.eventForReservation(input, reservation, context) };
    } catch (error) {
      if (!(error instanceof EventIntegrityError)) throw error;
      const replacement = {
        eventId: proposal.event_id!, createdAt: proposal.origin_server_ts as number, contentHash,
      };
      const event = await this.eventForReservation(input, replacement, context);
      await this.journal.replaceReservation(this.scope(context), key, replacement);
      return { reservation: replacement, event };
    }
  }

  /**
   * Build the event a reservation pins.
   *
   * The reservation owns the timestamp: a retry that reserved a moment later must
   * still land on the event the first attempt reserved, so the event is rebuilt
   * from the reservation instead of from the clock. `buildPersistedEvent` asserts
   * the id, so a reservation naming an id that this content and time do not
   * derive fails loudly rather than writing a second id for one transaction.
   */
  private async eventForReservation(
    input: Omit<PersistedEventInput, 'originServerTs' | 'eventId'>,
    reservation: MatrixTransactionReservation,
    context: MatrixStoreContext,
  ): Promise<PersistedMatrixEvent> {
    return buildPersistedEvent({
      ...input,
      originServerTs: reservation.createdAt,
      eventId: reservation.eventId,
    }, await this.signingIdentity(context));
  }

  public async setState(roomId: string, eventType: string, stateKey: string, content: Record<string, unknown>,
    context: MatrixStoreContext): Promise<MatrixEventRecord> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    await this.requireRoomOwner(db, roomId, context);
    if (['m.room.create', 'm.room.member', 'm.room.encryption'].includes(eventType)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'Use membership operations; immutable/encrypted state is unsupported');
    }
    if (eventType === 'co.undefineds.agents') this.validateAgentGrants(content);
    return this.appendEvent(db, {roomId, type: eventType, sender: this.getMatrixUserId(context), stateKey,
      originServerTs: Date.now(), content}, context);
  }

  public async sync(context: MatrixStoreContext, options: { since?: string; limit?: number; timeout?: number; signal?: AbortSignal } = {}): Promise<MatrixSyncResponse> {
    const deadline = Date.now() + Math.min(Math.max(options.timeout ?? 0, 0), 30_000);
    const scope = this.scope(context);
    const read = new Set<string>();
    const since = this.parseSyncToken(options.since);
    const decide = async (): Promise<readonly string[] | undefined> => {
      if (!this.roomChanges) return undefined;
      // A change source speaks for changes since the last pass, which only helps a caller that
      // already has what that pass indexed. A caller that is behind needs its rooms' events.
      const indexed = this.indexedAt.get(scope);
      if (indexed === undefined || since < indexed) {
        // The caller is behind (or has never synced), so every room is read.
        this.lastFullPassAt.set(scope, Date.now());
        return undefined;
      }
      // The safety net: a source can miss a change (a dropped socket, a restart), so every
      // room is read again eventually whatever the source says. A source that has never been
      // trusted yet starts its clock with this pass.
      const lastFull = this.lastFullPassAt.get(scope);
      if (lastFull === undefined) {
        this.lastFullPassAt.set(scope, Date.now());
        return undefined;
      }
      if (Date.now() - lastFull >= this.roomChangeFullPassMs) {
        this.lastFullPassAt.set(scope, Date.now());
        return undefined;
      }
      const pending = await this.roomChanges.pending({ scope });
      // A source that cannot account for everything sends the pass back to reading every room.
      if (pending.trust === 'all') return undefined;
      for (const roomId of pending.rooms) read.add(roomId);
      return pending.rooms;
    };

    // The first pass is what indexes rows written straight into the Pod: a native write has
    // no journal sequence until a read registers it, and the snapshot taken *before* that
    // read cannot include the sequences it just assigned — which is why this pass always
    // reads and its result is deliberately discarded. A change source can say which rooms
    // that could concern, and then only those are read.
    let rooms = await decide();
    await this.syncOnce(context, options, { rooms });
    let result = await this.syncOnce(context, options, { rooms });
    while (!hasSyncNews(result) && !options.signal?.aborted && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
        options.signal?.addEventListener('abort', done, { once: true });
      });
      // Ask again: a change that arrived while we waited is the news the caller is waiting for.
      rooms = await decide();
      // Everything the Pod holds has been indexed above, so an unchanged scope watermark
      // means no room can have anything new and the per-room reads can be skipped.
      result = await this.syncOnce(context, options, { indexed: true, rooms });
    }
    // Only now are the rooms we read allowed to leave the source: a change that arrived
    // during this call has to survive for the next one.
    await this.roomChanges?.settle({ scope, rooms: [ ...read ] });
    return result;
  }

  private async syncOnce(
    context: MatrixStoreContext,
    options: { since?: string; limit?: number },
    state: { indexed?: boolean; rooms?: readonly string[] } = {},
  ): Promise<MatrixSyncResponse> {
    const db = await this.getDb(context);
    const since = this.parseSyncToken(options.since);
    const snapshot = await this.journal.getHighWatermark(this.scope(context));
    // `state.rooms` is the caller's decision, already made against what the last pass indexed:
    // an empty list means nothing changed anywhere, and a list means only those rooms can hold
    // anything the caller does not have.
    const restricted = state.rooms;
    if (restricted && restricted.length === 0) {
      // Nothing changed anywhere, so no room needs reading at all.
      return { next_batch: this.encodeSyncToken(since), rooms: { join: {}, invite: {}, leave: {} } };
    }
    // Every event that could be reported has a sequence at or below the watermark, and
    // everything above `since` has already been read and indexed by an earlier pass.
    if (state.indexed && since >= snapshot) {
      return { next_batch: this.encodeSyncToken(since), rooms: { join: {}, invite: {}, leave: {} } };
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
    const join: MatrixSyncResponse['rooms']['join'] = {};
    const invite: NonNullable<MatrixSyncResponse['rooms']['invite']> = {};
    const leave: NonNullable<MatrixSyncResponse['rooms']['leave']> = {};
    const batches: Array<{room: MatrixRoomRecord; events: MatrixEventRecord[]}> = [];
    const roomsToRead = restricted === undefined
      ? await this.listRooms(db)
      : (await this.listRooms(db)).filter(room => restricted.includes(room.roomId));
    for (const room of roomsToRead) {
      const events = (await this.listEvents(db, room.roomId, context)).filter(e=>e.depth! <= snapshot);
      const membership = this.resolvedState(room.roomId, context, events).get('m.room.member', this.getMatrixUserId(context));
      if (membership?.content.membership === 'invite') {
        if ((membership.depth ?? 0) > since) invite[room.roomId] = { invite_state: { events: [this.toClientEvent(membership)] } };
        continue;
      }
      if (membership?.content.membership === 'leave' || membership?.content.membership === 'ban') {
        if ((membership.depth ?? 0) > since) leave[room.roomId] = {timeline: {events: [this.toClientEvent(membership)], limited: false}};
        continue;
      }
      if (membership?.content.membership !== 'join' && room.creator !== context.webId) continue;
      batches.push({room, events});
    }
    const candidates = batches.flatMap(b => b.events).filter(e => (e.depth ?? 0) > since)
      .sort((a,b) => (a.depth ?? 0) - (b.depth ?? 0));
    const selected = candidates.slice(0, limit);
    const ids = new Set(selected.map(e => e.eventId));
    for (const {room, events} of batches) {
      const page = events.filter(e => ids.has(e.eventId));
      const firstSequence = page[0]?.depth ?? since;
      // State at the start of this timeline; events in the timeline apply after it.
      // Resolving the prefix rather than taking the last event per slot matters when
      // the history before the page contains a fork.
      // The page-start state is a different event list, so it is memoized under its own
      // key rather than displacing the room's current state.
      const state = this.resolvedState(`${room.roomId}@${firstSequence}`, context,
        events.filter(event => (event.depth ?? 0) < firstSequence));
      join[room.roomId] = {state: {events: state.events().map(e=>this.toClientEvent(e))},
        timeline: {events: page.map(e=>this.toClientEvent(e)), limited: candidates.length > selected.length,
          ...(page.length ? {prev_batch: this.encodeSyncToken((page[0].depth ?? 1) - 1)} : {})},
        'co.undefineds.coordination': {reconcilerOwner: room.reconcilerOwner}};
    }
    // The pass has indexed everything the Pod held at this watermark, so a caller at or above
    // it is caught up and the change source can be trusted for the next one.
    this.indexedAt.set(this.scope(context), snapshot);
    const transitionPositions = [...Object.values(invite).flatMap(r=>r.invite_state.events), ...Object.values(leave).flatMap(r=>r.timeline.events)];
    // When a joined timeline has backlog, do not advance past its last delivered event.
    const next = selected.length ? selected[selected.length-1].depth! : since;
    const high = candidates.length === 0 && transitionPositions.length ? snapshot : next;
    return {next_batch: this.encodeSyncToken(high), rooms: {join, invite, leave}};
  }

  public async listJoinedRooms(context: MatrixStoreContext): Promise<string[]> {
    const db = await this.getDb(context);
    return (await this.listJoinedRoomRecords(db, context)).map((room) => room.roomId);
  }

  public async getMembers(roomId: string, context: MatrixStoreContext): Promise<MatrixClientEvent[]> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const state = await this.currentState(roomId, context);
    return state.events()
      .filter(event => event.type === 'm.room.member' && event.stateKey !== undefined)
      .sort((left, right) => (left.originServerTs - right.originServerTs) || ((left.depth ?? 0) - (right.depth ?? 0)))
      .map((event) => this.toClientEvent(event));
  }

  public async listMessages(roomId: string, context: MatrixStoreContext,
    options: { limit?: number; dir?: 'b' | 'f'; from?: string } = {}): Promise<{chunk: MatrixClientEvent[];start?:string;end:string}> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const snapshot = await this.journal.getHighWatermark(this.scope(context));
    const all = (await this.listEvents(db, roomId, context)).filter(e=>e.depth! <= snapshot);
    const forward = options.dir === 'f';
    const from = options.from ? this.parseSyncToken(options.from) : (forward ? 0 : Number.MAX_SAFE_INTEGER);
    const events = all.filter(e=>forward ? e.depth! > from : e.depth! <= from);
    if (!forward) events.reverse();
    const page = events.slice(0,Math.min(Math.max(options.limit ?? 50,1),1000));
    const boundary = page.length ? page[page.length-1].depth! - (forward ? 0 : 1) : (forward ? from : 0);
    return {chunk:page.map(e=>this.toClientEvent(e)),start:options.from,end:this.encodeSyncToken(boundary)};
  }

  public async getEvent(roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixClientEvent> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const event = await this.findEventById(db, roomId, eventId, context);
    if (!event) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'Event not found');
    }
    return this.toClientEvent(event);
  }

  public async getState(
    roomId: string,
    eventType: string,
    stateKey: string,
    context: MatrixStoreContext,
  ): Promise<Record<string, unknown>> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    // Resolved state, so a fork cannot make a stale or banned state event the answer.
    const event = (await this.currentState(roomId, context)).get(eventType, stateKey);
    if (!event) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'State not found');
    }
    return event.content;
  }

  /**
   * The queue the runtime and this store's reconciler already share. Exposed so
   * the API container does not have to resolve the same collaborator twice.
   */
  public getQueue(): WakeAgentQueue | undefined {
    return this.serverGroupReconcilerService?.getQueue();
  }

  /**
   * The queue written events are handed to, for whoever drives delivery (a notification, a
   * worker, an operator). Absent when this deployment does not federate.
   */
  public getOutbox(): MatrixFederationOutbox | undefined {
    return this.outbound;
  }

  private async getDb(context: MatrixStoreContext): Promise<Db> {
    if ((context as any)._matrixDb) {
      return (context as any)._matrixDb;
    }

    const auth = context.auth as AuthContext | undefined;
    if (!auth || !isSolidAuth(auth) || !auth.webId) {
      throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'Solid authentication is required');
    }

    const podFetch = this.podAccess
      ? await this.podAccess.getPodFetch(context.webId, {auth, podBaseUrl: context.podUrl})
      : undefined;
    if (!podFetch) throw new MatrixError(403, 'M_FORBIDDEN', 'Grant Pod interface access before using Matrix');
    const db: Db = drizzle(
      {
        fetch: podFetch,
        info: {
          webId: auth.webId,
          isLoggedIn: true,
          podUrl: context.podUrl,
        },
      } as any,
      {
        schema,
        podUrl: context.podUrl,
      },
    );
    await db.init(
      chatResource,
      threadResource,
      runResource,
      runStepResource,
      deliveryResource,
      messageResource,
    );
    (context as any)._matrixDb = db;
    return db;
  }

  /**
   * Where the new event attaches: its parents, the events that authorise it, and
   * its depth. Read from the events the caller already has, so appending costs no
   * extra Pod read on the send path.
   */
  private graphPosition(
    events: readonly MatrixEventRecord[],
    input: { type: string; sender: string; stateKey?: string; content: Record<string, unknown> },
  ): { prevEvents: string[]; authEvents: string[]; depth: number } {
    return roomGraphPosition(events.map(storedGraphEvent), input);
  }

  private async appendEvent(
    db: Db,
    input: {
      roomId: string;
      type: string;
      sender: string;
      originServerTs: number;
      content: Record<string, unknown>;
      stateKey?: string;
      txnId?: string;
      reconcilerOwner?: ReconcilerOwner;
      eventId?: string;
      role?: string;
      maker?: string;
      /** Already-built protocol event, so a caller that reserved an id can reuse it. */
      event?: PersistedMatrixEvent;
    },
    context: MatrixStoreContext,
    /** Events already read from this room; loaded here when the caller has none. */
    observed?: readonly MatrixEventRecord[],
  ): Promise<MatrixEventRecord> {
    const depth = 0;
    // One read answers the graph position and, when federation is on, who the room's other
    // servers are; both need the same timeline and neither may see a stale one.
    const timeline = observed ?? await this.listEvents(db, input.roomId, context);
    // The protocol event is built first: its content-derived id is the event's
    // identity, and the stored copy carries the hashes and signature that make
    // the event verifiable from the Pod alone.
    const persistedEvent = input.event ?? buildPersistedEvent({
      roomId: input.roomId,
      type: input.type,
      sender: input.sender,
      originServerTs: input.originServerTs,
      content: input.content,
      ...(input.stateKey === undefined ? {} : { stateKey: input.stateKey }),
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...this.graphPosition(timeline, input),
    }, await this.signingIdentity(context));
    const eventId = persistedEvent.event_id ?? this.generateEventId(context);
    const originIso = new Date(input.originServerTs).toISOString();
    const needsRoomMetadata = input.reconcilerOwner === undefined
      || (input.type === 'm.room.message' && this.serverGroupReconcilerService !== undefined);
    const roomContext = needsRoomMetadata ? await this.getRoomContext(db, input.roomId, context) : undefined;
    const roomMetadata = roomContext?.metadata;
    const reconcilerOwner = input.reconcilerOwner ?? this.reconcilerOwnerFromRoomMetadata(roomMetadata);
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);
    const messageResourceId = this.messageResourceIdFromEvent(input.roomId, eventId, input.originServerTs);
    const thread = this.threadIri(input.roomId, context);
    const contentText = this.messageContentFromMatrixEvent(input.type, input.content);
    const mentions = this.mentionsFromMatrixContent(input.content);
    const routeTargetAgent = this.routeTargetAgentFromMatrixContent(input.content);
    const record = {
      eventId,
      roomId: input.roomId,
      type: input.type,
      sender: input.sender,
      senderWebId: input.maker ?? context.webId,
      originServerTs: input.originServerTs,
      depth,
      role: input.role ?? (input.type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM),
      resourceId: messageResourceId,
      txnId: input.txnId ?? undefined,
      stateKey: input.stateKey ?? undefined,
      content: input.content,
      createdAt: originIso,
      event: persistedEvent as unknown as Record<string, unknown>,
    };
    await db.insert(messageResource).values({
      id: messageResourceId,
      parent: this.chatIri(input.roomId, context),
      chat: this.chatIri(input.roomId, context),
      thread,
      maker: input.maker ?? context.webId,
      role: input.role ?? (input.type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM),
      content: contentText,
      status: MessageStatus.SENT,
      mentions,
      routeTargetAgent: routeTargetAgent ?? null,
      replyTo: typeof input.content['co.undefineds.replyTo'] === 'string' ? input.content['co.undefineds.replyTo'] : null,
      metadata: withProtocolMetadata({
        '@id': `${messageResource.buildIri(this.scope(context),{id:messageResourceId})}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(input.roomId),
        ...coordination,
      }, 'matrix', {
        // Verifiable protocol fact: hashes and signatures live in here.
        event: persistedEvent as unknown as ProtocolMetadata,
        // Application bookkeeping that is deliberately not part of the event:
        // putting it inside would change the canonical form and the event id.
        senderWebId: input.maker ?? context.webId,
        txnId: input.txnId ?? null,
      }),
      createdAt: originIso,
      updatedAt: originIso,
    });

    record.depth = await this.journal.registerEvent(this.scope(context), input.roomId, eventId);
    if (record.role === MessageRole.USER) await this.reconcileEvent(db, record, context);
    await this.queueFederationDelivery(input.roomId, context, timeline, persistedEvent);

    return record;
  }

  /**
   * Make a room this Pod has only heard about visible in it.
   *
   * A received event for an unknown room arrives with no chat record, and without one the
   * room is invisible: `listRooms` does not report it, so a client never sees the invite
   * that would let its user join, and joining fails because the room cannot be read. The
   * record is therefore created from the event, not from a local decision to open a room:
   * the room id is the remote one and the author is the create event's sender, never the
   * local Pod owner — a received event must not make the owner look like the room's
   * creator, which would read as "already a member".
   *
   * Idempotent: an existing record is left exactly as it is.
   */
  private async materializeReceivedRoom(db: Db, roomId: string, context: MatrixStoreContext): Promise<void> {
    const chatId = this.chatResourceIdFromRoomId(roomId);
    if (await db.findById(chatResource, chatId)) return;
    const timeline = await this.listEvents(db, roomId, context);
    const create = timeline.find(record => record.type === 'm.room.create');
    const nowIso = new Date().toISOString();
    const coordination = reconcilerCoordinationMetadata('server');
    await db.insert(chatResource).values({
      id: chatId,
      title: roomId,
      description: null,
      // The remote creator's MXID, not the local owner: see above.
      author: create?.sender ?? null,
      status: 'active',
      participants: [],
      metadata: withProtocolMetadata({
        '@id': `${this.chatIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        ...coordination,
      }, 'matrix', {
        roomId,
        roomVersion: String((create?.content?.room_version as string | undefined) ?? SUPPORTED_ROOM_VERSION),
        federate: create?.content?.['m.federate'] !== false,
        members: [],
      }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await db.insert(threadResource).values({
      id: this.threadResourceIdFromRoomId(roomId),
      parent: this.chatIri(roomId, context),
      title: roomId,
      status: 'active',
      metadata: withProtocolMetadata({
        '@id': `${this.threadIri(roomId, context)}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(roomId),
        ...coordination,
      }, 'matrix', { roomId }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  /**
   * Store an event received from another server exactly as it arrived.
   *
   * Deliberately not the writer above: an event we author is built and signed here,
   * while a received one already carries its own derived id, hashes and signatures —
   * rebuilding or re-signing it would destroy the material a verifier checks, and
   * adding our signature would claim authorship we do not have. The Pod keeps the
   * received event verbatim under `metadata.protocols.matrix.event`, with `received`
   * marking it so the row's owner is not mistaken for its author.
   *
   * Idempotent by event id: accepting the same event again returns the stored record
   * without a second write, which is what a peer's transaction replay needs.
   */
  public async acceptReceivedEvent(input: {
    event: Record<string, unknown>;
    context: MatrixStoreContext;
  }): Promise<MatrixEventRecord> {
    const db = await this.getDb(input.context);
    const event = input.event;
    const roomId = String(event.room_id ?? '');
    const type = String(event.type ?? '');
    const sender = String(event.sender ?? '');
    const originServerTs = Number(event.origin_server_ts ?? Number.NaN);
    const content = isRecord(event.content) ? event.content : {};
    if (!roomId || !type || !sender || !Number.isSafeInteger(originServerTs)) {
      throw new MatrixError(400, 'M_BAD_JSON', 'A received event needs room_id, type, sender and origin_server_ts');
    }
    const eventId = computeEventId(event);
    // The identity is derived here, not sent; attaching it is what every reader agrees
    // on, and it is safe because neither the content hash, the reference hash nor the
    // signature covers `event_id`.
    const storedEvent: Record<string, unknown> = { ...event, event_id: eventId };
    const messageResourceId = this.messageResourceIdFromEvent(roomId, eventId, originServerTs);
    const existing = await db.findById(messageResource, messageResourceId);
    if (existing) return this.eventSourceToRecord(existing, roomId, input.context);
    await this.materializeReceivedRoom(db, roomId, input.context);

    const originIso = new Date(originServerTs).toISOString();
    const role = type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM;
    const coordination = reconcilerCoordinationMetadata(
      this.reconcilerOwnerFromRoomMetadata((await this.getRoomContext(db, roomId, input.context))?.metadata));
    await db.insert(messageResource).values({
      id: messageResourceId,
      parent: this.chatIri(roomId, input.context),
      chat: this.chatIri(roomId, input.context),
      thread: this.threadIri(roomId, input.context),
      maker: input.context.webId,
      role,
      content: this.messageContentFromMatrixEvent(type, content),
      status: MessageStatus.SENT,
      mentions: this.mentionsFromMatrixContent(content),
      routeTargetAgent: this.routeTargetAgentFromMatrixContent(content) ?? null,
      replyTo: typeof content['co.undefineds.replyTo'] === 'string' ? content['co.undefineds.replyTo'] : null,
      metadata: withProtocolMetadata({
        '@id': `${messageResource.buildIri(this.scope(input.context),{id:messageResourceId})}/metadata`,
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(roomId),
        ...coordination,
      }, 'matrix', {
        // The event as received: its own hashes and signatures, nothing re-signed, with
        // the id this server derived attached.
        event: storedEvent as unknown as ProtocolMetadata,
        // This row's owner is not the author; the author is the event's `sender`.
        received: true,
      }),
      createdAt: originIso,
      updatedAt: originIso,
    });

    const record: MatrixEventRecord = {
      eventId,
      roomId,
      type,
      sender,
      originServerTs,
      role,
      resourceId: messageResourceId,
      content,
      event: storedEvent,
      ...(typeof storedEvent.state_key === 'string' ? { stateKey: storedEvent.state_key } : {}),
    };
    record.depth = await this.journal.registerEvent(this.scope(input.context), roomId, eventId);
    return record;
  }

  private async appendMembershipEvent(
    db: Db,
    roomId: string,
    memberUserId: string,
    membership: 'invite' | 'join' | 'leave' | 'ban',
    context: MatrixStoreContext,
    options: { sender?: string; reconcilerOwner?: ReconcilerOwner; observed?: readonly MatrixEventRecord[] } = {},
  ): Promise<MatrixEventRecord> {
    const sender = options.sender ?? this.getMatrixUserId(context);
    return this.appendEvent(db, {
      roomId,
      reconcilerOwner: options.reconcilerOwner,
      type: 'm.room.member',
      sender,
      originServerTs: Date.now(),
      stateKey: memberUserId,
      content: {
        membership,
        displayname: this.displayNameFromUserId(memberUserId),
      },
    }, context, options.observed);
  }

  private async listRooms(db: Db): Promise<MatrixRoomRecord[]> {
    const rooms = await db.select().from(chatResource) as MatrixRoomSource[];
    return rooms
      .map((room) => this.chatSourceToRoomRecord(room))
      .filter((room): room is MatrixRoomRecord => room !== undefined);
  }

  private async listJoinedRoomRecords(db: Db, context: MatrixStoreContext): Promise<MatrixRoomRecord[]> {
    const rooms = await this.listRooms(db);
    const matrixUserId = this.getMatrixUserId(context);
    const joined: MatrixRoomRecord[] = [];
    for (const room of rooms) {
      const membership = await this.findLatestStateEvent(db, room.roomId, 'm.room.member', matrixUserId, context);
      if (membership?.content.membership === 'join' || (!membership && room.creator === context.webId)) {
        joined.push(room);
      }
    }
    return joined;
  }

  private async resolveRoomId(db: Db, roomIdOrAlias: string): Promise<string> {
    if (!roomIdOrAlias.startsWith('#')) {
      return roomIdOrAlias;
    }
    const rooms = await this.listRooms(db);
    const room = rooms.find((candidate) => candidate.canonicalAlias === roomIdOrAlias);
    if (!room) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'Room alias not found');
    }
    return room.roomId;
  }

  private async listEvents(
    db: Db,
    roomId: string,
    context: MatrixStoreContext,
    options: { newestFirst?: boolean } = {},
  ): Promise<MatrixEventRecord[]> {
    const sources = await db.select().from(messageResource)
      .where(eq(messageResource.thread, this.threadIri(roomId, context))) as MatrixEventSource[];
    sources.sort((a,b) => (this.isoToMillis(a.createdAt) ?? 0) - (this.isoToMillis(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
    // One journal round trip per page instead of one per event: the per-event
    // form made every read cost O(history) SQL calls.
    const records = sources.map(source => this.eventSourceToRecord(source, roomId, context));
    const sequences = await this.journal.registerEvents(this.scope(context), roomId, records.map(record => record.eventId));
    records.forEach((record, index) => { record.depth = sequences[index]; });
    const events = records;
    events.sort((a,b)=>a.depth! - b.depth!);
    return options.newestFirst ? events.reverse() : events;
  }

  private async findEventById(db: Db, roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixEventRecord | undefined> {
    const records = await this.listEvents(db, roomId, context);
    return records.find((record) => record.eventId === eventId);
  }

  private async findLatestStateEvent(
    db: Db,
    roomId: string,
    eventType: string,
    stateKey: string,
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord | undefined> {
    const records = await this.listEvents(db, roomId, context, { newestFirst: true });
    return records.find((record) => record.type === eventType && (record.stateKey ?? '') === stateKey);
  }

  private eventSourceToRecord(source: MatrixEventSource, roomId: string, context: MatrixStoreContext): MatrixEventRecord {
    const metadata = this.parseJsonObject(source.metadata) ?? {};
    const matrix = getProtocolMetadata(metadata, 'matrix') ?? {};
    const stored = readPersistedEvent(matrix);
    const content = this.parseJsonObject(stored?.content as JsonObjectSource)
      ?? this.parseJsonObject(matrix.content as JsonObjectSource)
      ?? this.parseJsonObject(metadata.content as JsonObjectSource)
      ?? {msgtype: 'm.text', body: typeof source.content === 'string' ? source.content : JSON.stringify(source.content ?? '')};
    const unsigned = this.parseJsonObject(stored?.unsigned as JsonObjectSource)
      ?? this.parseJsonObject(matrix.unsigned as JsonObjectSource)
      ?? this.parseJsonObject(metadata.unsigned as JsonObjectSource);
    const stateKey = this.stringValue(stored?.state_key ?? matrix.stateKey ?? matrix.state_key ?? metadata.stateKey);
    const txnId = this.stringValue(matrix.txnId ?? matrix.txn_id ?? metadata.txnId);
    return {
      eventId: this.stringValue(stored?.event_id ?? matrix.eventId ?? matrix.event_id ?? metadata.eventId) ?? `$${this.hash(source.id)}:${this.getServerName(context)}`,
      roomId: this.stringValue(stored?.room_id ?? matrix.roomId ?? matrix.room_id ?? metadata.roomId) ?? roomId,
      type: this.stringValue(stored?.type ?? matrix.eventType ?? matrix.event_type ?? metadata.eventType) ?? 'm.room.message',
      sender: this.stringValue(stored?.sender ?? matrix.sender ?? metadata.sender) ?? this.getMatrixUserId({...context, webId: source.maker ?? context.webId}),
      // A received event's row is owned by this Pod's user, not by its author: the
      // remote author's WebID is not derivable from their MXID, so it stays unknown
      // until the sender's own binding can be consulted.
      senderWebId: this.stringValue(matrix.senderWebId ?? matrix.sender_web_id ?? metadata.senderWebId)
        ?? (matrix.received === true ? undefined : source.maker ?? undefined),
      originServerTs: this.numberValue(stored?.origin_server_ts ?? matrix.originServerTs ?? matrix.origin_server_ts ?? metadata.originServerTs) ?? this.isoToMillis(source.createdAt) ?? Date.now(),
      depth: this.numberValue(stored?.depth ?? matrix.depth ?? metadata.depth),
      role: source.role,
      resourceId: source.id,
      txnId: txnId ?? undefined,
      content,
      stateKey: stateKey ?? undefined,
      unsigned,
      ...(stored === undefined ? {} : { event: stored as unknown as Record<string, unknown> }),
    };
  }

  private chatSourceToRoomRecord(source: MatrixRoomSource): MatrixRoomRecord | undefined {
    const metadata = this.parseJsonObject(source.metadata) ?? {};
    if (metadata.protocol !== 'matrix') {
      return undefined;
    }
    const matrix = getProtocolMetadata(metadata, 'matrix') ?? {};
    const roomId = this.stringValue(matrix.roomId ?? matrix.room_id ?? metadata.roomId);
    if (!roomId) {
      return undefined;
    }
    const reconcilerOwner = normalizeReconcilerOwner(metadata.reconcilerOwner, 'server');
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);
    return {
      roomId,
      canonicalAlias: this.stringValue(matrix.canonicalAlias ?? matrix.canonical_alias ?? metadata.canonicalAlias),
      name: source.title ?? undefined,
      topic: source.description ?? undefined,
      creator: source.author ?? '',
      reconcilerOwner: coordination.reconcilerOwner,
      createdAt: this.isoToMillis(source.createdAt) ?? 0,
    };
  }

  private toClientEvent(event: MatrixEventRecord): MatrixClientEvent {
    return {
      event_id: event.eventId,
      room_id: event.roomId,
      type: event.type,
      sender: event.sender,
      origin_server_ts: event.originServerTs,
      content: event.content,
      ...(event.stateKey !== undefined ? { state_key: event.stateKey } : {}),
      ...(event.unsigned ? { unsigned: event.unsigned } : {}),
    };
  }

  private scope(context: MatrixStoreContext): string {
    if (!context.podUrl) throw new MatrixError(400, 'M_BAD_JSON', 'A resolved Pod URL is required');
    return context.podUrl;
  }

  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item=>this.canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${this.canonicalJson(v)}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  }

  private chatIri(roomId: string, context: MatrixStoreContext): string {
    return roomChatIri(this.scope(context), roomId);
  }

  private threadIri(roomId: string, context: MatrixStoreContext): string {
    return roomThreadIri(this.scope(context), roomId);
  }

  /**
   * The room record is written once by `createRoom` and never mutated on the
   * Matrix path, so one lookup per request serves membership, owner, metadata
   * and grant checks. Each extra lookup is a full chat-resource SPARQL SELECT.
   * The cache lives on the request context, not on this container singleton.
   */
  private async findRoomSource(db: Db, roomId: string, context: MatrixStoreContext): Promise<MatrixRoomSource | undefined> {
    const holder = context as MatrixStoreContext & { _roomSources?: Map<string, MatrixRoomSource | undefined> };
    holder._roomSources ??= new Map();
    const key = this.chatResourceIdFromRoomId(roomId);
    if (!holder._roomSources.has(key)) {
      holder._roomSources.set(key, await db.findById(chatResource, key) as MatrixRoomSource | undefined);
    }
    return holder._roomSources.get(key);
  }

  private async roomSource(db: Db, roomId: string, context: MatrixStoreContext): Promise<MatrixRoomSource> {
    const room = await this.findRoomSource(db, roomId, context);
    if (!room) throw new MatrixError(404,'M_NOT_FOUND','Room not found');
    return room;
  }

  private async requireRoomOwner(db: Db, roomId: string, context: MatrixStoreContext): Promise<void> {
    if ((await this.roomSource(db,roomId,context)).author !== context.webId) throw new MatrixError(403,'M_FORBIDDEN','Room owner authority is required');
  }

  private async requireJoined(db: Db, roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<void> {
    const room = await this.roomSource(db,roomId,context);
    // A fork makes "the latest member event by local order" and "the member the room
    // resolved to" different events, so the resolved state decides whether the caller
    // is in the room.
    const state = events
      ? this.resolvedState(roomId, context, events).get('m.room.member', this.getMatrixUserId(context))
      : await this.findLatestStateEvent(db,roomId,'m.room.member',this.getMatrixUserId(context),context);
    if (state?.content.membership === 'join' || (!state && room.author === context.webId)) return;
    throw new MatrixError(403,'M_FORBIDDEN','Join the room before accessing its timeline');
  }

  /** The room's current state, resolved across forks. */
  public async currentState(roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<MatrixRoomState> {
    const db = await this.getDb(context);
    return this.resolvedState(roomId, context, events ?? await this.listEvents(db, roomId, context));
  }

  /**
   * The resolved state of a room, memoized per Pod and room.
   *
   * Replaying a room costs O(events × state) and one operation asks for the same answer
   * several times — a write checks membership and agent grants against the same
   * timeline, a sync loop re-reads every room it did not change. The cache is keyed by
   * the events it was built from, so an appended event changes the key and no caller
   * can read a state that predates its write. Entries hold references to the records
   * the caller already has; the map is bounded and evicts the least recently used room.
   */
  private resolvedState(roomId: string, context: MatrixStoreContext, events: readonly MatrixEventRecord[]): MatrixRoomState {
    if (this.stateCacheLimit === 0) return resolveRoomState(events);
    const key = `${this.scope(context)}::${roomId}`;
    const cached = this.stateCache.get(key);
    // An appended list extends the cached replay, so a write costs the new events
    // rather than the room. Anything else is replayed in full.
    const extended = cached?.extend(events);
    const replay = extended ?? MatrixRoomStateReplay.from(events);
    // Refresh the insertion order so the least recently used room is evicted first.
    this.stateCache.delete(key);
    this.stateCache.set(key, replay);
    while (this.stateCache.size > this.stateCacheLimit) {
      const oldest = this.stateCache.keys().next().value;
      if (oldest === undefined) break;
      this.stateCache.delete(oldest);
    }
    return replay.state;
  }

  private validateAgentGrants(content: Record<string, unknown>): MatrixAgentGrant[] {
    if (!Array.isArray(content.agents) || content.agents.length > 32) throw new MatrixError(400,'M_BAD_JSON','agents must be an array of at most 32 grants');
    const uri = (value: unknown): value is string => {
      if (typeof value !== 'string') return false;
      try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    };
    const grants: MatrixAgentGrant[] = [];
    for (const value of content.agents) {
      const grant = value as MatrixAgentGrant;
      if (!grant || !uri(grant.agent) || !uri(grant.executor) || !uri(grant.workspace)
        || !Array.isArray(grant.allowedActors) || !grant.allowedActors.every(uri)
        || !Array.isArray(grant.handoffTo) || !grant.handoffTo.every(uri)
        || grant.allowedActors.length > 32 || grant.handoffTo.length > 32
        || grants.some(g=>g.agent===grant.agent)) throw new MatrixError(400,'M_BAD_JSON','Invalid or duplicate agent grant');
      grants.push(grant);
    }
    if (grants.some(g=>g.handoffTo.some(target=>!grants.some(candidate=>candidate.agent===target)))) {
      throw new MatrixError(400,'M_BAD_JSON','Handoff targets must be registered agents');
    }
    return grants;
  }

  private async agentGrants(db: Db, roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<MatrixAgentGrant[]> {
    const state = events
      ? this.resolvedState(roomId, context, events).get('co.undefineds.agents')
      : await this.findLatestStateEvent(db,roomId,'co.undefineds.agents','',context);
    return state ? this.validateAgentGrants(state.content) : [];
  }

  private async authorizeTargets(db: Db, roomId: string, content: Record<string,unknown>, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<string[]> {
    const target = this.routeTargetAgentFromMatrixContent(content);
    const targets = target ? [target] : this.mentionsFromMatrixContent(content);
    if (!targets.length) return [];
    const grants = await this.agentGrants(db,roomId,context,events);
    if (targets.some(agent=>!grants.some(g=>g.agent===agent && g.allowedActors.includes(context.webId)))) {
      throw new MatrixError(403,'M_FORBIDDEN','Agent execution is not granted to this actor');
    }
    return targets;
  }

  private async reconcileEvent(db: Db, event: MatrixEventRecord, context: MatrixStoreContext, events?: MatrixEventRecord[],
    knownReceipt?: MatrixTransactionReservation): Promise<void> {
    if (!this.serverGroupReconcilerService || event.type !== 'm.room.message' || event.role !== MessageRole.USER) return;
    const actor = event.senderWebId;
    if (!actor) return;
    const receipt = knownReceipt ?? await this.journal.findReservation(this.scope(context),event.eventId);
    if (!receipt || receipt.contentHash !== this.hash(this.canonicalJson(['user',actor,event.type,event.content]))) return;
    const targets = await this.authorizeTargets(db,event.roomId,event.content,{...context,webId:actor},events);
    const pending: string[] = [];
    for (const target of targets) if (await this.ensureDelivery(db,event,target,context)) pending.push(target);
    if (!pending.length) return;
    const room = await this.roomSource(db,event.roomId,context);
    await this.reconcileGroupUserMessage({thread:this.threadIri(event.roomId,context),
      triggerMessage:messageResource.buildIri(this.scope(context),{id:event.resourceId!}), actor, role:'user',
      content:typeof event.content.body==='string' ? event.content.body : '', createdAt:new Date(event.originServerTs).toISOString(),
      reconcilerOwner:this.reconcilerOwnerFromRoomMetadata(this.parseJsonObject(room.metadata)),
      mentions:pending,participants:pending});
  }

  /** Runtime principals must have both Pod access and an explicit room execution grant. */
  public async authorize(roomId: string, agent: string, context: MatrixStoreContext): Promise<{thread:string}> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    const grant = (await this.agentGrants(db,roomId,context,events)).find(g=>g.agent===agent && g.executor===context.webId);
    if (!grant) throw new MatrixError(403,'M_FORBIDDEN','No execution grant for this agent');
    return {thread:this.threadIri(roomId,context)};
  }

  /** Rebuild operational work from Pod facts after an interrupted write or queue restart. */
  public async recover(roomId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    // Recovery asks for one receipt per scanned event; fetch them as a page.
    const receipts = await this.journal.findReservations(this.scope(context), events.map(event => event.eventId));
    for (const event of events) {
      if (event.role === MessageRole.USER) {
        try { await this.reconcileEvent(db,event,context,events,receipts.get(event.eventId)); }
        catch (error) { if (!(error instanceof MatrixError && error.status === 403)) throw error; }
      }
      if (event.role === MessageRole.ASSISTANT) await this.reconcileHandoff(db,event,context,events);
    }
  }

  public async loadInput(roomId: string, job: SharedWakeAgentJob, context: MatrixStoreContext): Promise<{content:string;[key:string]:unknown}> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    if (!(await this.agentGrants(db,roomId,context,events)).some(g=>g.agent===job.agent && g.executor===context.webId)) {
      throw new MatrixError(403,'M_FORBIDDEN','No execution grant for this agent');
    }
    const event = events.find(e=>messageResource.buildIri(this.scope(context),{id:e.resourceId!})===job.triggerMessage);
    if (!event) throw new MatrixError(404,'M_NOT_FOUND','Trigger message not found');
    const grant = (await this.agentGrants(db,roomId,context,events)).find(g=>g.agent===job.agent)!;
    await this.validateTrigger(db,event,job,context,events);
    const values = {id:job.id,thread:job.thread,createdAt:job.createdAt};
    const delivery = await db.findById(deliveryResource,deliveryResource.buildId(values));
    const previous = await db.findById(runResource,runResource.buildId(values));
    if (['completed','failed','cancelled'].includes(delivery?.status) || this.runAttempts(previous) >= 3) {
      throw new MatrixError(409,'M_CONFLICT','Execution is terminal or its retry budget is exhausted');
    }
    const run = await this.materializeRun(db,roomId,job,context,'running',undefined,undefined,grant.workspace);
    return {content:typeof event.content.body==='string' ? event.content.body : '', thread:job.thread,
      triggerMessage:job.triggerMessage, agent:job.agent, workspace:grant.workspace, run,
      history:events.filter(e=>e.type==='m.room.message').slice(-50).map(e=>({role:e.role,body:e.content.body,eventId:e.eventId}))};
  }

  public async commitResult(roomId: string, job: SharedWakeAgentJob,
    result: {body:string;handoffTo?:string;evidence?:string[]}, context: MatrixStoreContext): Promise<{eventId:string;run:string}> {
    const db = await this.getDb(context);
    const events = await this.listEvents(db,roomId,context);
    await this.requireJoined(db,roomId,context,events);
    if (!(await this.agentGrants(db,roomId,context,events)).some(g=>g.agent===job.agent && g.executor===context.webId)) {
      throw new MatrixError(403,'M_FORBIDDEN','No execution grant for this agent');
    }
    const grant = (await this.agentGrants(db,roomId,context,events)).find(g=>g.agent===job.agent)!;
    const trigger = events.find(e=>messageResource.buildIri(this.scope(context),{id:e.resourceId!})===job.triggerMessage);
    if (!trigger) throw new MatrixError(404,'M_NOT_FOUND','Trigger message not found');
    await this.validateTrigger(db,trigger,job,context,events);
    const prior = trigger.role === MessageRole.ASSISTANT
      ? this.parseJsonObject(trigger.content['co.undefineds.execution'] as JsonObjectSource) : undefined;
    const hops = typeof prior?.hops === 'number' ? prior.hops + 1 : 1;
    if (result.handoffTo && (!grant.handoffTo.includes(result.handoffTo) || hops >= 8)) {
      throw new MatrixError(403,'M_FORBIDDEN','Handoff is not granted or its hop limit was reached');
    }
    const content = {msgtype:'m.text',body:result.body,'co.undefineds.replyTo':job.triggerMessage,
      'm.relates_to':{'m.in_reply_to':{event_id:trigger.eventId}},
      'co.undefineds.execution':{jobId:job.id,agent:job.agent,hops,handoffTo:result.handoffTo,
        root:prior?.root ?? job.triggerMessage,evidence:result.evidence ?? []}};
    const contentHash = this.hash(this.canonicalJson(['assistant',job.agent,'m.room.message',content]));
    const key = JSON.stringify(['wake-result',job.id]);
    const resultSender = this.getMatrixUserId({...context,webId:job.agent});
    const resultInput = {
      roomId, type: 'm.room.message', sender: resultSender, content,
      ...this.graphPosition(events, { type: 'm.room.message', sender: resultSender, content }),
    };
    const { reservation, proposal } = await this.reserveEventTransaction(context, key, resultInput, contentHash);
    let active = reservation;
    if (reservation.contentHash !== contentHash) {
      // A crashed executor can leave a reservation whose output never reached the
      // Pod. Its absence proves nothing is committed, so the current attempt takes
      // the reservation over — id included, since an event's id is derived from
      // the event and this attempt's content derives its own.
      const dangling = !events.some(event => event.eventId === reservation.eventId);
      if (!dangling) throw new MatrixError(409,'M_CONFLICT','A different result was already reserved for this wake');
      active = { eventId: proposal.event_id!, createdAt: proposal.origin_server_ts as number, contentHash };
      await this.journal.replaceReservation(this.scope(context), key, active);
    }
    const pendingResult = await this.eventForReservation(resultInput, active, context);
    let output = events.find(e=>e.eventId===active.eventId);
    if (!output) {
      // The reservation that is actually in force is `active`: after a takeover it
      // names a different event with a different time, and the row has to match it.
      output = await this.appendEvent(db,{roomId,type:'m.room.message',sender:resultSender,
        maker:job.agent,role:MessageRole.ASSISTANT,eventId:active.eventId,originServerTs:active.createdAt,content,
        event:pendingResult},context,events);
    } else if (this.hash(this.canonicalJson(['assistant',job.agent,output.type,output.content])) !== reservation.contentHash) {
      throw new MatrixError(409,'M_CONFLICT','Stored result no longer matches its receipt');
    }
    const run = await this.materializeRun(db,roomId,job,context,'completed',output.eventId,undefined,grant.workspace);
    const deliveryId = deliveryResource.buildId({id:job.id,thread:job.thread,createdAt:job.createdAt});
    await db.updateById(deliveryResource,deliveryId,{status:'completed',completedAt:new Date().toISOString()});
    await this.reconcileHandoff(db,output,context,events);
    return {eventId:output.eventId,run};
  }

  private async validateTrigger(db: Db, event: MatrixEventRecord, job: SharedWakeAgentJob, context: MatrixStoreContext, events: MatrixEventRecord[]): Promise<void> {
    const receipt = await this.journal.findReservation(this.scope(context),event.eventId);
    let valid = false;
    if (event.role === MessageRole.USER && event.senderWebId) {
      valid = receipt?.contentHash === this.hash(this.canonicalJson(['user',event.senderWebId,event.type,event.content]));
      if (valid) valid = (await this.authorizeTargets(db,event.roomId,event.content,{...context,webId:event.senderWebId},events)).includes(job.agent);
    } else if (event.role === MessageRole.ASSISTANT) {
      const execution = this.parseJsonObject(event.content['co.undefineds.execution'] as JsonObjectSource);
      if (execution && typeof execution.agent === 'string' && execution.handoffTo === job.agent &&
          typeof execution.hops === 'number' && execution.hops < 8) {
        valid = receipt?.contentHash === this.hash(this.canonicalJson(['assistant',execution.agent,event.type,event.content]));
        if (valid) valid = (await this.agentGrants(db,event.roomId,context,events)).some(g=>g.agent===execution.agent && g.handoffTo.includes(job.agent));
      }
    }
    if (!valid || job.thread !== this.threadIri(event.roomId,context)) {
      throw new MatrixError(403,'M_FORBIDDEN','Trigger receipt or current execution authorization is invalid');
    }
  }

  /**
   * Whether the Pod still holds work for this job. The queue is only a working
   * set: it can spend its own in-flight attempts on claims that crashed before
   * any execution happened, so a queue-terminal job is not evidence of a
   * terminal execution. Pod facts stay authoritative.
   */
  public async isJobActionable(thread: string, job: SharedWakeAgentJob, context: MatrixStoreContext): Promise<boolean> {
    const db = await this.getDb(context);
    const values = { id: job.id, thread, createdAt: job.createdAt };
    const delivery = await db.findById(deliveryResource, deliveryResource.buildId(values));
    if (delivery && ['completed', 'failed', 'cancelled'].includes(String(delivery.status))) return false;
    const run = await db.findById(runResource, runResource.buildId(values));
    if (run?.status === 'completed' || run?.status === 'failed') return false;
    return this.runAttempts(run) < 3;
  }

  public async recordFailure(roomId: string, job: SharedWakeAgentJob,
    failure: {error?:string;retry:boolean}, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    const values = {id:job.id,thread:job.thread,createdAt:job.createdAt};
    const existing = await db.findById(runResource,runResource.buildId(values));
    const terminal = !failure.retry || this.runAttempts(existing) >= 3;
    if (existing?.status === 'completed') return;
    await this.materializeRun(db,roomId,job,context,terminal?'failed':'queued',undefined,failure.error);
    await db.updateById(deliveryResource,deliveryResource.buildId(values),{
      status:terminal?'failed':'pending',updatedAt:new Date().toISOString(),
      ...(terminal?{completedAt:new Date().toISOString()}:{}),
    });
  }

  private runAttempts(row: {metadata?:JsonObjectSource} | null | undefined): number {
    const metadata = this.parseJsonObject(row?.metadata);
    const protocols = this.parseJsonObject(metadata?.protocols as JsonObjectSource);
    const matrix = this.parseJsonObject(protocols?.matrix as JsonObjectSource);
    return typeof matrix?.attempts === 'number' ? matrix.attempts : 0;
  }

  private async reconcileHandoff(db: Db, event: MatrixEventRecord, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<void> {
    const execution = this.parseJsonObject(event.content['co.undefineds.execution'] as JsonObjectSource);
    if (!execution?.handoffTo || typeof execution.agent!=='string' || typeof execution.handoffTo!=='string'
      || typeof execution.hops!=='number' || execution.hops>=8 || !this.serverGroupReconcilerService) return;
    const receipt = await this.journal.findReservation(this.scope(context),event.eventId);
    if (!receipt || receipt.contentHash !== this.hash(this.canonicalJson(['assistant',execution.agent,event.type,event.content]))) return;
    const grants = await this.agentGrants(db,event.roomId,context,events);
    if (!grants.some(g=>g.agent===execution.agent && g.handoffTo.includes(execution.handoffTo as string))) return;
    if (!await this.ensureDelivery(db,event,execution.handoffTo,context)) return;
    // Only output with an API-issued receipt can trigger a handoff; direct Pod writes cannot.
    await this.serverGroupReconcilerService.reconcileThreadMessage({thread:this.threadIri(event.roomId,context),
      triggerMessage:messageResource.buildIri(this.scope(context),{id:event.resourceId!}),actor:execution.agent,
      role:'user',createdAt:new Date(event.originServerTs).toISOString(),reconcilerOwner:'server',routeTargetAgent:execution.handoffTo,participants:grants.map(g=>g.agent)});
  }

  private async ensureDelivery(db: Db, event: MatrixEventRecord, agent: string, context: MatrixStoreContext): Promise<boolean> {
    const thread = this.threadIri(event.roomId,context);
    const triggerMessage = messageResource.buildIri(this.scope(context),{id:event.resourceId!});
    const jobId = sharedWakeAgentJobId({thread,triggerMessage,agent});
    const createdAt = new Date(event.originServerTs).toISOString();
    const id = deliveryResource.buildId({id:jobId,thread,createdAt});
    const existing = await db.findById(deliveryResource,id);
    if (existing?.status==='completed' || existing?.status==='cancelled' || existing?.status==='failed') return false;
    // Complete a write interrupted after the result Message but before Run/Delivery ACK.
    // The result is looked up through its own record rather than a derived id: the
    // id now depends on the result content, which only the record knows.
    const records = await this.listEvents(db, event.roomId, context);
    const stored = records.find(record => record.role === MessageRole.ASSISTANT &&
      this.parseJsonObject(record.content['co.undefineds.execution'] as JsonObjectSource)?.jobId === jobId);
    const receipt = stored === undefined ? undefined : await this.journal.findReservation(this.scope(context), stored.eventId);
    const resultEventId = stored?.eventId;
    if (receipt && resultEventId) {
      const source = await db.findById(messageResource,this.messageResourceIdFromEvent(event.roomId,resultEventId,receipt.createdAt));
      if (source) {
        const output = this.eventSourceToRecord(source,event.roomId,context);
        if (receipt.contentHash === this.hash(this.canonicalJson(['assistant',agent,output.type,output.content]))) {
          await this.materializeRun(db,event.roomId,{id:jobId,thread,triggerMessage,agent,createdAt,status:'completed',reason:'mention'},context,'completed',resultEventId);
          await db.updateById(deliveryResource,id,{status:'completed',completedAt:new Date().toISOString()});
          return false;
        }
      }
    }
    const run = await db.findById(runResource,runResource.buildId({id:jobId,thread,createdAt}));
    if (this.runAttempts(run) >= 3) {
      const active = await this.serverGroupReconcilerService?.getQueue().listQueued(thread,agent);
      if (active?.some(job=>job.id===jobId && job.status==='leased' && Date.parse(job.leaseExpiresAt ?? '') > Date.now())) return false;
      if (!run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now()) {
        await this.recordFailure(event.roomId,{id:jobId,thread,triggerMessage,agent,createdAt,status:'failed',reason:'mention'},
          {retry:false,error:'Execution lease exhausted its retry budget'},context);
      }
      return false;
    }
    if (!existing) await db.insert(deliveryResource).values({id,thread,chat:this.chatIri(event.roomId,context),
      source:triggerMessage,object:triggerMessage,target:agent,actor:event.senderWebId,
      kind:event.role===MessageRole.ASSISTANT?'runtime_followup':'mention_dispatch',status:'pending',
      createdAt,updatedAt:createdAt});
    return true;
  }

  private async materializeRun(db: Db, roomId: string, job: SharedWakeAgentJob, context: MatrixStoreContext,
    status: 'running'|'completed'|'failed'|'queued', eventId?: string, error?:string, workspace?:string): Promise<string> {
    const runWorkspace = workspace ?? (await this.agentGrants(db,roomId,context)).find(g=>g.agent===job.agent)?.workspace;
    const values = {id:job.id,thread:job.thread,createdAt:job.createdAt};
    const id = runResource.buildId(values);
    const iri = runResource.buildIri(this.scope(context),values);
    const existing = await db.findById(runResource,id);
    if (existing?.status==='completed') return iri;
    const now = new Date().toISOString();
    const row = {id,thread:job.thread,input:job.triggerMessage,delivery:deliveryResource.buildIri(this.scope(context),values),workspace:runWorkspace,runner:'external',status,
      leaseOwner:job.leaseOwner,leaseExpiresAt:job.leaseExpiresAt,createdAt:job.createdAt,updatedAt:now,
      ...(['completed','failed'].includes(status)?{completedAt:now}: {startedAt:now}),
      metadata:{'@id':`${iri}/metadata`,protocols:{matrix:{roomId,jobId:job.id,eventId,fencingToken:job.fencingToken,attempts:this.runAttempts(existing)+(status==='running'?1:0),error}}}};
    if (existing) await db.updateById(runResource,id,row); else await db.insert(runResource).values(row);
    const stepId = runStepResource.buildId({id:`${job.id}-${status}`,run:iri,createdAt:now});
    if (!await db.findById(runStepResource,stepId)) await db.insert(runStepResource).values({id:stepId,run:iri,
      stepType:status==='running'?'run.started':`run.${status}`,createdAt:now,payload:{'@id':`${runStepResource.buildIri(this.scope(context),{id:stepId})}/payload`,agent:job.agent,eventId}});
    return iri;
  }

  private parseJsonObject(value: JsonObjectSource): Record<string, unknown> | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private numberValue(value: unknown): number | undefined {
    if (typeof value !== 'number') {
      return undefined;
    }
    return Number.isFinite(value) ? value : undefined;
  }

  private async getRoomContext(db: Db, roomId: string, context: MatrixStoreContext): Promise<MatrixRoomContext> {
    const room = await this.findRoomSource(db, roomId, context);
    return {
      metadata: this.parseJsonObject(room?.metadata),
      participants: normalizeAgentUris(room?.participants),
    };
  }

  private reconcilerOwnerFromRoomMetadata(metadata: Record<string, unknown> | undefined): ReconcilerOwner {
    return normalizeReconcilerOwner(metadata?.reconcilerOwner, 'server');
  }

  private async reconcileGroupUserMessage(input: {
    thread: string;
    triggerMessage: string;
    actor: string;
    role: string;
    content: string;
    createdAt?: string;
    reconcilerOwner: ReconcilerOwner;
    mentions?: string[];
    routeTargetAgent?: string;
    participants?: string[];
  }): Promise<void> {
    if (!this.serverGroupReconcilerService || input.role !== MessageRole.USER) {
      return;
    }
    try {
      await this.serverGroupReconcilerService.reconcileThreadMessage({
        thread: input.thread,
        triggerMessage: input.triggerMessage,
        actor: input.actor,
        role: 'user',
        content: input.content,
        createdAt: input.createdAt,
        reconcilerOwner: input.reconcilerOwner,
        mentions: input.mentions,
        routeTargetAgent: input.routeTargetAgent,
        participants: input.participants,
      });
    } catch (error) {
      this.logger.warn(`Failed to enqueue Matrix group Reconciler wake: ${error}`);
      throw new MatrixError(503, 'M_UNKNOWN', 'Message stored; wake delivery pending. Retry the same transaction.');
    }
  }

  private messageContentFromMatrixEvent(eventType: string, content: Record<string, unknown>): string {
    if (eventType === 'm.room.message' && typeof content.body === 'string') {
      return content.body;
    }
    return JSON.stringify(content);
  }

  private mentionsFromMatrixContent(content: Record<string, unknown>): string[] {
    const matrixMentions = this.parseJsonObject(content['m.mentions'] as JsonObjectSource);
    return normalizeAgentUris([
      ...normalizeAgentUris(content.mentions),
      ...normalizeAgentUris(content['co.undefineds.mentions']),
      ...normalizeAgentUris(matrixMentions?.agents),
    ]);
  }

  private routeTargetAgentFromMatrixContent(content: Record<string, unknown>): string | undefined {
    return this.stringValue(content.routeTargetAgent)
      ?? this.stringValue(content['co.undefineds.routeTargetAgent'])
      ?? this.stringValue(content['co.undefineds.route_target_agent']);
  }

  /**
   * Let the deployment supply this participant's own signing identity before any event
   * of theirs is written. Absent hook means "the deployment serves nobody individually",
   * which keeps single-identity deployments exactly as they were.
   */
  private async ensureParticipantIdentity(context: MatrixStoreContext): Promise<void> {
    if (!this.participantIdentity) return;
    await this.participantIdentity.ensureParticipantIdentity({
      webId: context.webId,
      targetPodUrl: context.podUrl,
      context,
    });
  }

  /**
   * Hand a written event to the servers that have a member in the room.
   *
   * Deliberately outside the write's cost: a federation round trip must not sit inside a
   * local write, and a peer that is down is absorbed by the queue instead of the caller.
   * The PDU is the *persisted protocol event* — with its hashes and signature — because
   * that is what a peer verifies, and the origin is the sender's own server, so the
   * transaction is signed by the identity whose event it is.
   */
  private async queueFederationDelivery(
    roomId: string,
    context: MatrixStoreContext,
    timeline: readonly MatrixEventRecord[],
    event: PersistedMatrixEvent,
  ): Promise<void> {
    if (!this.outbound) return;
    const origin = serverNameOf(typeof event.sender === 'string' ? event.sender : undefined);
    if (!origin) return;
    const destinations = eventDestinations({
      state: this.resolvedState(roomId, context, timeline),
      ourServerName: origin,
      event: {
        type: typeof event.type === 'string' ? event.type : '',
        ...(typeof event.state_key === 'string' ? { stateKey: event.state_key } : {}),
      },
    });
    for (const destination of destinations) {
      await this.outbound.enqueue({ scope: this.scope(context), origin, destination, pdus: [ event ] });
    }
  }

  private getMatrixUserId(context: MatrixStoreContext): string {
    const serverName = this.getServerName(context);
    const localpart = `u_${this.hash(context.webId)}`;
    return `@${localpart}:${serverName}`;
  }

  /**
   * The server this caller's events belong to.
   *
   * A participant is their own server when this deployment holds that identity's key,
   * and only then: attributing an event to a server we cannot sign for would either
   * fail the write or, worse, sign it under a name that never signed it. So the
   * WebID host wins when it is signable, and the deployment's own name is the
   * fallback for everyone this deployment serves under one identity.
   */
  private getServerName(context: MatrixStoreContext): string {
    const host = webIdServerName(context.webId);
    if (host && (this.identities?.serverNames?.() ?? []).includes(host)) return host;
    if (this.serverName) return this.serverName;
    return host ?? 'localhost';
  }

  private displayNameFromUserId(matrixUserId: string): string {
    return matrixUserId.replace(/^@/, '').split(':')[0] || matrixUserId;
  }

  private generateRoomId(context: MatrixStoreContext): string {
    return `!${this.randomId(24)}:${this.getServerName(context)}`;
  }

  private generateEventId(context: MatrixStoreContext): string {
    return `$${this.randomId(24)}:${this.getServerName(context)}`;
  }

  private deviceId(context: MatrixStoreContext): string {
    const auth = context.auth;
    return `XPOD${this.hash(JSON.stringify([context.webId, auth?.type === 'solid' ? auth.clientId ?? auth.gatewayKeyId ?? 'solid' : 'solid'])).slice(0,24).toUpperCase()}`;
  }

  private randomId(size: number): string {
    return randomBytes(size).toString('base64url');
  }

  private surfaceIdFromRoomId(roomId: string): string {
    return roomSurfaceId(roomId);
  }

  private chatResourceIdFromRoomId(roomId: string): string {
    return chatResource.buildId({id: this.surfaceIdFromRoomId(roomId)});
  }

  private threadResourceIdFromRoomId(roomId: string): string {
    return threadResource.buildId({id: 'thread', parent: chatResource.buildIri('https://layout.invalid/', {id:this.surfaceIdFromRoomId(roomId)})});
  }

  private messageResourceIdFromEvent(roomId: string, eventId: string, ts: number): string {
    return messageResource.buildId({id: this.hash(eventId),
      parent: chatResource.buildIri('https://layout.invalid/', {id:this.surfaceIdFromRoomId(roomId)}),
      createdAt:new Date(ts).toISOString()});
  }

  private isoToMillis(value: string | Date | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : undefined;
  }

  private encodeSyncToken(ts: number): string {
    return `v2_${Math.max(0, Math.floor(ts))}`;
  }

  private parseSyncToken(token: string | undefined): number {
    if (!token) {
      return 0;
    }
    if (!/^v2_\d+$/u.test(token)) throw new MatrixError(400, 'M_UNKNOWN_POS', 'Cursor version changed; start a fresh sync');
    const parsed = Number(token.slice(3));
    if (!Number.isSafeInteger(parsed)) throw new MatrixError(400, 'M_UNKNOWN_POS', 'Invalid cursor');
    return parsed;
  }
}
