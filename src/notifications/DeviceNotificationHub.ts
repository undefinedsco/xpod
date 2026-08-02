import { randomUUID } from 'node:crypto';
import type {
  DeviceNotificationOperation,
  DeviceNotificationServerFrame,
} from './device-notification-protocol';
import type { DeviceNotificationIdentity } from '../api/handlers/DeviceNotificationTicketHandler';

export interface DeviceNotificationHubOptions {
  origin: string;
  maxTopicsPerConnection?: number;
  maxQueueMessages?: number;
  maxReplayEvents?: number;
  authorizeTopic?: (input: { identity: DeviceNotificationIdentity; topic: string }) => boolean | Promise<boolean>;
}

export interface OpenDeviceNotificationConnectionInput {
  identity: DeviceNotificationIdentity;
  deviceSessionId: string;
  send: (frame: DeviceNotificationServerFrame) => boolean;
  close?: (code: number, reason: string) => void;
}

export interface DeviceNotificationConnectionHandle {
  connectionId: string;
}

export interface DeviceNotificationPublishInput {
  topic: string;
  object?: string;
  operation: DeviceNotificationOperation;
}

interface ConnectionState {
  connectionId: string;
  identity: DeviceNotificationIdentity;
  deviceSessionId: string;
  topics: Set<string>;
  queue: DeviceNotificationServerFrame[];
  resyncTopics: Set<string>;
  resyncQueued: Set<string>;
  seenRequestIds: Set<string>;
  lastAck: number;
  pendingResumeFrom?: number;
  send: (frame: DeviceNotificationServerFrame) => boolean;
  close?: (code: number, reason: string) => void;
}

type EventFrame = Extract<DeviceNotificationServerFrame, { type: 'event' }>;

const DEFAULT_MAX_TOPICS_PER_CONNECTION = 100;
const DEFAULT_MAX_QUEUE_MESSAGES = 256;
const DEFAULT_MAX_REPLAY_EVENTS = 512;

export class DeviceNotificationHub {
  private readonly origin: URL;
  private readonly maxTopicsPerConnection: number;
  private readonly maxQueueMessages: number;
  private readonly maxReplayEvents: number;
  private readonly authorizeTopic: (input: { identity: DeviceNotificationIdentity; topic: string }) => boolean | Promise<boolean>;
  private readonly connections = new Map<string, ConnectionState>();
  private readonly connectionsByDevice = new Map<string, string>();
  private readonly topicMembers = new Map<string, Set<string>>();
  private readonly replay: EventFrame[] = [];
  private sequence = 0;

  public constructor(options: DeviceNotificationHubOptions) {
    this.origin = new URL(options.origin);
    this.maxTopicsPerConnection = options.maxTopicsPerConnection ?? DEFAULT_MAX_TOPICS_PER_CONNECTION;
    this.maxQueueMessages = options.maxQueueMessages ?? DEFAULT_MAX_QUEUE_MESSAGES;
    this.maxReplayEvents = options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.authorizeTopic = options.authorizeTopic ?? (() => true);
  }

  public openConnection(input: OpenDeviceNotificationConnectionInput): DeviceNotificationConnectionHandle {
    const deviceKey = this.deviceConnectionKey(input.identity, input.deviceSessionId);
    const existingConnectionId = this.connectionsByDevice.get(deviceKey);
    if (existingConnectionId) {
      this.closeConnection(existingConnectionId, 4000, 'Replaced by newer device connection');
    }
    const connectionId = randomUUID();
    this.connections.set(connectionId, {
      connectionId,
      identity: input.identity,
      deviceSessionId: input.deviceSessionId,
      topics: new Set(),
      queue: [],
      resyncTopics: new Set(),
      resyncQueued: new Set(),
      seenRequestIds: new Set(),
      lastAck: 0,
      pendingResumeFrom: undefined,
      send: input.send,
      close: input.close,
    });
    this.connectionsByDevice.set(deviceKey, connectionId);
    return { connectionId };
  }

  public hello(connectionId: string, resumeFrom?: number): DeviceNotificationServerFrame {
    const connection = this.requireConnection(connectionId);
    const ready: DeviceNotificationServerFrame = {
      type: 'ready',
      connectionId,
      sequence: this.sequence,
    };
    this.deliver(connection, ready);
    if (resumeFrom !== undefined) {
      connection.pendingResumeFrom = resumeFrom;
    }
    return ready;
  }

