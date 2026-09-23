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
  private readonly serverName?: string;
  private readonly serverGroupReconcilerService?: ServerGroupReconcilerService;

  public constructor(options: PodMatrixStoreOptions) {
    this.serverName = options.serverName;
    this.podAccess = options.podAccess;
    this.journal = options.journal ?? new InMemoryMatrixEventJournal();
    this.serverGroupReconcilerService = options.serverGroupReconcilerService;
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
    const room = await this.roomSource(db, roomId, context);
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
    const db = await this.getDb(context);
    // Membership and grant checks share one timeline read; each extra read is a
    // full Pod document fetch with its own authorization cost.
    const events = await this.listEvents(db, roomId, context);
    await this.requireJoined(db, roomId, context, events);
    if (eventType !== 'm.room.message') throw new MatrixError(400, 'M_UNRECOGNIZED', 'Only m.room.message timeline events are supported');
    await this.authorizeTargets(db, roomId, content, context, events);
    const reservation = await this.journal.reserveTransaction(this.scope(context),
      JSON.stringify([this.deviceId(context), roomId, eventType, txnId]), {
        eventId: this.generateEventId(context), createdAt: Date.now(), contentHash: this.hash(this.canonicalJson(['user',context.webId,eventType,content])),
      });
    if (reservation.contentHash !== this.hash(this.canonicalJson(['user',context.webId,eventType,content]))) {
      throw new MatrixError(409, 'M_CONFLICT', 'Transaction already reserved with different content');
    }
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
    return this.appendEvent(db, { roomId, type: eventType, sender: this.getMatrixUserId(context), txnId,
      eventId: reservation.eventId, originServerTs: reservation.createdAt, content }, context);
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
    let result: MatrixSyncResponse;
    // First pass indexes native Pod writes; the second reads a committed journal watermark.
    await this.syncOnce(context, options);
    do {
      result = await this.syncOnce(context, options);
      if (Object.values(result.rooms.join).some(room => room.timeline.events.length)
        || Object.keys(result.rooms.invite ?? {}).length || Date.now() >= deadline || options.signal?.aborted) return result;
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(500, Math.max(0, deadline - Date.now())));
        options.signal?.addEventListener('abort', done, { once: true });
      });
    } while (!options.signal?.aborted);
    return result;
  }

  private async syncOnce(context: MatrixStoreContext, options: { since?: string; limit?: number }): Promise<MatrixSyncResponse> {
    const db = await this.getDb(context);
    const since = this.parseSyncToken(options.since);
    const snapshot = await this.journal.getHighWatermark(this.scope(context));
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
    const join: MatrixSyncResponse['rooms']['join'] = {};
    const invite: NonNullable<MatrixSyncResponse['rooms']['invite']> = {};
    const leave: NonNullable<MatrixSyncResponse['rooms']['leave']> = {};
    const batches: Array<{room: MatrixRoomRecord; events: MatrixEventRecord[]}> = [];
    for (const room of await this.listRooms(db)) {
      const events = (await this.listEvents(db, room.roomId, context)).filter(e=>e.depth! <= snapshot);
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
    },
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord> {
    const eventId = input.eventId ?? this.generateEventId(context);
    const depth = 0;
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
    });

    record.depth = await this.journal.registerEvent(this.scope(context), input.roomId, eventId);
    if (record.role === MessageRole.USER) await this.reconcileEvent(db, record, context);

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
  ): Promise<MatrixEventRecord[]> {
    const sources = await db.select().from(messageResource)
      .where(eq(messageResource.thread, this.threadIri(roomId, context))) as MatrixEventSource[];
    sources.sort((a,b) => (this.isoToMillis(a.createdAt) ?? 0) - (this.isoToMillis(b.createdAt) ?? 0) || a.id.localeCompare(b.id));
    const events: MatrixEventRecord[] = [];
    for (const source of sources) {
      const event = this.eventSourceToRecord(source, roomId, context);
      event.depth = await this.journal.registerEvent(this.scope(context), roomId, event.eventId);
      events.push(event);
    }
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
    const state = events ? this.latestState(events,'m.room.member',this.getMatrixUserId(context)) : await this.findLatestStateEvent(db,roomId,'m.room.member',this.getMatrixUserId(context),context);
    if (state?.content.membership === 'join' || (!state && room.author === context.webId)) return;
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
