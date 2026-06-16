import { createHash, randomBytes } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import { and, desc, drizzle, eq, gt, lte } from '@undefineds.co/drizzle-solid';
import {
  chatResource,
  messageResource,
  MessageRole,
  MessageStatus,
  threadResource,
} from '@undefineds.co/models';
import {
  normalizeAgentUris,
  normalizeReconcilerOwner,
  reconcilerCoordinationMetadata,
  type ReconcilerOwner,
  type ServerGroupReconcilerService,
} from '../reconciler';
import { getProtocolMetadata, withProtocolMetadata } from '../protocol-metadata';
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
};

export interface PodMatrixStoreOptions {
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
  mentions?: string[] | null;
  routeTargetAgent?: string | null;
  createdAt?: string | Date | null;
  metadata?: JsonObjectSource;
}

interface MatrixRoomContext {
  metadata?: Record<string, unknown>;
  participants: string[];
}

export class PodMatrixStore {
  private readonly logger = getLoggerFor(this);
  private readonly serverName?: string;
  private readonly serverGroupReconcilerService?: ServerGroupReconcilerService;

  public constructor(options: PodMatrixStoreOptions) {
    this.serverName = options.serverName;
    this.serverGroupReconcilerService = options.serverGroupReconcilerService;
  }

  public async getAccount(context: MatrixStoreContext): Promise<MatrixAccountInfo> {
    const matrixUserId = this.getMatrixUserId(context);
    return {
      userId: matrixUserId,
      deviceId: this.deviceIdFromUserId(context.webId),
      displayName: this.displayNameFromUserId(matrixUserId),
    };
  }

