import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { getProtocolMetadata, withProtocolMetadata } from '../protocol-metadata';
import { MatrixError } from './MatrixError';
import { InMemoryMatrixEventJournal, type MatrixEventJournal } from './MatrixEventJournal';
import type { PodAccessFetchProvider } from '../ai-gateway/pod/OwnerPodAccess';
import type { SharedWakeAgentJob } from '../reconciler/coordination';
import { sharedWakeAgentJobId } from '../reconciler/WakeAgentQueue';
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

export interface PodMatrixStoreOptions {
  podAccess?: PodAccessFetchProvider;
  journal?: MatrixEventJournal;
  serverName?: string;
  serverGroupReconcilerService?: ServerGroupReconcilerService;
}

type Db = any;
type JsonObjectSource = string | Record<string, unknown> | null | undefined;

/**
 * A phase slower than this is reported with its monotonic duration. The
 * threshold keeps normal traffic quiet while still capturing a stalled Pod
 * request, which is the only way to see where a 500's time actually went.
 */
const SLOW_PHASE_MS = 3_000;
const SAFE_ERROR_TOKEN = /^[A-Za-z0-9_]{1,64}$/;
// `DOMException.code` is a prototype getter that returns a number, so a
// string-only filter silently drops a real native timeout. Numeric `23`
// (TimeoutError) is the only numeric code allowed through.
const DOM_TIMEOUT_CODE = 23;
// Fixed standard HTTP methods only: a request's method may carry an opaque
// credential token, so an unrecognized value is reported as `unknown`.
const SAFE_HTTP_METHODS = new Set<string>([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH',
]);

/**
 * Per-operation diagnostic correlation.
 *
 * A trace is created for one operation/request/call and passed down its awaited
 * boundaries. No phase is ever stored on the store instance, so concurrent
 * operations cannot overwrite each other's phase.
 */
interface MatrixPhaseTrace {
  readonly operation: string;
  readonly id: string;
}

/**
 * The trace of the public operation currently running, scoped to its async
 * call chain.
 *
 * Each public store method opens one operation trace; every internal helper
 * (`getDb`, `appendEvent`, `listEvents`, ...) inherits it, so a single call
 * shares one `opId`. A cached fetch reads the trace active at execution time
 * instead of the first caller's, and concurrent operations stay isolated
 * because AsyncLocalStorage is per async context, not a mutable field on the
 * store instance.
 */
const operationTrace = new AsyncLocalStorage<MatrixPhaseTrace>();

/** Public store entry points, each of which opens exactly one operation trace. */
const TRACED_PUBLIC_OPERATIONS = [
  'getAccount', 'createRoom', 'joinRoom', 'inviteUser', 'leaveRoom', 'sendEvent', 'setState',
  'sync', 'listJoinedRooms', 'getMembers', 'listMessages', 'getEvent', 'getState',
  'authorize', 'recover', 'loadInput', 'commitResult', 'recordFailure',
] as const;

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

export class PodMatrixStore {
  private readonly podAccess?: PodAccessFetchProvider;
  private readonly journal: MatrixEventJournal;
  private readonly logger = getLoggerFor(this);
  private fetchSequence = 0;
  private readonly rawBodyReaders = new WeakMap<ReadableStream, ReadableStream['getReader']>();
  private readonly serverName?: string;
  private readonly serverGroupReconcilerService?: ServerGroupReconcilerService;

  public constructor(options: PodMatrixStoreOptions) {
    this.serverName = options.serverName;
    this.podAccess = options.podAccess;
    this.journal = options.journal ?? new InMemoryMatrixEventJournal();
    this.serverGroupReconcilerService = options.serverGroupReconcilerService;
    this.wrapPublicOperations();
  }

