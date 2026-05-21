import { createHash, randomBytes } from 'node:crypto';
import { and, desc, drizzle, eq, gt, lte } from '@undefineds.co/drizzle-solid';
import {
  chatResource,
  matrixAccountResource,
  matrixEventResource,
  matrixRoomResource,
  messageResource,
  MatrixRoomVisibility,
  MessageRole,
  MessageStatus,
  threadResource,
} from '@undefineds.co/models';
import { getWebId, isSolidAuth, type AuthContext } from '../auth/AuthContext';
import type {
  MatrixClientEvent,
  MatrixCreateRoomRequest,
  MatrixEventRecord,
  MatrixRoomRecord,
  MatrixSendEventRequest,
  MatrixStoreContext,
  MatrixSyncResponse,
} from './types';

const schema = {
  matrixAccount: matrixAccountResource,
  matrixRoom: matrixRoomResource,
  matrixEvent: matrixEventResource,
  chat: chatResource,
  thread: threadResource,
  message: messageResource,
};

export interface PodMatrixStoreOptions {
  serverName?: string;
}

type Db = any;
type JsonObjectSource = string | Record<string, unknown> | null | undefined;

interface MatrixRoomSource {
  id: string;
  matrixRoomId?: string | null;
  name?: string | null;
  topic?: string | null;
  creator?: string | null;
  createdAt?: string | Date | null;
  metadata?: JsonObjectSource;
}

interface MatrixEventSource {
  id: string;
  matrixEventId?: string | null;
  matrixRoomId?: string | null;
  type?: string | null;
  sender?: string | null;
  senderWebId?: string | null;
  originServerTs?: number | null;
  depth?: number | null;
  content?: JsonObjectSource;
  stateKey?: string | null;
  unsigned?: JsonObjectSource;
  createdAt?: string | Date | null;
}

export class PodMatrixStore {
  private readonly serverName?: string;

  public constructor(options: PodMatrixStoreOptions) {
    this.serverName = options.serverName;
  }

