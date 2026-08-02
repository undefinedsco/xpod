import { describe, expect, it } from 'vitest';
import {
  XPOD_NOTIFICATIONS_PROTOCOL,
  createProtocolErrorFrame,
  parseClientFrame,
  serializeServerFrame,
} from '../../src/notifications/device-notification-protocol';

describe('xpod.notifications.v1 protocol parser', () => {
  it('parses hello, register, unregister and ack frames', () => {
    expect(parseClientFrame({
      type: 'hello',
      protocol: XPOD_NOTIFICATIONS_PROTOCOL,
      resumeFrom: 12,
    })).toEqual({
      type: 'hello',
      protocol: XPOD_NOTIFICATIONS_PROTOCOL,
      resumeFrom: 12,
    });

    expect(parseClientFrame({
      type: 'register',
      requestId: 'req-1',
      topics: ['https://pod.example/alice/notes/'],
    }, { origin: 'https://pod.example', seenRequestIds: new Set() })).toEqual({
      type: 'register',
      requestId: 'req-1',
      topics: ['https://pod.example/alice/notes/'],
    });

    expect(parseClientFrame({ type: 'ack', sequence: 9 })).toEqual({ type: 'ack', sequence: 9 });
  });

  it('rejects malformed frames, unknown client fields and duplicate request IDs', () => {
    const seenRequestIds = new Set<string>(['req-1']);

    expect(() => parseClientFrame({ type: 'wat' })).toThrow(/unknown frame type/i);
    expect(() => parseClientFrame({
      type: 'hello',
      protocol: XPOD_NOTIFICATIONS_PROTOCOL,
      ticket: 'must-not-be-here',
    })).toThrow(/unknown field/i);
    expect(() => parseClientFrame({
      type: 'register',
      requestId: 'req-1',
      topics: ['https://pod.example/alice/notes/'],
    }, { origin: 'https://pod.example', seenRequestIds })).toThrow(/duplicate requestId/i);
  });

  it('rejects invalid topic URLs and oversized topic batches', () => {
    expect(() => parseClientFrame({
      type: 'register',
      requestId: 'req-1',
      topics: ['https://evil.example/alice/notes/'],
    }, { origin: 'https://pod.example' })).toThrow(/same-origin/i);

    expect(() => parseClientFrame({
      type: 'register',
      requestId: 'req-2',
      topics: Array.from({ length: 101 }, (_, index) => `https://pod.example/alice/${index}/`),
    }, { origin: 'https://pod.example', maxTopicsPerBatch: 100 })).toThrow(/too many topics/i);
  });

  it('serializes monotonic server frames and redacts protocol errors', () => {
    expect(serializeServerFrame({
      type: 'event',
      sequence: 2,
      eventId: 'evt-2',
      topic: 'https://pod.example/alice/notes/',
      object: 'https://pod.example/alice/notes/today.ttl',
      operation: 'update',
      emittedAt: '2026-08-03T00:00:00.000Z',
    })).toContain('"sequence":2');

    expect(createProtocolErrorFrame('bad-ticket', 'Bearer secret-token leaked in logs')).toEqual({
      type: 'error',
      code: 'bad-ticket',
      message: '[redacted]',
    });
  });
});
