export const XPOD_NOTIFICATIONS_PROTOCOL = 'xpod.notifications.v1';

export type DeviceNotificationOperation = 'create' | 'update' | 'delete' | 'invalidate';

export type DeviceNotificationClientFrame =
  | { type: 'hello'; protocol: typeof XPOD_NOTIFICATIONS_PROTOCOL; resumeFrom?: number }
  | { type: 'register'; requestId: string; topics: string[] }
  | { type: 'unregister'; requestId: string; topics: string[] }
  | { type: 'ack'; sequence: number };

export type DeviceNotificationServerFrame =
  | { type: 'ready'; connectionId: string; sequence: number }
  | { type: 'registered' | 'unregistered'; requestId: string; topics: string[] }
  | {
      type: 'event';
      sequence: number;
      eventId: string;
      topic: string;
      object?: string;
      operation: DeviceNotificationOperation;
      emittedAt: string;
    }
  | { type: 'resync-required'; topics: string[]; reason: 'gap' | 'overflow' | 'expired' }
  | { type: 'error'; requestId?: string; code: string; message: string };

export interface ParseClientFrameOptions {
  origin?: string;
  seenRequestIds?: Set<string>;
  maxTopicsPerBatch?: number;
}

const CLIENT_FIELDS: Record<string, Set<string>> = {
  hello: new Set(['type', 'protocol', 'resumeFrom']),
  register: new Set(['type', 'requestId', 'topics']),
  unregister: new Set(['type', 'requestId', 'topics']),
  ack: new Set(['type', 'sequence']),
};

export function parseClientFrame(input: unknown, options: ParseClientFrameOptions = {}): DeviceNotificationClientFrame {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid client frame');
  }
  const frame = input as Record<string, unknown>;
  if (typeof frame.type !== 'string' || !(frame.type in CLIENT_FIELDS)) {
    throw new Error(`Unknown frame type: ${String(frame.type)}`);
  }
  rejectUnknownFields(frame, CLIENT_FIELDS[frame.type]);

  switch (frame.type) {
    case 'hello':
      return parseHello(frame);
    case 'register':
    case 'unregister':
      return parseTopicFrame(frame, frame.type, options);
    case 'ack':
      return parseAck(frame);
    default:
      throw new Error(`Unknown frame type: ${String(frame.type)}`);
  }
}

export function serializeServerFrame(frame: DeviceNotificationServerFrame): string {
  return JSON.stringify(frame);
}

export function createProtocolErrorFrame(
  code: string,
  message: string,
  requestId?: string,
): DeviceNotificationServerFrame {
  return {
    type: 'error',
    ...(requestId ? { requestId } : {}),
    code,
    message: messageContainsSecret(message) ? '[redacted]' : message,
  };
}

export function parseDeviceNotificationSubprotocols(header: string | string[] | undefined): {
  protocolAccepted: boolean;
  ticket?: string;
} {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return {
    protocolAccepted: entries.includes(XPOD_NOTIFICATIONS_PROTOCOL),
    ticket: entries.find((entry) => entry !== XPOD_NOTIFICATIONS_PROTOCOL),
  };
}

function parseHello(frame: Record<string, unknown>): DeviceNotificationClientFrame {
  if (frame.protocol !== XPOD_NOTIFICATIONS_PROTOCOL) {
    throw new Error('Unsupported notification protocol');
  }
  if (frame.resumeFrom !== undefined && !isNonNegativeInteger(frame.resumeFrom)) {
    throw new Error('resumeFrom must be a non-negative integer');
  }
  return {
    type: 'hello',
    protocol: XPOD_NOTIFICATIONS_PROTOCOL,
    ...(frame.resumeFrom === undefined ? {} : { resumeFrom: frame.resumeFrom as number }),
  };
}

function parseTopicFrame(
  frame: Record<string, unknown>,
  type: 'register' | 'unregister',
  options: ParseClientFrameOptions,
): DeviceNotificationClientFrame {
  if (typeof frame.requestId !== 'string' || frame.requestId.length === 0) {
    throw new Error('requestId is required');
  }
  if (options.seenRequestIds?.has(frame.requestId)) {
    throw new Error(`Duplicate requestId: ${frame.requestId}`);
  }
  const topics = parseTopics(frame.topics, options);
  options.seenRequestIds?.add(frame.requestId);
  return { type, requestId: frame.requestId, topics };
}

function parseAck(frame: Record<string, unknown>): DeviceNotificationClientFrame {
  if (!isNonNegativeInteger(frame.sequence)) {
    throw new Error('sequence must be a non-negative integer');
  }
  return { type: 'ack', sequence: frame.sequence as number };
}

function parseTopics(input: unknown, options: ParseClientFrameOptions): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('topics must be a non-empty array');
  }
  const maxTopics = options.maxTopicsPerBatch ?? 100;
  if (input.length > maxTopics) {
    throw new Error(`Too many topics: ${input.length}`);
  }
  return input.map((topic) => parseTopic(topic, options.origin));
}

function parseTopic(input: unknown, origin?: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('topic must be a URL string');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('topic must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('topic must be an HTTP URL');
  }
  if (origin && url.origin !== new URL(origin).origin) {
    throw new Error('topic must be a same-origin Pod resource URL');
  }
  return url.toString();
}

function rejectUnknownFields(frame: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(frame)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown field: ${key}`);
    }
  }
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function messageContainsSecret(message: string): boolean {
  return /token|ticket|secret|bearer/i.test(message);
}