  public async createRoom(input: MatrixCreateRoomRequest, context: MatrixStoreContext): Promise<MatrixRoomRecord> {
    const db = await this.getDb(context);
    const sender = this.getMatrixUserId(context);
    const now = Date.now();
    const roomId = this.generateRoomId(context);
    const chatId = this.chatResourceIdFromRoomId(roomId);
    const threadId = this.threadResourceIdFromRoomId(roomId);

    await this.ensureMatrixAccount(db, context);
    await db.insert(chatResource).values({
      id: chatId,
      title: input.name ?? roomId,
      description: input.topic ?? null,
      author: context.userId,
      status: 'active',
      metadata: { protocol: 'matrix', roomId },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await db.insert(threadResource).values({
      id: threadId,
      commandKind: 'chat',
      surfaceId: this.surfaceIdFromRoomId(roomId),
      chat: chatId,
      title: input.name ?? roomId,
      status: 'active',
      metadata: { protocol: 'matrix', roomId },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    await db.insert(matrixRoomResource).values({
      id: this.roomResourceId(roomId),
      matrixRoomId: roomId,
      canonicalAlias: input.room_alias_name ? `#${input.room_alias_name}:${this.getServerName(context)}` : null,
      name: input.name ?? null,
      topic: input.topic ?? null,
      creator: context.userId,
      visibility: input.visibility === 'public' ? MatrixRoomVisibility.PUBLIC : MatrixRoomVisibility.PRIVATE,
      roomVersion: String(input.creation_content?.room_version ?? '11'),
      federate: input.creation_content?.['m.federate'] === true,
      chat: chatId,
      members: [context.userId],
      metadata: {
        preset: input.preset,
        is_direct: input.is_direct,
        invite: input.invite ?? [],
      },
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    await this.appendEvent(db, {
      roomId,
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
        type: state.type,
        sender,
        originServerTs: Date.now(),
        stateKey: state.state_key ?? '',
        content: state.content ?? {},
      }, context);
    }

    return {
      roomId,
      name: input.name,
      topic: input.topic,
      creator: sender,
      createdAt: now,
    };
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
    await this.ensureMatrixAccount(db, context);

    const existing = await this.findEventByTxnId(db, roomId, txnId);
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

    if (eventType === 'm.room.message') {
      await db.insert(messageResource).values({
        id: this.messageResourceIdFromEvent(roomId, event.eventId, event.originServerTs),
        commandKind: 'chat',
        surfaceId: this.surfaceIdFromRoomId(roomId),
        chat: this.chatResourceIdFromRoomId(roomId),
        thread: this.resolveDataResourceUriFromId(this.threadResourceIdFromRoomId(roomId), context),
        maker: context.userId,
        role: MessageRole.USER,
        content: typeof content.body === 'string' ? content.body : JSON.stringify(content),
        status: MessageStatus.SENT,
        metadata: {
          protocol: 'matrix',
          roomId,
          eventId: event.eventId,
          eventType,
          msgtype: content.msgtype,
        },
        createdAt: new Date(event.originServerTs).toISOString(),
      });
    }

    return event;
  }

  public async sync(context: MatrixStoreContext, options: { since?: string; limit?: number } = {}): Promise<MatrixSyncResponse> {
    const db = await this.getDb(context);
    const rooms = await this.listRooms(db);
    const sinceTs = this.parseSyncToken(options.since);
    const limit = options.limit && options.limit > 0 ? options.limit : 50;
    const join: MatrixSyncResponse['rooms']['join'] = {};

    for (const room of rooms) {
      const events = await this.listEvents(db, room.roomId, {
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
      };
    }

    return {
      next_batch: this.encodeSyncToken(Date.now()),
      rooms: { join },
    };
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
    const events = await this.listEvents(db, roomId, {
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
    const event = await this.findEventById(db, roomId, eventId);
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
    const event = await this.findLatestStateEvent(db, roomId, eventType, stateKey);
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
      matrixAccountResource,
      matrixRoomResource,
      matrixEventResource,
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

  private async ensureMatrixAccount(db: Db, context: MatrixStoreContext): Promise<void> {
    const matrixUserId = this.getMatrixUserId(context);
    const accountId = this.accountResourceId(matrixUserId);
    const existing = await db.findById(matrixAccountResource, accountId);
    if (existing) {
      return;
    }
    await db.insert(matrixAccountResource).values({
      id: accountId,
      matrixUserId,
      webId: context.userId,
      displayName: this.displayNameFromUserId(matrixUserId),
      metadata: { serverName: this.getServerName(context) },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  private async ensureRoomExists(db: Db, roomId: string): Promise<void> {
    const room = await db.findById(matrixRoomResource, this.roomResourceId(roomId));
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
    },
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord> {
    const eventId = this.generateEventId(context);
    const depth = await this.nextEventDepth(db, input.roomId);
    const record = {
      id: this.eventResourceId(input.roomId, eventId, input.originServerTs),
      matrixEventId: eventId,
      matrixRoomId: input.roomId,
      room: this.roomResourceId(input.roomId),
      type: input.type,
      sender: input.sender,
      senderWebId: context.userId,
      originServerTs: input.originServerTs,
      depth,
      txnId: input.txnId ?? null,
      stateKey: input.stateKey ?? null,
      content: input.content,
      createdAt: new Date(input.originServerTs).toISOString(),
    };
    await db.insert(matrixEventResource).values(record);
    return this.eventSourceToRecord(record);
  }

  private async listRooms(db: Db): Promise<MatrixRoomRecord[]> {
    const rooms = await db.select().from(matrixRoomResource) as MatrixRoomSource[];
    return rooms.map((room) => ({
      roomId: room.matrixRoomId ?? this.roomIdFromResourceId(room.id),
      name: room.name ?? undefined,
      topic: room.topic ?? undefined,
      creator: room.creator ?? '',
      createdAt: this.isoToMillis(room.createdAt) ?? 0,
    }));
  }

  private async listEvents(
    db: Db,
    roomId: string,
    options: {
      sinceTs?: number;
      beforeOrAtTs?: number;
      limit?: number;
      newestFirst?: boolean;
    } = {},
  ): Promise<MatrixEventRecord[]> {
    const conditions = [
      eq(matrixEventResource.matrixRoomId, roomId),
      options.sinceTs !== undefined ? gt(matrixEventResource.originServerTs, options.sinceTs) : undefined,
      options.beforeOrAtTs !== undefined ? lte(matrixEventResource.originServerTs, options.beforeOrAtTs) : undefined,
    ];
    let query = db.select().from(matrixEventResource).where(and(...conditions));
    query = options.newestFirst
      ? query.orderBy(desc(matrixEventResource.originServerTs as any))
      : query.orderBy(matrixEventResource.originServerTs as any);
    if (options.limit && options.limit > 0) {
      query = query.limit(options.limit);
    }
    const events = await query as MatrixEventSource[];
    return events.map((event) => this.eventSourceToRecord(event));
  }

  private async findEventByTxnId(db: Db, roomId: string, txnId: string): Promise<MatrixEventRecord | undefined> {
    const records = await db.select()
      .from(matrixEventResource)
      .where(and(eq(matrixEventResource.matrixRoomId, roomId), eq(matrixEventResource.txnId, txnId))) as MatrixEventSource[];
    const record = records[0];
    return record ? this.eventSourceToRecord(record) : undefined;
  }

  private async findEventById(db: Db, roomId: string, eventId: string): Promise<MatrixEventRecord | undefined> {
    const records = await db.select()
      .from(matrixEventResource)
      .where(and(
        eq(matrixEventResource.matrixRoomId, roomId),
        eq(matrixEventResource.matrixEventId, eventId),
      ))
      .limit(1) as MatrixEventSource[];
    const record = records[0];
    return record ? this.eventSourceToRecord(record) : undefined;
  }

  private async nextEventDepth(db: Db, roomId: string): Promise<number> {
    const records = await db.select()
      .from(matrixEventResource)
      .where(eq(matrixEventResource.matrixRoomId, roomId))
      .orderBy(desc(matrixEventResource.depth as any))
      .limit(1) as MatrixEventSource[];
    return Number(records[0]?.depth ?? 0) + 1;
  }

  private async findLatestStateEvent(
    db: Db,
    roomId: string,
    eventType: string,
    stateKey: string,
  ): Promise<MatrixEventRecord | undefined> {
    const records = await db.select()
      .from(matrixEventResource)
      .where(and(
        eq(matrixEventResource.matrixRoomId, roomId),
        eq(matrixEventResource.type, eventType),
        eq(matrixEventResource.stateKey, stateKey),
      ))
      .orderBy(desc(matrixEventResource.originServerTs as any))
      .limit(1) as MatrixEventSource[];
    const record = records[0];
    return record ? this.eventSourceToRecord(record) : undefined;
  }

  private eventSourceToRecord(source: MatrixEventSource): MatrixEventRecord {
    return {
      eventId: source.matrixEventId ?? this.eventIdFromResourceId(source.id),
      roomId: source.matrixRoomId ?? '',
      type: source.type ?? 'm.room.message',
      sender: source.sender ?? '',
      senderWebId: source.senderWebId ?? undefined,
      originServerTs: Number(source.originServerTs ?? this.isoToMillis(source.createdAt) ?? Date.now()),
      content: this.parseJsonObject(source.content) ?? {},
      stateKey: source.stateKey ?? undefined,
      unsigned: this.parseJsonObject(source.unsigned),
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

  private getMatrixUserId(context: MatrixStoreContext): string {
    const serverName = this.getServerName(context);
    const localpart = this.localpartFromUserId(context.userId);
    return `@${localpart}:${serverName}`;
  }

  private getServerName(context: MatrixStoreContext): string {
    if (this.serverName) {
      return this.serverName;
    }
    try {
      return new URL(context.userId).host || 'localhost';
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

  private randomId(size: number): string {
    return randomBytes(size).toString('base64url');
  }

  private slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9._=-]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
  }

  private resourceSlot(value: string): string {
    return encodeURIComponent(value)
      .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      .replace(/%/g, '~');
  }

  private surfaceIdFromRoomId(roomId: string): string {
    return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
  }

  private roomResourceId(roomId: string): string {
    return `rooms/${this.resourceSlot(roomId)}/index.ttl#this`;
  }

  private chatResourceIdFromRoomId(roomId: string): string {
    return `${this.surfaceIdFromRoomId(roomId)}/index.ttl#this`;
  }

  private threadResourceIdFromRoomId(roomId: string): string {
    return `chat/${this.surfaceIdFromRoomId(roomId)}/index.ttl#thread`;
  }

  private messageResourceIdFromEvent(roomId: string, eventId: string, ts: number): string {
    const { yyyy, MM, dd } = this.dateParts(ts);
    return `chat/${this.surfaceIdFromRoomId(roomId)}/${yyyy}/${MM}/${dd}/messages.ttl#${this.slug(eventId)}`;
  }

  private accountResourceId(matrixUserId: string): string {
    return `accounts/${this.resourceSlot(matrixUserId)}.ttl#this`;
  }

  private eventResourceId(roomId: string, eventId: string, ts: number): string {
    const { yyyy, MM, dd } = this.dateParts(ts);
    return `rooms/${this.resourceSlot(roomId)}/${yyyy}/${MM}/${dd}/events.ttl#${this.resourceSlot(eventId)}`;
  }

  private roomIdFromResourceId(id: string): string {
    const match = id.match(/^rooms\/([^/]+)\/index\.ttl#this$/);
    return match ? decodeURIComponent(match[1].replace(/~/g, '%')) : id;
  }

  private eventIdFromResourceId(id: string): string {
    const hash = id.lastIndexOf('#');
    if (hash < 0) {
      return id;
    }
    return decodeURIComponent(id.slice(hash + 1).replace(/~/g, '%'));
  }

  private resolveDataResourceUriFromId(resourceId: string, context: MatrixStoreContext): string {
    const podBaseUrl = this.derivePodBaseUrl(getWebId(context.auth as AuthContext) ?? context.userId);
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