  public async registerTopics(connectionId: string, requestId: string, topics: string[]): Promise<DeviceNotificationServerFrame> {
    const connection = this.requireConnection(connectionId);
    this.assertNewRequestId(connection, requestId);
    const normalizedTopics = topics.map((topic) => this.normalizeTopic(topic));
    if ((new Set([...connection.topics, ...normalizedTopics])).size > this.maxTopicsPerConnection) {
      throw new Error('Too many topics for connection');
    }
    for (const topic of normalizedTopics) {
      if (!await this.authorizeTopic({ identity: connection.identity, topic })) {
        throw new Error(`Topic not authorized: ${topic}`);
      }
      connection.topics.add(topic);
      if (!this.topicMembers.has(topic)) {
        this.topicMembers.set(topic, new Set());
      }
      this.topicMembers.get(topic)!.add(connectionId);
    }
    const frame: DeviceNotificationServerFrame = {
      type: 'registered',
      requestId,
      topics: normalizedTopics,
    };
    this.deliver(connection, frame);
    this.deliverPendingResume(connection);
    return frame;
  }

  public async unregisterTopics(connectionId: string, requestId: string, topics: string[]): Promise<DeviceNotificationServerFrame> {
    const connection = this.requireConnection(connectionId);
    this.assertNewRequestId(connection, requestId);
    const normalizedTopics = topics.map((topic) => this.normalizeTopic(topic));
    for (const topic of normalizedTopics) {
      connection.topics.delete(topic);
      const members = this.topicMembers.get(topic);
      members?.delete(connectionId);
      if (members?.size === 0) {
        this.topicMembers.delete(topic);
      }
    }
    const frame: DeviceNotificationServerFrame = {
      type: 'unregistered',
      requestId,
      topics: normalizedTopics,
    };
    this.deliver(connection, frame);
    return frame;
  }

  public ack(connectionId: string, sequence: number): void {
    const connection = this.requireConnection(connectionId);
    connection.lastAck = Math.max(connection.lastAck, sequence);
    connection.queue = connection.queue.filter((frame) => frame.type !== 'event' || frame.sequence > sequence);
  }

  public publish(input: DeviceNotificationPublishInput): EventFrame {
    const topic = this.normalizeTopic(input.topic);
    const event: EventFrame = {
      type: 'event',
      sequence: ++this.sequence,
      eventId: `urn:uuid:${randomUUID()}`,
      topic,
      ...(input.object ? { object: this.normalizeResource(input.object) } : {}),
      operation: input.operation,
      emittedAt: new Date().toISOString(),
    };
    this.pushReplay(event);
    const memberIds = this.matchingMemberIds(topic, event.object);
    for (const connectionId of memberIds) {
      const connection = this.connections.get(connectionId);
      if (!connection) {
        continue;
      }
      this.deliver(connection, event);
    }
    return event;
  }

  public resume(connectionId: string, resumeFrom: number): EventFrame[] | DeviceNotificationServerFrame {
    const connection = this.requireConnection(connectionId);
    if (this.replay.length === 0) {
      return [];
    }
    const oldest = this.replay[0].sequence;
    if (resumeFrom < oldest) {
      return {
        type: 'resync-required',
        topics: [...connection.topics].sort(),
        reason: 'expired',
      };
    }
    return this.replay
      .filter((event) => event.sequence > resumeFrom)
      .filter((event) => this.connectionMatches(connection, event.topic, event.object));
  }

  public closeConnection(connectionId: string, code?: number, reason?: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    if (code !== undefined && reason !== undefined) {
      connection.close?.(code, reason);
    }
    for (const topic of connection.topics) {
      const members = this.topicMembers.get(topic);
      members?.delete(connectionId);
      if (members?.size === 0) {
        this.topicMembers.delete(topic);
      }
    }
    this.connections.delete(connectionId);
    this.connectionsByDevice.delete(this.deviceConnectionKey(connection.identity, connection.deviceSessionId));
  }

  public getSeenRequestIds(connectionId: string): Set<string> {
    return this.requireConnection(connectionId).seenRequestIds;
  }

  public getTopicMemberCount(topic: string): number {
    return this.topicMembers.get(this.normalizeTopic(topic))?.size ?? 0;
  }