  public async createRoom(input: MatrixCreateRoomRequest, context: MatrixStoreContext): Promise<MatrixRoomRecord> {
    const db = await this.getDb(context);
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
      parent: this.chatParentRefFromRoomId(roomId),
      title: input.name ?? roomId,
      status: 'active',
      metadata: withProtocolMetadata({
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
    await this.ensureRoomExists(db, roomId);

    const sender = this.getMatrixUserId(context);
    const existing = await this.findLatestStateEvent(db, roomId, 'm.room.member', sender, context);
    if (existing?.content.membership !== 'join') {
      await this.appendMembershipEvent(db, roomId, sender, 'join', context);
    }

    return { roomId };
  }

  public async inviteUser(roomId: string, userId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    await this.ensureRoomExists(db, roomId);
    await this.appendMembershipEvent(db, roomId, userId, 'invite', context);
  }

  public async leaveRoom(roomId: string, context: MatrixStoreContext): Promise<void> {
    const db = await this.getDb(context);
    await this.ensureRoomExists(db, roomId);
    await this.appendMembershipEvent(db, roomId, this.getMatrixUserId(context), 'leave', context);
  }

  public async sendEvent(
    roomId: string,
    eventType: string,
    txnId: string,
    content: MatrixSendEventRequest,
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord> {
    const db = await this.getDb(context);
    await this.ensureRoomExists(db, roomId);

    const existing = await this.findEventByTxnId(db, roomId, txnId, context);
    if (existing) {
      return existing;
    }

    const sender = this.getMatrixUserId(context);
    const event = await this.appendEvent(db, {
      roomId,
      type: eventType,
      sender,
      txnId,
      originServerTs: Date.now(),
      content,
    }, context);

    return event;
  }

  public async setState(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord> {
    const db = await this.getDb(context);
    await this.ensureRoomExists(db, roomId);
    return this.appendEvent(db, {
      roomId,
      type: eventType,
      sender: this.getMatrixUserId(context),
      stateKey,
      originServerTs: Date.now(),
      content,
    }, context);
  }

  public async sync(context: MatrixStoreContext, options: { since?: string; limit?: number } = {}): Promise<MatrixSyncResponse> {
    const db = await this.getDb(context);
    const rooms = await this.listJoinedRoomRecords(db, context);
    const sinceTs = this.parseSyncToken(options.since);
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    const join: MatrixSyncResponse['rooms']['join'] = {};

    for (const room of rooms) {
      const events = await this.listEvents(db, room.roomId, context, {
        sinceTs,
        limit,
      });
      join[room.roomId] = {
        state: {
          events: events.filter((event) => event.stateKey !== undefined).map((event) => this.toClientEvent(event)),
        },
        timeline: {
          events: events.map((event) => this.toClientEvent(event)),
          limited: false,
        },
        'co.undefineds.coordination': {
          reconcilerOwner: room.reconcilerOwner,
        },
      };
    }

    return {
      next_batch: this.encodeSyncToken(Date.now()),
      rooms: { join },
    };
  }

  public async listJoinedRooms(context: MatrixStoreContext): Promise<string[]> {
    const db = await this.getDb(context);
    return (await this.listJoinedRoomRecords(db, context)).map((room) => room.roomId);
  }

  public async getMembers(roomId: string, context: MatrixStoreContext): Promise<MatrixClientEvent[]> {
    const db = await this.getDb(context);
    await this.ensureRoomExists(db, roomId);
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

  public async listMessages(
    roomId: string,
    context: MatrixStoreContext,
    options: { limit?: number; dir?: 'b' | 'f'; from?: string } = {},
  ): Promise<{ chunk: MatrixClientEvent[]; start?: string; end: string }> {
    const db = await this.getDb(context);
    await this.ensureRoomExists(db, roomId);
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    const fromTs = this.parseSyncToken(options.from);
    const forward = options.dir === 'f';
    const events = await this.listEvents(db, roomId, context, {
      sinceTs: forward && fromTs > 0 ? fromTs : undefined,
      beforeOrAtTs: !forward && fromTs > 0 ? fromTs : undefined,
      limit,
      newestFirst: !forward,
    });
    const chunk = events.slice(0, limit).map((event) => this.toClientEvent(event));
    return {
      chunk,
      start: options.from,
      end: this.encodeSyncToken(chunk.length ? chunk[chunk.length - 1].origin_server_ts : Date.now()),
    };
  }

  public async getEvent(roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixClientEvent> {
    const db = await this.getDb(context);
    const event = await this.findEventById(db, roomId, eventId, context);
    if (!event) {
      throw new Error(`Matrix event not found: ${eventId}`);
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
    const event = await this.findLatestStateEvent(db, roomId, eventType, stateKey, context);
    if (!event) {
      throw new Error(`Matrix state not found: ${eventType}/${stateKey}`);
    }
    return event.content;
  }

  private async getDb(context: MatrixStoreContext): Promise<Db> {
    if ((context as any)._matrixDb) {
      return (context as any)._matrixDb;
    }

    const auth = context.auth as AuthContext | undefined;
    if (!auth || !isSolidAuth(auth) || !auth.accessToken || !auth.webId) {
      throw new Error('Matrix API requires Solid access-token authentication');
    }

    const db: Db = drizzle(
      {
        fetch: this.createAccessTokenFetch(auth.accessToken, auth.tokenType),
        info: { webId: auth.webId, isLoggedIn: true },
      } as any,
      { schema },
    );
    await db.init(
      chatResource,
      threadResource,
      messageResource,
    );
    (context as any)._matrixDb = db;
    return db;
  }

  private createAccessTokenFetch(accessToken: string, tokenType?: 'Bearer' | 'DPoP'): typeof fetch {
    const scheme = tokenType ?? 'Bearer';
    return async (input, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `${scheme} ${accessToken}`);
      }
      return fetch(input, { ...init, headers });
    };
  }

  private async ensureRoomExists(db: Db, roomId: string): Promise<void> {
    const room = await db.findById(chatResource, this.chatResourceIdFromRoomId(roomId));
    if (!room) {
      throw new Error(`Matrix room not found: ${roomId}`);
    }
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
    },
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord> {
    const eventId = this.generateEventId(context);
    const depth = await this.nextEventDepth(db, input.roomId, context);
    const originIso = new Date(input.originServerTs).toISOString();
    const needsRoomMetadata = input.reconcilerOwner === undefined
      || (input.type === 'm.room.message' && this.serverGroupReconcilerService !== undefined);
    const roomContext = needsRoomMetadata ? await this.getRoomContext(db, input.roomId) : undefined;
    const roomMetadata = roomContext?.metadata;
    const reconcilerOwner = input.reconcilerOwner ?? this.reconcilerOwnerFromRoomMetadata(roomMetadata);
    const coordination = reconcilerCoordinationMetadata(reconcilerOwner);
    const messageResourceId = this.messageResourceIdFromEvent(input.roomId, eventId, input.originServerTs);
    const thread = this.resolveDataResourceUriFromId(this.threadResourceIdFromRoomId(input.roomId), context);
    const contentText = this.messageContentFromMatrixEvent(input.type, input.content);
    const mentions = this.mentionsFromMatrixContent(input.content);
    const routeTargetAgent = this.routeTargetAgentFromMatrixContent(input.content);
    const record = {
      eventId,
      roomId: input.roomId,
      type: input.type,
      sender: input.sender,
      senderWebId: context.webId,
      originServerTs: input.originServerTs,
      depth,
      txnId: input.txnId ?? undefined,
      stateKey: input.stateKey ?? undefined,
      content: input.content,
      createdAt: originIso,
    };
    await db.insert(messageResource).values({
      id: messageResourceId,
      parent: this.resolveDataResourceUriFromId(this.messageParentResourceIdFromRoomId(input.roomId), context),
      chat: this.chatResourceIdFromRoomId(input.roomId),
      thread,
      maker: context.webId,
      role: input.type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM,
      content: contentText,
      status: MessageStatus.SENT,
      mentions,
      routeTargetAgent: routeTargetAgent ?? null,
      metadata: withProtocolMetadata({
        protocol: 'matrix',
        commandKind: 'chat',
        surface_id: this.surfaceIdFromRoomId(input.roomId),
        ...coordination,
      }, 'matrix', {
        eventId,
        roomId: input.roomId,
        eventType: input.type,
        sender: input.sender,
        senderWebId: context.webId,
        originServerTs: input.originServerTs,
        depth,
        txnId: input.txnId ?? null,
        stateKey: input.stateKey ?? null,
        content: input.content,
      }),
      createdAt: originIso,
      updatedAt: originIso,
    });

    await this.reconcileGroupUserMessage({
      thread,
      triggerMessage: this.resolveDataResourceUriFromId(messageResourceId, context),
      actor: context.webId,
      role: input.type === 'm.room.message' ? MessageRole.USER : MessageRole.SYSTEM,
      content: contentText,
      reconcilerOwner,
      mentions,
      routeTargetAgent,
      participants: roomContext?.participants,
    });

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
      if (!membership || membership.content.membership === 'join' || membership.content.membership === 'invite') {
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
      throw new Error(`Matrix room alias not found: ${roomIdOrAlias}`);
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
    const conditions = [
      eq(messageResource.thread, this.resolveDataResourceUriFromId(this.threadResourceIdFromRoomId(roomId), context)),
      options.sinceTs !== undefined ? gt(messageResource.createdAt, new Date(options.sinceTs).toISOString()) : undefined,
      options.beforeOrAtTs !== undefined ? lte(messageResource.createdAt, new Date(options.beforeOrAtTs).toISOString()) : undefined,
    ];
    let query = db.select().from(messageResource).where(and(...conditions));
    query = options.newestFirst
      ? query.orderBy(desc(messageResource.createdAt as any))
      : query.orderBy(messageResource.createdAt as any);
    if (options.limit && options.limit > 0) {
      query = query.limit(options.limit);
    }
    const events = await query as MatrixEventSource[];
    return events.map((event) => this.eventSourceToRecord(event));
  }

  private async findEventByTxnId(db: Db, roomId: string, txnId: string, context: MatrixStoreContext): Promise<MatrixEventRecord | undefined> {
    const records = await this.listEvents(db, roomId, context);
    return records.find((record) => record.txnId === txnId);
  }

  private async findEventById(db: Db, roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixEventRecord | undefined> {
    const records = await this.listEvents(db, roomId, context);
    return records.find((record) => record.eventId === eventId);
  }

  private async nextEventDepth(db: Db, roomId: string, context: MatrixStoreContext): Promise<number> {
    const records = await this.listEvents(db, roomId, context);
    return records.reduce((max, record) => Math.max(max, record.depth ?? 0), 0) + 1;
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

  private eventSourceToRecord(source: MatrixEventSource): MatrixEventRecord {
    const metadata = this.parseJsonObject(source.metadata) ?? {};
    const matrix = getProtocolMetadata(metadata, 'matrix') ?? {};
    const content = this.parseJsonObject(matrix.content as JsonObjectSource)
      ?? this.parseJsonObject(metadata.content as JsonObjectSource)
      ?? this.parseJsonObject(source.content)
      ?? {};
    const unsigned = this.parseJsonObject(matrix.unsigned as JsonObjectSource)
      ?? this.parseJsonObject(metadata.unsigned as JsonObjectSource);
    const stateKey = this.stringValue(matrix.stateKey ?? matrix.state_key ?? metadata.stateKey);
    const txnId = this.stringValue(matrix.txnId ?? matrix.txn_id ?? metadata.txnId);
    return {
      eventId: this.stringValue(matrix.eventId ?? matrix.event_id ?? metadata.eventId) ?? source.id,
      roomId: this.stringValue(matrix.roomId ?? matrix.room_id ?? metadata.roomId) ?? '',
      type: this.stringValue(matrix.eventType ?? matrix.event_type ?? metadata.eventType) ?? 'm.room.message',
      sender: this.stringValue(matrix.sender ?? metadata.sender) ?? '',
      senderWebId: this.stringValue(matrix.senderWebId ?? matrix.sender_web_id ?? metadata.senderWebId) ?? source.maker ?? undefined,
      originServerTs: this.numberValue(matrix.originServerTs ?? matrix.origin_server_ts ?? metadata.originServerTs) ?? this.isoToMillis(source.createdAt) ?? Date.now(),
      depth: this.numberValue(matrix.depth ?? metadata.depth),
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
        reconcilerOwner: input.reconcilerOwner,
        mentions: input.mentions,
        routeTargetAgent: input.routeTargetAgent,
        participants: input.participants,
      });
    } catch (error) {
      this.logger.warn(`Failed to enqueue Matrix group Reconciler wake: ${error}`);
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
    const localpart = this.localpartFromUserId(context.webId);
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

  private localpartFromUserId(userId: string): string {
    try {
      const url = new URL(userId);
      const withoutHash = `${url.pathname}${url.hash}`.replace(/^\/+/, '');
      return this.slug(withoutHash || url.host);
    } catch {
      return this.slug(userId);
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

  private deviceIdFromUserId(userId: string): string {
    return `XPOD${createHash('sha256').update(userId).digest('hex').slice(0, 12).toUpperCase()}`;
  }

  private randomId(size: number): string {
    return randomBytes(size).toString('base64url');
  }

  private slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9._=-]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
  }

  private surfaceIdFromRoomId(roomId: string): string {
    return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
  }

  private chatResourceIdFromRoomId(roomId: string): string {
    return `${this.surfaceIdFromRoomId(roomId)}/index.ttl#this`;
  }

  private messageParentResourceIdFromRoomId(roomId: string): string {
    return `chat/${this.surfaceIdFromRoomId(roomId)}/index.ttl#this`;
  }

  private threadResourceIdFromRoomId(roomId: string): string {
    return `chat/${this.surfaceIdFromRoomId(roomId)}/index.ttl#thread`;
  }

  private chatParentRefFromRoomId(roomId: string): string {
    return `/.data/chat/${this.chatResourceIdFromRoomId(roomId)}`;
  }

  private messageResourceIdFromEvent(roomId: string, eventId: string, ts: number): string {
    const { yyyy, MM, dd } = this.dateParts(ts);
    return `chat/${this.surfaceIdFromRoomId(roomId)}/${yyyy}/${MM}/${dd}/messages.ttl#${this.slug(eventId)}`;
  }

  private resolveDataResourceUriFromId(resourceId: string, context: MatrixStoreContext): string {
    const podBaseUrl = this.derivePodBaseUrl(context.webId);
    if (!podBaseUrl) {
      return resourceId;
    }
    return `${podBaseUrl.replace(/\/$/, '')}/.data/${resourceId}`;
  }

  private derivePodBaseUrl(webId: string | undefined): string | undefined {
    if (!webId) {
      return undefined;
    }
    try {
      const url = new URL(webId);
      url.hash = '';
      url.search = '';
      const normalizedPath = url.pathname.replace(/\/+$/, '');
      if (!normalizedPath.endsWith('/profile/card')) {
        return url.origin;
      }
      url.pathname = normalizedPath.slice(0, -'/profile/card'.length) || '/';
      return url.toString().replace(/\/$/, '');
    } catch {
      return undefined;
    }
  }

  private dateParts(value: number): { yyyy: string; MM: string; dd: string } {
    const date = new Date(value);
    return {
      yyyy: String(date.getUTCFullYear()),
      MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
      dd: String(date.getUTCDate()).padStart(2, '0'),
    };
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
    return `s${Math.max(0, Math.floor(ts))}`;
  }

  private parseSyncToken(token: string | undefined): number {
    if (!token) {
      return 0;
    }
    const parsed = Number(token.replace(/^s/, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
