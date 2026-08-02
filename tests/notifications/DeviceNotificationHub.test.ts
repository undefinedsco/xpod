import { describe, expect, it, vi } from 'vitest';
import { DeviceNotificationHub } from '../../src/notifications/DeviceNotificationHub';
import { DeviceNotificationResourceListener } from '../../src/notifications/DeviceNotificationResourceListener';

function createHub(options: Partial<ConstructorParameters<typeof DeviceNotificationHub>[0]> = {}) {
  return new DeviceNotificationHub({
    origin: 'https://pod.example',
    maxTopicsPerConnection: 100,
    maxQueueMessages: 2,
    maxReplayEvents: 3,
    authorizeTopic: ({ identity, topic }) => topic.startsWith(`https://pod.example/${identity.localPart}/`),
    ...options,
  });
}

describe('DeviceNotificationHub multiplex behavior', () => {
  it('keeps one active connection per webId and deviceSessionId by replacing the previous connection', async () => {
    const hub = createHub();
    const firstSend = vi.fn().mockReturnValue(true);
    const secondSend = vi.fn().mockReturnValue(true);
    const firstClose = vi.fn();
    const identity = { webId: 'https://pod.example/alice#me', localPart: 'alice' };
    const first = hub.openConnection({ identity, deviceSessionId: 'device-1', send: firstSend, close: firstClose });
    hub.hello(first.connectionId);
    await hub.registerTopics(first.connectionId, 'req-1', ['https://pod.example/alice/notes/']);
    expect(hub.getTopicMemberCount('https://pod.example/alice/notes/')).toBe(1);

    const second = hub.openConnection({ identity, deviceSessionId: 'device-1', send: secondSend });
    hub.hello(second.connectionId);

    expect(firstClose).toHaveBeenCalledWith(4000, 'Replaced by newer device connection');
    expect(hub.getConnectionSnapshot(first.connectionId)).toBeUndefined();
    expect(hub.getTopicMemberCount('https://pod.example/alice/notes/')).toBe(0);
    expect(() => hub.ack(first.connectionId, 1)).toThrow(/unknown notification connection/i);

    await hub.registerTopics(second.connectionId, 'req-2', ['https://pod.example/alice/notes/']);
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/today.ttl', operation: 'update' });

    expect(firstSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }));
    expect(secondSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }));
  });

  it('delivers exact resource topic subscriptions without adding a trailing slash', async () => {
    const hub = createHub();
    const send = vi.fn().mockReturnValue(true);
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'device-1', send });
    hub.hello(connection.connectionId);
    await hub.registerTopics(connection.connectionId, 'req-1', ['https://pod.example/alice/items.ttl']);

    hub.publish({ topic: 'https://pod.example/alice/', object: 'https://pod.example/alice/items.ttl', operation: 'update' });

    expect(hub.getConnectionSnapshot(connection.connectionId)?.topics).toEqual(['https://pod.example/alice/items.ttl']);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'event',
      object: 'https://pod.example/alice/items.ttl',
    }));
  });

  it('delivers container topic subscriptions by object prefix only when the registered topic ends with slash', async () => {
    const hub = createHub();
    const containerSend = vi.fn().mockReturnValue(true);
    const resourceSend = vi.fn().mockReturnValue(true);
    const containerConnection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'container-device', send: containerSend });
    const resourceConnection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'resource-device', send: resourceSend });
    hub.hello(containerConnection.connectionId);
    hub.hello(resourceConnection.connectionId);
    await hub.registerTopics(containerConnection.connectionId, 'req-1', ['https://pod.example/alice/notes/']);
    await hub.registerTopics(resourceConnection.connectionId, 'req-2', ['https://pod.example/alice/notes']);

    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/today.ttl', operation: 'update' });

    expect(containerSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'event',
      object: 'https://pod.example/alice/notes/today.ttl',
    }));
    expect(resourceSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }));
  });

  it('registers 100 topics on one connection and treats duplicate registration as idempotent', () => {
    const hub = createHub();
    const send = vi.fn().mockReturnValue(true);
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'device-1', send });
    hub.hello(connection.connectionId);

    const topics = Array.from({ length: 100 }, (_, index) => `https://pod.example/alice/topic-${index}/`);
    return expect(hub.registerTopics(connection.connectionId, 'req-1', topics)).resolves.toMatchObject({
      type: 'registered',
      requestId: 'req-1',
      topics,
    }).then(async () => {
      await expect(hub.registerTopics(connection.connectionId, 'req-2', topics.slice(0, 2))).resolves.toMatchObject({
        type: 'registered',
        topics: topics.slice(0, 2),
      });
      expect(hub.getConnectionSnapshot(connection.connectionId)?.topicCount).toBe(100);
    });
  });

  it('unregisters only requested memberships and disconnect removes all memberships', async () => {
    const hub = createHub();
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'device-1', send: vi.fn().mockReturnValue(true) });
    hub.hello(connection.connectionId);
    await hub.registerTopics(connection.connectionId, 'req-1', [
      'https://pod.example/alice/a/',
      'https://pod.example/alice/b/',
    ]);

    await hub.unregisterTopics(connection.connectionId, 'req-2', ['https://pod.example/alice/a/']);
    expect(hub.getConnectionSnapshot(connection.connectionId)?.topics).toEqual(['https://pod.example/alice/b/']);

    hub.closeConnection(connection.connectionId);
    expect(hub.getTopicMemberCount('https://pod.example/alice/b/')).toBe(0);
  });

  it('fans out matching changes only to authorized topic members', async () => {
    const hub = createHub();
    const aliceSend = vi.fn().mockReturnValue(true);
    const bobSend = vi.fn().mockReturnValue(true);
    const alice = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'a', send: aliceSend });
    const bob = hub.openConnection({ identity: { webId: 'https://pod.example/bob#me', localPart: 'bob' }, deviceSessionId: 'b', send: bobSend });
    hub.hello(alice.connectionId);
    hub.hello(bob.connectionId);
    await hub.registerTopics(alice.connectionId, 'a-1', ['https://pod.example/alice/notes/']);
    await expect(hub.registerTopics(bob.connectionId, 'b-1', ['https://pod.example/alice/notes/'])).rejects.toThrow(/not authorized/i);

    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/today.ttl', operation: 'update' });

    expect(aliceSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'event', sequence: 1 }));
    expect(bobSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'event' }));
  });

  it('awaits asynchronous ACL before registering topics', async () => {
    const hub = createHub({
      authorizeTopic: vi.fn(async ({ topic }) => topic === 'https://pod.example/alice/allowed/'),
    });
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'a', send: vi.fn().mockReturnValue(true) });
    hub.hello(connection.connectionId);

    await expect(hub.registerTopics(connection.connectionId, 'req-1', ['https://pod.example/alice/allowed/'])).resolves.toMatchObject({
      type: 'registered',
    });
    await expect(hub.registerTopics(connection.connectionId, 'req-2', ['https://pod.example/alice/denied/'])).rejects.toThrow(/not authorized/i);
  });

  it('bounds slow-client queues and emits resync-required once on overflow', async () => {
    const hub = createHub();
    const send = vi.fn().mockReturnValue(false);
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'a', send });
    hub.hello(connection.connectionId);
    await hub.registerTopics(connection.connectionId, 'req-1', ['https://pod.example/alice/notes/']);

    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/1.ttl', operation: 'update' });
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/2.ttl', operation: 'update' });
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/3.ttl', operation: 'update' });
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/4.ttl', operation: 'update' });

    const snapshot = hub.getConnectionSnapshot(connection.connectionId);
    expect(snapshot?.queueLength).toBeLessThanOrEqual(2);
    expect(snapshot?.resyncTopics).toEqual(['https://pod.example/alice/notes/']);
  });

  it('acknowledges delivered sequences and drops queued events through the acked sequence', async () => {
    const hub = createHub();
    const send = vi.fn().mockReturnValue(false);
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'a', send });
    hub.hello(connection.connectionId);
    await hub.registerTopics(connection.connectionId, 'req-1', ['https://pod.example/alice/notes/']);

    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/1.ttl', operation: 'update' });
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/2.ttl', operation: 'update' });
    expect(hub.getConnectionSnapshot(connection.connectionId)?.queueLength).toBeGreaterThan(0);

    hub.ack(connection.connectionId, 2);

    expect(hub.getConnectionSnapshot(connection.connectionId)?.lastAck).toBe(2);
    expect(hub.getConnectionSnapshot(connection.connectionId)?.queueLength).toBe(2);
  });

  it('replays from acked sequence and requests resync when the replay gap expired', async () => {
    const hub = createHub({ maxReplayEvents: 2 });
    const send = vi.fn().mockReturnValue(true);
    const connection = hub.openConnection({ identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' }, deviceSessionId: 'a', send });
    hub.hello(connection.connectionId);
    await hub.registerTopics(connection.connectionId, 'req-1', ['https://pod.example/alice/notes/']);
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/1.ttl', operation: 'update' });
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/2.ttl', operation: 'update' });
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/3.ttl', operation: 'update' });

    expect(hub.resume(connection.connectionId, 1)).toEqual({
      type: 'resync-required',
      topics: ['https://pod.example/alice/notes/'],
      reason: 'expired',
    });
    expect(hub.resume(connection.connectionId, 2)).toHaveLength(1);
  });

  it('delays reconnect replay until topics are registered on the new connection', async () => {
    const hub = createHub();
    const oldSend = vi.fn().mockReturnValue(true);
    const newSend = vi.fn().mockReturnValue(true);
    const identity = { webId: 'https://pod.example/alice#me', localPart: 'alice' };
    const oldConnection = hub.openConnection({ identity, deviceSessionId: 'device-1', send: oldSend });
    hub.hello(oldConnection.connectionId);
    await hub.registerTopics(oldConnection.connectionId, 'old-register', ['https://pod.example/alice/notes/']);
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/1.ttl', operation: 'update' });
    hub.ack(oldConnection.connectionId, 1);
    hub.publish({ topic: 'https://pod.example/alice/notes/', object: 'https://pod.example/alice/notes/2.ttl', operation: 'update' });

    const newConnection = hub.openConnection({ identity, deviceSessionId: 'device-1', send: newSend });
    hub.hello(newConnection.connectionId, 1);
    expect(newSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'event', sequence: 2 }));

    await hub.registerTopics(newConnection.connectionId, 'new-register', ['https://pod.example/alice/notes/']);

    expect(newSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'event',
      sequence: 2,
      object: 'https://pod.example/alice/notes/2.ttl',
    }));
  });
});

describe('DeviceNotificationResourceListener', () => {
  it('bridges ResourceChangeEvent to canonical resource URLs without reading bodies', async () => {
    const hub = { publish: vi.fn() };
    const listener = new DeviceNotificationResourceListener({ origin: 'https://pod.example', hub });

    await listener.onResourceChanged({
      path: '/alice/notes/today.ttl',
      action: 'update',
      isContainer: false,
      timestamp: Date.parse('2026-08-03T00:00:00.000Z'),
    });

    expect(hub.publish).toHaveBeenCalledWith({
      topic: 'https://pod.example/alice/notes/',
      object: 'https://pod.example/alice/notes/today.ttl',
      operation: 'update',
    });
  });
});
