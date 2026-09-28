import type { AuthContext } from '../auth/AuthContext';
import type { ReconcilerOwner } from '../reconciler';

export interface MatrixStoreContext {
  /** Authenticated Solid WebID used as the Pod actor/resource owner. */
  webId: string;
  /** Storage Pod selected by the current SP/gateway, not necessarily the WebID issuer origin. */
  podUrl?: string;
  auth?: AuthContext;
  /**
   * Work the deployment does on its own behalf rather than for a caller: an inbound federation
   * transaction is written into the participant's Pod by the deployment, which presents that
   * participant's task-layer grant instead of a session.
   *
   * There is no ambient authority here. Without a grant for the Pod the write fails, and the store
   * never borrows a session or a deployment-held key to make it succeed — "this deployment was
   * authorized to write" has to stay distinguishable from "somebody registered once".
   */
  service?: { taskCredential?: { credentialRef?: string; version?: number } };
}

export interface MatrixRoomRecord {
  roomId: string;
  canonicalAlias?: string;
  name?: string;
  topic?: string;
  creator: string;
  reconcilerOwner: ReconcilerOwner;
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
  role?: string;
  resourceId?: string;
  txnId?: string;
  /**
   * The device that wrote this event from a reserved transaction.
   *
   * Persisted with the event because the reservation that pins an event's identity lives in its own
   * record, addressed by a key that includes this device: recovering "which reservation does this
   * event belong to" from the event alone is what lets the receipt live in the Pod instead of a
   * deployment database. The room, type and transaction id are already on the event; the device is
   * the one part of the key it does not otherwise carry.
   *
   * The device id rather than the whole key, deliberately: it is a quote-free token, and a metadata
   * string containing quotes is corrupted by this storage (contract §8).
   */
  txnDevice?: string;
  content: Record<string, unknown>;
  stateKey?: string;
  unsigned?: Record<string, unknown>;
  /** Verifiable protocol event as persisted, when the row carries one. */
  event?: Record<string, unknown>;
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
}

export interface MatrixSendEventRequest {
  body?: string;
  msgtype?: string;
  [key: string]: unknown;
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms: {
    invite?: Record<string, {invite_state: {events: MatrixClientEvent[]}}>;
    leave?: Record<string, {timeline: {events: MatrixClientEvent[]; limited: boolean}}>;
    join: Record<string, {
      state: { events: MatrixClientEvent[] };
      timeline: {
        events: MatrixClientEvent[];
        limited: boolean;
        prev_batch?: string;
      };
      'co.undefineds.coordination'?: {
        reconcilerOwner: ReconcilerOwner;
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
  sync(context: MatrixStoreContext, options?: { since?: string; limit?: number; timeout?: number; signal?: AbortSignal }): Promise<MatrixSyncResponse>;
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