  public async getAccount(context: MatrixStoreContext): Promise<MatrixAccountInfo> {
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
    if (input.creation_content?.['m.federate'] === true || (input.creation_content?.room_version && input.creation_content.room_version !== '11')) {
      throw new MatrixError(400, 'M_UNSUPPORTED_ROOM_VERSION', 'Only non-federated room version 11 is supported');
    }
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
        roomVersion: String(input.creation_content?.room_version ?? '11'),
        federate: input.creation_content?.['m.federate'] === true,
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

    await this.appendEvent(db, {
      roomId,
      reconcilerOwner,
      type: 'm.room.create',
      sender,
      originServerTs: now,
      stateKey: '',
      content: {
        creator: sender,
        room_version: String(input.creation_content?.room_version ?? '11'),
        type: input.creation_content?.type,
        'm.federate': input.creation_content?.['m.federate'] === true,
      },
    }, context);
    await this.appendEvent(db, {
      roomId,
      reconcilerOwner,
      type: 'm.room.member',
      sender,
      originServerTs: now + 1,
      stateKey: sender,
      content: {
        membership: 'join',
        displayname: this.displayNameFromUserId(sender),
      },
    }, context);
    if (input.name) {
      await this.appendEvent(db, {
        roomId,
        reconcilerOwner,
        type: 'm.room.name',
        sender,
        originServerTs: now + 2,
        stateKey: '',
        content: { name: input.name },
      }, context);
    }
    if (input.topic) {
      await this.appendEvent(db, {
        roomId,
        reconcilerOwner,
        type: 'm.room.topic',
        sender,
        originServerTs: now + 3,
        stateKey: '',
        content: { topic: input.topic },
      }, context);
    }
    for (const state of input.initial_state ?? []) {
      await this.appendEvent(db, {
        roomId,
        reconcilerOwner,
        type: state.type,
        sender,
        originServerTs: Date.now(),
        stateKey: state.state_key ?? '',
        content: state.content ?? {},
      }, context);
    }
    for (const invitee of input.invite ?? []) {
      await this.appendMembershipEvent(db, roomId, invitee, 'invite', context, { sender, reconcilerOwner });
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
    const room = await this.roomSource(db, roomId);
    const sender = this.getMatrixUserId(context);
    const existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', sender, context);
    if (existing?.content.membership === 'join') return { roomId };
    if (existing?.content.membership !== 'invite' && room.author !== context.webId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'An invitation is required');
    }
    if (existing?.content.membership === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Banned from room');
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
    // One public operation trace is opened for this call; every phase below and
    // every nested helper inherits it, so the whole PUT shares one opId.
    const trace = this.currentTrace('sendEvent');
    const db = await this.getDb(context, trace);
    // Reuse the room and timeline within this operation. The exact receipt lookup
    // remains independent: its resource may have moved out of this timeline.
    const room = await this.runPhase(trace, 'sendEvent.roomSource', {}, () => this.roomSource(db,roomId));
    const events = await this.runPhase(trace, 'sendEvent.listEvents', {}, () =>
      this.listEvents(db, roomId, context, {}, trace));
    await this.runPhase(trace, 'sendEvent.requireJoined', {}, () => this.requireJoined(db, roomId, context, events, room));
    if (eventType !== 'm.room.message') throw new MatrixError(400, 'M_UNRECOGNIZED', 'Only m.room.message timeline events are supported');
    await this.runPhase(trace, 'sendEvent.authorizeTargets', {}, () => this.authorizeTargets(db, roomId, content, context, events));
    const reservation = await this.runPhase(trace, 'sendEvent.journal.reserveTransaction', {}, () =>
      this.journal.reserveTransaction(this.scope(context),
        JSON.stringify([this.deviceId(context), roomId, eventType, txnId]), {
          eventId: this.generateEventId(context), createdAt: Date.now(), contentHash: this.hash(this.canonicalJson(['user',context.webId,eventType,content])),
        }));
    if (reservation.contentHash !== this.hash(this.canonicalJson(['user',context.webId,eventType,content]))) {
      throw new MatrixError(409, 'M_CONFLICT', 'Transaction already reserved with different content');
    }
    const source = await this.runPhase<MatrixEventSource | undefined>(trace, 'sendEvent.db.findById', {}, () =>
      db.findById(messageResource,this.messageResourceIdFromEvent(roomId,reservation.eventId,reservation.createdAt)));
    if (source) {
      const existing = this.eventSourceToRecord(source,roomId,context);
      if (reservation.contentHash !== this.hash(this.canonicalJson(['user',existing.senderWebId,existing.type,existing.content]))) {
        throw new MatrixError(409,'M_CONFLICT','Stored event no longer matches its receipt');
      }
      existing.depth = await this.runPhase(trace, 'journal.register', {}, () =>
        this.journal.registerEvent(this.scope(context),roomId,existing.eventId));
      await this.runPhase(trace, 'reconcileEvent', {}, () => this.reconcileEvent(db, existing, context, events));
      return existing;
    }
    return this.appendEvent(db, { roomId, type: eventType, sender: this.getMatrixUserId(context), txnId,
      eventId: reservation.eventId, originServerTs: reservation.createdAt, content,
      roomContext: { metadata: this.parseJsonObject(room.metadata), participants: normalizeAgentUris(room.participants) } }, context);
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
    const trace = this.currentTrace('sync');
    const startedAt = performance.now();
    let passes = 0;
    let completed = false;
    try {
      const deadline = Date.now() + Math.min(Math.max(options.timeout ?? 0, 0), 30_000);
      let result: MatrixSyncResponse;
      // First pass indexes native Pod writes; the second reads a committed journal watermark.
      await this.syncOnce(context, options, trace);
      passes = 1;
      do {
        result = await this.syncOnce(context, options, trace);
        passes += 1;
        if (Object.values(result.rooms.join).some(room => room.timeline.events.length)
          || Object.keys(result.rooms.invite ?? {}).length || Date.now() >= deadline || options.signal?.aborted) {
          completed = true;
          return result;
        }
        await new Promise<void>((resolve) => {
          const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
          options.signal?.addEventListener('abort', done, { once: true });
        });
      } while (!options.signal?.aborted);
      completed = true;
      return result;
    } finally {
      if (completed) this.logPhase(trace, 'sync.done', startedAt, { passes });
    }
  }

  private async syncOnce(context: MatrixStoreContext, options: { since?: string; limit?: number }, trace: MatrixPhaseTrace): Promise<MatrixSyncResponse> {
    const startedAt = performance.now();
    const db = await this.getDb(context, trace);
    const since = this.parseSyncToken(options.since);
    const snapshot = await this.runPhase(trace, 'sync.watermark', {}, () => this.journal.getHighWatermark(this.scope(context)));
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
    const join: MatrixSyncResponse['rooms']['join'] = {};
    const invite: NonNullable<MatrixSyncResponse['rooms']['invite']> = {};
    const leave: NonNullable<MatrixSyncResponse['rooms']['leave']> = {};
    const batches: Array<{room: MatrixRoomRecord; events: MatrixEventRecord[]}> = [];
    const rooms = await this.runPhase(trace, 'sync.rooms.select', {}, () => this.listRooms(db));
    for (const room of rooms) {
      const events = (await this.listEvents(db, room.roomId, context, {}, trace)).filter(e=>e.depth! <= snapshot);
      const membership = this.latestState(events, 'm.room.member', this.getMatrixUserId(context));
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
      const state = new Map<string, MatrixEventRecord>();
      const firstSequence = page[0]?.depth ?? since;
      // State at the start of this timeline; events in the timeline apply after it.
      for (const event of events) if (event.stateKey !== undefined && (event.depth ?? 0) < firstSequence) state.set(JSON.stringify([event.type,event.stateKey]),event);
      join[room.roomId] = {state: {events: [...state.values()].map(e=>this.toClientEvent(e))},
        timeline: {events: page.map(e=>this.toClientEvent(e)), limited: candidates.length > selected.length,
          ...(page.length ? {prev_batch: this.encodeSyncToken((page[0].depth ?? 1) - 1)} : {})},
        'co.undefineds.coordination': {reconcilerOwner: room.reconcilerOwner}};
    }
    const transitionPositions = [...Object.values(invite).flatMap(r=>r.invite_state.events), ...Object.values(leave).flatMap(r=>r.timeline.events)];
    // When a joined timeline has backlog, do not advance past its last delivered event.
    const next = selected.length ? selected[selected.length-1].depth! : since;
    const high = candidates.length === 0 && transitionPositions.length ? snapshot : next;
    this.logPhase(trace, 'sync.once.done', startedAt, {
      rooms: rooms.length,
      events: batches.reduce((total, batch) => total + batch.events.length, 0),
      selected: selected.length,
      cursorAdvanced: high !== since,
    });
    return {next_batch: this.encodeSyncToken(high), rooms: {join, invite, leave}};
  }

  public async listJoinedRooms(context: MatrixStoreContext): Promise<string[]> {
    const db = await this.getDb(context);
    return (await this.listJoinedRoomRecords(db, context)).map((room) => room.roomId);
  }

  public async getMembers(roomId: string, context: MatrixStoreContext): Promise<MatrixClientEvent[]> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    const events = await this.listEvents(db, roomId, context, { newestFirst: true });
    const latestByStateKey = new Map<string, MatrixEventRecord>();
    for (const event of events) {
      if (event.type !== 'm.room.member' || event.stateKey === undefined || latestByStateKey.has(event.stateKey)) {
        continue;
      }
      latestByStateKey.set(event.stateKey, event);
    }
    return Array.from(latestByStateKey.values())
      .sort((left, right) => (left.originServerTs - right.originServerTs) || ((left.depth ?? 0) - (right.depth ?? 0)))
      .map((event) => this.toClientEvent(event));
  }