  public getConnectionSnapshot(connectionId: string): {
    topicCount: number;
    topics: string[];
    queueLength: number;
    resyncTopics: string[];
    lastAck: number;
  } | undefined {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return undefined;
    }
    return {
      topicCount: connection.topics.size,
      topics: [...connection.topics].sort(),
      queueLength: connection.queue.length,
      resyncTopics: [...connection.resyncTopics].sort(),
      lastAck: connection.lastAck,
    };
  }

  private deliver(connection: ConnectionState, frame: DeviceNotificationServerFrame): void {
    if (connection.send(frame)) {
      return;
    }
    this.enqueue(connection, frame);
  }

  private deliverPendingResume(connection: ConnectionState): void {
    if (connection.pendingResumeFrom === undefined) {
      return;
    }
    const resumeFrom = connection.pendingResumeFrom;
    connection.pendingResumeFrom = undefined;
    const replay = this.resume(connection.connectionId, resumeFrom);
    if (Array.isArray(replay)) {
      for (const frame of replay) {
        this.deliver(connection, frame);
      }
    } else {
      this.deliver(connection, replay);
    }
  }

  private enqueue(connection: ConnectionState, frame: DeviceNotificationServerFrame): void {
    if (frame.type === 'event') {
      this.coalesceEvent(connection, frame);
    } else {
      connection.queue.push(frame);
    }
    if (connection.queue.length > this.maxQueueMessages) {
      this.markOverflow(connection, frame);
    }
  }

  private coalesceEvent(connection: ConnectionState, frame: EventFrame): void {
    const index = connection.queue.findIndex((queued) =>
      queued.type === 'event' && queued.topic === frame.topic && queued.object === frame.object);
    if (index === -1) {
      connection.queue.push(frame);
      return;
    }
    const previous = connection.queue[index] as EventFrame;
    connection.queue[index] = {
      ...frame,
      operation: previous.operation === 'delete' ? 'delete' : frame.operation,
    };
  }

  private markOverflow(connection: ConnectionState, frame: DeviceNotificationServerFrame): void {
    const topics = frame.type === 'event' ? [frame.topic] : [...connection.topics];
    for (const topic of topics) {
      connection.resyncTopics.add(topic);
      if (!connection.resyncQueued.has(topic)) {
        connection.queue.push({
          type: 'resync-required',
          topics: [topic],
          reason: 'overflow',
        });
        connection.resyncQueued.add(topic);
      }
    }
    while (connection.queue.length > this.maxQueueMessages) {
      const dropped = connection.queue.findIndex((queued) => queued.type === 'event');
      connection.queue.splice(dropped === -1 ? 0 : dropped, 1);
    }
  }

  private pushReplay(event: EventFrame): void {
    this.replay.push(event);
    while (this.replay.length > this.maxReplayEvents) {
      this.replay.shift();
    }
  }

  private matchingMemberIds(topic: string, object?: string): Set<string> {
    const ids = new Set<string>();
    for (const [registeredTopic, members] of this.topicMembers) {
      if (this.topicMatches(registeredTopic, topic, object)) {
        for (const member of members) {
          ids.add(member);
        }
      }
    }
    return ids;
  }

  private connectionMatches(connection: ConnectionState, topic: string, object?: string): boolean {
    for (const registeredTopic of connection.topics) {
      if (this.topicMatches(registeredTopic, topic, object)) {
        return true;
      }
    }
    return false;
  }

  private topicMatches(registeredTopic: string, eventTopic: string, object?: string): boolean {
    return eventTopic === registeredTopic ||
      object === registeredTopic ||
      Boolean(object && registeredTopic.endsWith('/') && object.startsWith(registeredTopic));
  }

  private assertNewRequestId(connection: ConnectionState, requestId: string): void {
    if (connection.seenRequestIds.has(requestId)) {
      throw new Error(`Duplicate requestId: ${requestId}`);
    }
    connection.seenRequestIds.add(requestId);
  }

  private normalizeTopic(topic: string): string {
    const url = new URL(topic, this.origin);
    if (url.origin !== this.origin.origin) {
      throw new Error('topic must be same-origin');
    }
    url.hash = '';
    url.search = '';
    return url.toString();
  }

  private normalizeResource(resource: string): string {
    const url = new URL(resource, this.origin);
    if (url.origin !== this.origin.origin) {
      throw new Error('resource must be same-origin');
    }
    url.hash = '';
    return url.toString();
  }

  private requireConnection(connectionId: string): ConnectionState {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new Error(`Unknown notification connection: ${connectionId}`);
    }
    return connection;
  }

  private deviceConnectionKey(identity: DeviceNotificationIdentity, deviceSessionId: string): string {
    return `${identity.webId}\u0000${deviceSessionId}`;
  }
}
