import type { AuthContext } from '../auth/AuthContext';

export interface MatrixStoreContext {
  userId: string;
  auth?: AuthContext;
}

export interface MatrixRoomRecord {
  roomId: string;
  canonicalAlias?: string;
  name?: string;
  topic?: string;
  creator: string;
  createdAt: number;
}

export interface MatrixEventRecord {
  eventId: string;
  roomId: string;
  type: string;
  sender: string;
  senderWebId?: string;
  originServerTs: number;
  depth?: number;
  txnId?: string;
  content: Record<string, unknown>;
  stateKey?: string;
  unsigned?: Record<string, unknown>;
}

export interface MatrixCreateRoomRequest {
  visibility?: 'private' | 'public';
  room_alias_name?: string;
  name?: string;
  topic?: string;
  invite?: string[];
  creation_content?: Record<string, unknown>;
  initial_state?: Array<{
    type: string;
    state_key?: string;
    content?: Record<string, unknown>;
  }>;
  preset?: string;
  is_direct?: boolean;
}

export interface MatrixSendEventRequest {
  body?: string;
  msgtype?: string;
  [key: string]: unknown;
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms: {
    join: Record<string, {
      state: { events: MatrixClientEvent[] };
      timeline: {
        events: MatrixClientEvent[];
        limited: boolean;
        prev_batch?: string;
      };
    }>;
  };
}

export interface MatrixClientEvent {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  state_key?: string;
  unsigned?: Record<string, unknown>;
}

export interface MatrixAccountInfo {
  userId: string;
  deviceId?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface MatrixStore {
  getAccount(context: MatrixStoreContext): Promise<MatrixAccountInfo>;
  createRoom(input: MatrixCreateRoomRequest, context: MatrixStoreContext): Promise<MatrixRoomRecord>;
  joinRoom(roomIdOrAlias: string, context: MatrixStoreContext): Promise<{ roomId: string }>;
  inviteUser(roomId: string, userId: string, context: MatrixStoreContext): Promise<void>;
  leaveRoom(roomId: string, context: MatrixStoreContext): Promise<void>;
  sendEvent(
    roomId: string,
    eventType: string,
    txnId: string,
    content: MatrixSendEventRequest,
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord>;
  setState(
    roomId: string,
    eventType: string,
    stateKey: string,
    content: Record<string, unknown>,
    context: MatrixStoreContext,
  ): Promise<MatrixEventRecord>;
  sync(context: MatrixStoreContext, options?: { since?: string; limit?: number }): Promise<MatrixSyncResponse>;
  listJoinedRooms(context: MatrixStoreContext): Promise<string[]>;
  getMembers(roomId: string, context: MatrixStoreContext): Promise<MatrixClientEvent[]>;
  listMessages(
    roomId: string,
    context: MatrixStoreContext,
    options?: { limit?: number; dir?: 'b' | 'f'; from?: string },
  ): Promise<{ chunk: MatrixClientEvent[]; start?: string; end: string }>;
  getEvent(roomId: string, eventId: string, context: MatrixStoreContext): Promise<MatrixClientEvent>;
  getState(
    roomId: string,
    eventType: string,
    stateKey: string,
    context: MatrixStoreContext,
  ): Promise<Record<string, unknown>>;
}