  public async listMessages(roomId: string, context: MatrixStoreContext,
    options: { limit?: number; dir?: 'b' | 'f'; from?: string } = {}): Promise<{chunk: MatrixClientEvent[];start?:string;end:string}> {
    const db = await this.getDb(context);
    await this.requireJoined(db, roomId, context);
    await this.listEvents(db, roomId, context);
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
    const event = await this.findLatestStateEvent(db, roomId, eventType, stateKey, context);
    if (!event) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'State not found');
    }
    return event.content;
  }

  private async getDb(context: MatrixStoreContext, parent?: MatrixPhaseTrace): Promise<Db> {
    if ((context as any)._matrixDb) {
      return (context as any)._matrixDb;
    }

    const trace = parent ?? this.currentTrace('getDb');
    const auth = context.auth as AuthContext | undefined;
    if (!auth || !isSolidAuth(auth) || !auth.webId) {
      throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'Solid authentication is required');
    }
    const podFetch = await this.runPhase(trace, 'getDb.credentials', {}, async () =>
      this.podAccess ? await this.podAccess.getPodFetch(context.webId, {auth, podBaseUrl: context.podUrl}) : undefined);
    if (!podFetch) throw new MatrixError(403, 'M_FORBIDDEN', 'Grant Pod interface access before using Matrix');
    const db: Db = drizzle(
      {
        fetch: this.tracePodFetch(podFetch),
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
    await this.runPhase(trace, 'getDb.init', {}, () => db.init(
      chatResource,
      threadResource,
      runResource,
      runStepResource,
      deliveryResource,
      messageResource,
    ));
    (context as any)._matrixDb = db;
    return db;
  }

  /**
   * Wrap a Pod fetch so each outbound request reports its monotonic phase.
   *
   * Fetch starts and header/error ends are recorded even when fast. Body
   * method boundaries are separate, so a stalled select can be correlated
   * with the actual awaited transport or body-consumption method. The correlation is read
   * from the operation trace active at execution time, so a cached fetch
   * reused by a later call reports that call, not its first creator. The
   * method is reduced to a fixed standard token; no URL, query, body, token or
   * DSN is ever read. The original request/signal and Response object pass
   * through; response consumption methods are observed without pre-reading.
   */
  private tracePodFetch(podFetch: typeof fetch): typeof fetch {
    // Fetches cached in a DB inherit the operation active when they execute.
    const owner = operationTrace.getStore();
    return async (input, init) => {
      const startedAt = performance.now();
      const trace = operationTrace.getStore() ?? owner ?? this.createTrace('podFetch');
      const fetchId = ++this.fetchSequence;
      const rawMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const method = typeof rawMethod === 'string' && SAFE_HTTP_METHODS.has(rawMethod.toUpperCase())
        ? rawMethod.toUpperCase()
        : 'unknown';
      const detail = { fetchId, method };
      this.startPhase(trace, 'podFetch', startedAt, detail);
      try {
        const response = await podFetch(input, init);
        this.logPhase(trace, 'podFetch.headers', startedAt, {
          ...detail, status: response.status, ok: response.ok, ...this.safeBodyHeaders(response),
        }, true);
        this.traceRawBody(response, trace, detail, init?.signal ?? (input instanceof Request ? input.signal : undefined));
        return this.traceResponseBody(response, trace, detail);
      } catch (error) {
        this.logPhase(trace, 'podFetch.error', startedAt, { ...detail, ...this.errorDetail(error) }, true);
        throw error;
      }
    };
  }

  private safeBodyHeaders(response: Response): Record<string, unknown> {
    try {
      const headers = response.headers;
      const fixed = (key: string, values: string[]): string => {
        const raw = headers.get(key);
        return raw === null ? 'absent' : values.includes(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : 'unknown';
      };
      const rawLength = headers.get('content-length');
      const length = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
      const type = headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      return {
        contentType: type === undefined ? 'absent' :
          ['text/turtle', 'application/ld+json', 'application/n-triples', 'application/n-quads',
            'application/trig', 'application/rdf+xml', 'application/sparql-results+json',
            'application/json', 'text/plain'].includes(type) ? type : 'unknown',
        contentLength: rawLength === null ? 'absent' : Number.isSafeInteger(length) && length >= 0 ? length : 'unknown',
        transferEncoding: fixed('transfer-encoding', ['chunked', 'identity']),
        contentEncoding: fixed('content-encoding', ['identity', 'gzip', 'br', 'deflate']),
      };
    } catch { return { bodyHeaders: 'unobserved' }; }
  }

  /** Observe original reader calls without pulling, replacing promises or copying chunks. */
  private traceRawBody(response: Response, trace: MatrixPhaseTrace, detail: Record<string, unknown>, signal?: AbortSignal | null): void {
    const startedAt = performance.now();
    let receivedBytes = 0;
    let reads = 0;
    let terminal = false;
    let aborted = false;
    let cancelled = false;
    let coverage = 'complete';
    let released = false;
    let unobserved = false;
    const emit = (phase: string, extra: Record<string, unknown> = {}): void => {
      if (phase === 'unobserved') { if (unobserved) return; unobserved = true; }
      try { this.logPhase(trace, `podFetch.stream.${phase}`, startedAt, { ...detail, receivedBytes, reads, coverage, ...extra }, true); } catch { /* diagnostics never affect consumption */ }
    };
    const abort = (): void => {
      if (!terminal && !aborted) { aborted = true; emit('callerAbort'); }
    };
    const finish = (phase: string, extra: Record<string, unknown> = {}): void => {
      if (terminal) return;
      terminal = true;
      try { signal?.removeEventListener('abort', abort); } catch { coverage = 'partial'; emit('unobserved'); }
      emit(phase, extra.transportEOS === true ? { ...extra, transportEOS: coverage === 'complete' } : extra);
    };
    const degrade = (level: 'partial' | 'unobserved'): void => {
      if (coverage !== 'unobserved') coverage = level;
      emit('unobserved');
    };
    const observe = <T>(promise: Promise<T>, done: (value: T) => void, error: (reason: unknown) => void): void => {
      try {
        const then = promise.then;
        Reflect.apply(then, promise, [
          (value: T) => { try { done(value); } catch { degrade('partial'); } },
          (reason: unknown) => { try { error(reason); } catch { degrade('partial'); } },
        ]);
      } catch { degrade('partial'); }
    };
    const hook = (target: object, key: string, value: unknown): boolean => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor && !descriptor.configurable) return false;
        Object.defineProperty(target, key, { configurable: true, writable: true,
          enumerable: descriptor?.enumerable ?? false, value });
        return true;
      } catch { return false; }
    };
    try {
      const stream = response.body;
      if (!stream) { emit('absent'); return; }
      const getReader = this.rawBodyReaders.get(stream) ?? stream.getReader;
      this.rawBodyReaders.set(stream, getReader);
      const store = this;
      if (!hook(stream, 'getReader', function(this: ReadableStream, ...args: unknown[]) {
        const reader = Reflect.apply(getReader, this, args);
        if (this !== stream) return reader;
        try {
          const read = reader.read;
          const cancel = reader.cancel;
          const release = reader.releaseLock;
          const observed = hook(reader, 'read', function(this: ReadableStreamDefaultReader, ...readArgs: unknown[]) {
          const promise = Reflect.apply(read, this, readArgs) as Promise<ReadableStreamReadResult<unknown>>;
          if (this === reader) {
            if (++reads === 1) emit('start');
            observe(promise, (result: ReadableStreamReadResult<unknown>) => {
              try {
                const done = Object.getOwnPropertyDescriptor(result, 'done')?.value;
                const value = Object.getOwnPropertyDescriptor(result, 'value')?.value;
                if (done === true) finish(aborted || cancelled ? 'doneAfterStop' : 'done', { transportEOS: !aborted && !cancelled && coverage === 'complete' });
                else if (value instanceof Uint8Array) {
                  const length = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get?.call(value);
                  if (Number.isSafeInteger(length) && length >= 0 && Number.isSafeInteger(receivedBytes + length)) receivedBytes += length;
                }
              } catch { /* observation only */ }
            }, (error: unknown) => { try { finish('error', store.errorDetail(error)); } catch { /* observation only */ } });
          }
          return promise;
        });
        if (!observed) { degrade('unobserved'); return reader; }
          const cancelObserved = hook(reader, 'cancel', function(this: ReadableStreamDefaultReader, ...cancelArgs: unknown[]) {
          const promise = Reflect.apply(cancel, this, cancelArgs) as Promise<void>;
          if (this === reader) {
            if (!cancelled) { cancelled = true; emit('cancel'); }
            observe(promise, () => finish('cancelDone'), (error: unknown) => {
              try { finish('cancelError', store.errorDetail(error)); } catch { /* observation only */ }
            });
          }
          return promise;
        });
          const releaseObserved = hook(reader, 'releaseLock', function(this: ReadableStreamDefaultReader, ...releaseArgs: unknown[]) {
          const result = Reflect.apply(release, this, releaseArgs);
          if (this === reader && !terminal && !released) { released = true; emit('release'); }
          return result;
        });
        if (!cancelObserved || !releaseObserved) degrade('partial');
        } catch { degrade('unobserved'); }
        return reader;
      })) { degrade('unobserved'); return; }
      try {
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      } catch { degrade('partial'); }
    } catch { degrade('unobserved'); }
  }

  /**
   * Observe only body methods the caller invokes. Keep the original Response,
   * native receiver, clone behavior and untouched stream; never pull or tee a
   * body for diagnostics. Raw readers are observed separately without pulling the stream.
   */
  private traceResponseBody(response: Response, trace: MatrixPhaseTrace, detail: Record<string, unknown>): Response {
    const store = this;
    let bodySequence = 0;
    const decorate = (target: Response): Response => {
      const bodyId = ++bodySequence;
      if (!Object.isExtensible(target)) return target;
      for (const method of ['arrayBuffer', 'blob', 'formData', 'json', 'text', 'bytes'] as const) {
        const original = (target as unknown as Record<string, unknown>)[method];
        if (typeof original !== 'function') continue;
        const descriptor = Object.getOwnPropertyDescriptor(target, method);
        // A custom nonconfigurable method is left alone; diagnostics must not
        // change a response's success or turn it into an instrumentation error.
        if (descriptor && !descriptor.configurable) continue;
        Object.defineProperty(target, method, {
          configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
          value: function(this: Response, ...args: unknown[]): Promise<unknown> {
            return store.runPhase(trace, `podFetch.body.${method}`, { ...detail, bodyId }, () =>
              Reflect.apply(original, this, args));
          },
        });
      }
      const clone = target.clone;
      const descriptor = Object.getOwnPropertyDescriptor(target, 'clone');
      if (typeof clone === 'function' && (!descriptor || descriptor.configurable)) {
        Object.defineProperty(target, 'clone', {
          configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
          value: function(this: Response): Response {
            // clone remains synchronous, including its native locked-body error.
            return decorate(Reflect.apply(clone, this, []));
          },
        });
      }
      return target;
    };
    return decorate(response);
  }

  private createTrace(operation: string): MatrixPhaseTrace {
    return { operation, id: randomBytes(4).toString('hex') };
  }

  /**
   * Open one operation trace around every public entry point, so internal
   * helpers inherit it and a cached fetch correlates with the call that
   * actually runs it. A nested public call (for example `recordFailure` from
   * `ensureDelivery`) keeps the enclosing operation's trace.
   */
  private wrapPublicOperations(): void {
    const target = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const operation of TRACED_PUBLIC_OPERATIONS) {
      const original = target[operation];
      target[operation] = (...args: unknown[]) => this.runOperation(operation, () => original.apply(this, args));
    }
  }

  private runOperation<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (operationTrace.getStore()) return work();
    return operationTrace.run(this.createTrace(operation), work);
  }

  /** The enclosing operation trace, or a fresh one when called standalone. */
  private currentTrace(operation: string): MatrixPhaseTrace {
    return operationTrace.getStore() ?? this.createTrace(operation);
  }

  private logPhase(trace: MatrixPhaseTrace, phase: string, startedAt: number, detail: Record<string, unknown> = {}, force = false): void {
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (!force && elapsedMs < SLOW_PHASE_MS) return;
    this.logger.warn(`[matrix-phase] ${JSON.stringify({ op: trace.operation, opId: trace.id, phase, elapsedMs, ...detail })}`);
  }

  private startPhase(trace: MatrixPhaseTrace, phase: string, startedAt: number, detail: Record<string, unknown>): void {
    this.logger.warn(`[matrix-phase] ${JSON.stringify({
      op: trace.operation, opId: trace.id, phase: `${phase}.start`, startedAtMs: startedAt, elapsedMs: 0, ...detail,
    })}`);
  }

  private async runPhase<T>(trace: MatrixPhaseTrace, phase: string, detail: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.startPhase(trace, phase, startedAt, detail);
    try {
      const value = await run();
      this.logPhase(trace, phase.startsWith('podFetch.body.') ? `${phase}.done` : phase, startedAt, detail, true);
      return value;
    } catch (error) {
      this.logPhase(trace, `${phase}.failed`, startedAt, { ...this.errorDetail(error), ...detail }, true);
      throw error;
    }
  }

  /**
   * Fixed, allowlisted projection of an error for a phase line.
   *
   * A native `TimeoutError` is a `DOMException` whose `code` is the numeric
   * prototype getter `23`; a string-only filter would omit it and make it look
   * like no code was present. Only the boolean timeout flag, `typeof code`, the
   * single allowed numeric code `23`, a signal's presence/aborted state and an
   * allowlisted `reason.name` ever leave. Messages, stacks, URLs, bodies,
   * tokens, DSNs and raw arguments are never read.
   */
  private errorDetail(error: unknown): Record<string, unknown> {
    const detail: Record<string, unknown> = {};
    const name = (error as { name?: unknown } | null | undefined)?.name;
    if (typeof name === 'string' && SAFE_ERROR_TOKEN.test(name)) detail.errorName = name;
    if (name === 'TimeoutError') detail.domTimeout = true;
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string') {
      if (SAFE_ERROR_TOKEN.test(code)) detail.code = code;
    } else if (code !== undefined) {
      detail.codeType = typeof code;
      if (typeof code === 'number' && code === DOM_TIMEOUT_CODE) detail.code = DOM_TIMEOUT_CODE;
    }
    const causeCode = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
    if (typeof causeCode === 'string' && SAFE_ERROR_TOKEN.test(causeCode)) detail.causeCode = causeCode;
    const signal = (error as { signal?: { aborted?: unknown } } | null | undefined)?.signal;
    if (signal !== null && typeof signal === 'object') {
      detail.signalPresent = true;
      detail.signalAborted = (signal as { aborted?: unknown }).aborted === true;
    }
    const reason = (error as { reason?: unknown } | null | undefined)?.reason;
    if (reason instanceof Error && SAFE_ERROR_TOKEN.test(reason.name)) detail.reasonName = reason.name;
    return detail;
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
      roomContext?: MatrixRoomContext;
    },
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord> {
    // Inherit the enclosing public operation's trace (e.g. sendEvent), so a
    // nested append reports the same op/opId rather than opening a new one.
    const trace = this.currentTrace('appendEvent');
    const eventId = input.eventId ?? this.generateEventId(context);
    const depth = 0;
    const originIso = new Date(input.originServerTs).toISOString();
    const needsRoomMetadata = input.reconcilerOwner === undefined
      || (input.type === 'm.room.message' && this.serverGroupReconcilerService !== undefined);
    const roomContext = input.roomContext
      ?? (needsRoomMetadata
        ? await this.runPhase(trace, 'appendEvent.getRoomContext', {}, () => this.getRoomContext(db, input.roomId))
        : undefined);
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
    };
    await this.runPhase(trace, 'appendEvent.db.insert', {}, () => db.insert(messageResource).values({
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
        eventId,
        roomId: input.roomId,
        eventType: input.type,
        sender: input.sender,
        senderWebId: input.maker ?? context.webId,
        originServerTs: input.originServerTs,
        depth,
        txnId: input.txnId ?? null,
        stateKey: input.stateKey ?? null,
        content: input.content,
      }),
      createdAt: originIso,
      updatedAt: originIso,
    }));

    record.depth = await this.runPhase(trace, 'journal.register', {}, () =>
      this.journal.registerEvent(this.scope(context), input.roomId, eventId));
    if (record.role === MessageRole.USER) {
      await this.runPhase(trace, 'reconcileEvent', {}, () => this.reconcileEvent(db, record, context));
    }

    return record;
  }

  private async appendMembershipEvent(
    db: Db,
    roomId: string,
    memberUserId: string,
    membership: 'invite' | 'join' | 'leave' | 'ban',
    context: MatrixStoreContext,
    options: { sender?: string; reconcilerOwner?: ReconcilerOwner } = {},
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
    }, context);
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
    options: {
      sinceTs?: number;
      beforeOrAtTs?: number;
      limit?: number;
      newestFirst?: boolean;
    } = {},
    parent?: MatrixPhaseTrace,
  ): Promise<MatrixEventRecord[]> {
    const trace = parent ?? this.currentTrace('listEvents');
    const sources = await this.runPhase(trace, 'events.select', {}, async () =>
      await db.select().from(messageResource)
        .where(eq(messageResource.thread, this.threadIri(roomId, context))) as MatrixEventSource[]);
    sources.sort((a,b) => (this.isoToMillis(a.createdAt) ?? 0) - (this.isoToMillis(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
    const events = await this.runPhase(trace, 'journal.register', { count: sources.length }, async () => {
      const records: MatrixEventRecord[] = [];
      for (const source of sources) {
        const event = this.eventSourceToRecord(source, roomId, context);
        event.depth = await this.journal.registerEvent(this.scope(context), roomId, event.eventId);
        records.push(event);
      }
      return records;
    });
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
    const content = this.parseJsonObject(matrix.content as JsonObjectSource)
      ?? this.parseJsonObject(metadata.content as JsonObjectSource)
      ?? {msgtype: 'm.text', body: typeof source.content === 'string' ? source.content : JSON.stringify(source.content ?? '')};
    const unsigned = this.parseJsonObject(matrix.unsigned as JsonObjectSource)
      ?? this.parseJsonObject(metadata.unsigned as JsonObjectSource);
    const stateKey = this.stringValue(matrix.stateKey ?? matrix.state_key ?? metadata.stateKey);
    const txnId = this.stringValue(matrix.txnId ?? matrix.txn_id ?? metadata.txnId);
    return {
      eventId: this.stringValue(matrix.eventId ?? matrix.event_id ?? metadata.eventId) ?? `$${this.hash(source.id)}:${this.getServerName(context)}`,
      roomId: this.stringValue(matrix.roomId ?? matrix.room_id ?? metadata.roomId) ?? roomId,
      type: this.stringValue(matrix.eventType ?? matrix.event_type ?? metadata.eventType) ?? 'm.room.message',
      sender: this.stringValue(matrix.sender ?? metadata.sender) ?? this.getMatrixUserId({...context, webId: source.maker ?? context.webId}),
      senderWebId: this.stringValue(matrix.senderWebId ?? matrix.sender_web_id ?? metadata.senderWebId) ?? source.maker ?? undefined,
      originServerTs: this.numberValue(matrix.originServerTs ?? matrix.origin_server_ts ?? metadata.originServerTs) ?? this.isoToMillis(source.createdAt) ?? Date.now(),
      depth: this.numberValue(matrix.depth ?? metadata.depth),
      role: source.role,
      resourceId: source.id,
      txnId: txnId ?? undefined,
      content,
      stateKey: stateKey ?? undefined,
      unsigned,
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
    return chatResource.buildIri(this.scope(context), {id:this.surfaceIdFromRoomId(roomId)});
  }

  private threadIri(roomId: string, context: MatrixStoreContext): string {
    return threadResource.buildIri(this.scope(context), {id:'thread',parent:this.chatIri(roomId,context)});
  }

  private async roomSource(db: Db, roomId: string): Promise<MatrixRoomSource> {
    const room = await db.findById(chatResource,this.chatResourceIdFromRoomId(roomId)) as MatrixRoomSource | undefined;
    if (!room) throw new MatrixError(404,'M_NOT_FOUND','Room not found');
    return room;
  }

  private async requireRoomOwner(db: Db, roomId: string, context: MatrixStoreContext): Promise<void> {
    if ((await this.roomSource(db,roomId)).author !== context.webId) throw new MatrixError(403,'M_FORBIDDEN','Room owner authority is required');
  }

  private async requireJoined(db: Db, roomId: string, context: MatrixStoreContext, events?: MatrixEventRecord[], room?: MatrixRoomSource): Promise<void> {
    const loaded = room ?? await this.roomSource(db,roomId);
    const state = events ? this.latestState(events,'m.room.member',this.getMatrixUserId(context)) : await this.findLatestStateEvent(db,roomId,'m.room.member',this.getMatrixUserId(context),context);
    if (state?.content.membership === 'join' || (!state && loaded.author === context.webId)) return;
    throw new MatrixError(403,'M_FORBIDDEN','Join the room before accessing its timeline');
  }

  private latestState(events: MatrixEventRecord[], type: string, key: string): MatrixEventRecord | undefined {
    return [...events].reverse().find(e=>e.type===type && e.stateKey===key);
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
    const state = events ? this.latestState(events,'co.undefineds.agents','') : await this.findLatestStateEvent(db,roomId,'co.undefineds.agents','',context);
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

  private async reconcileEvent(db: Db, event: MatrixEventRecord, context: MatrixStoreContext, events?: MatrixEventRecord[]): Promise<void> {
    if (!this.serverGroupReconcilerService || event.type !== 'm.room.message' || event.role !== MessageRole.USER) return;
    const actor = event.senderWebId;
    if (!actor) return;
    const receipt = await this.journal.findReservation(this.scope(context),event.eventId);
    if (!receipt || receipt.contentHash !== this.hash(this.canonicalJson(['user',actor,event.type,event.content]))) return;
    const targets = await this.authorizeTargets(db,event.roomId,event.content,{...context,webId:actor},events);
    const pending: string[] = [];
    for (const target of targets) if (await this.ensureDelivery(db,event,target,context)) pending.push(target);
    if (!pending.length) return;
    const room = await this.roomSource(db,event.roomId);
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
    for (const event of events) {
      if (event.role === MessageRole.USER) {
        try { await this.reconcileEvent(db,event,context,events); }
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
    const reservation = await this.journal.reserveTransaction(this.scope(context),key,{
      eventId:`$${this.hash(key)}:${this.getServerName(context)}`,createdAt:Date.now(),contentHash});
    if (reservation.contentHash !== contentHash) throw new MatrixError(409,'M_CONFLICT','A different result was already reserved for this wake');
    let output = events.find(e=>e.eventId===reservation.eventId);
    if (!output) {
      output = await this.appendEvent(db,{roomId,type:'m.room.message',sender:this.getMatrixUserId({...context,webId:job.agent}),
        maker:job.agent,role:MessageRole.ASSISTANT,eventId:reservation.eventId,originServerTs:reservation.createdAt,content},context);
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
    const resultEventId = `$${this.hash(JSON.stringify(['wake-result',jobId]))}:${this.getServerName(context)}`;
    const receipt = await this.journal.findReservation(this.scope(context),resultEventId);
    if (receipt) {
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

  private async getRoomContext(db: Db, roomId: string): Promise<MatrixRoomContext> {
    const room = await db.findById(chatResource, this.chatResourceIdFromRoomId(roomId)) as MatrixRoomSource | null;
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

  private getMatrixUserId(context: MatrixStoreContext): string {
    const serverName = this.getServerName(context);
    const localpart = `u_${this.hash(context.webId)}`;
    return `@${localpart}:${serverName}`;
  }

  private getServerName(context: MatrixStoreContext): string {
    if (this.serverName) {
      return this.serverName;
    }
    try {
      return new URL(context.webId).host || 'localhost';
    } catch {
      return 'localhost';
    }
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
    return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
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
