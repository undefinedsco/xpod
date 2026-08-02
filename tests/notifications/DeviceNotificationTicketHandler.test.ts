import { describe, expect, it, vi } from 'vitest';
import { DeviceNotificationTicketStore } from '../../src/api/handlers/DeviceNotificationTicketHandler';

describe('DeviceNotificationTicketStore', () => {
  it('mints identity-bound single-use tickets and stores only digests', () => {
    const store = new DeviceNotificationTicketStore();
    const ticket = store.mint({
      identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' },
      deviceSessionId: 'device-a',
      origin: 'https://pod.example',
      ttlMs: 1_000,
    });

    expect(ticket).not.toHaveLength(0);
    expect(JSON.stringify(store)).not.toContain(ticket);
    expect(store.consume(ticket)).toMatchObject({
      identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' },
      deviceSessionId: 'device-a',
      origin: 'https://pod.example',
    });
    expect(store.consume(ticket)).toBeUndefined();
  });

  it('expires tickets after ttl', () => {
    vi.useFakeTimers();
    try {
      const store = new DeviceNotificationTicketStore();
      const ticket = store.mint({
        identity: { webId: 'https://pod.example/alice#me', localPart: 'alice' },
        deviceSessionId: 'device-a',
        origin: 'https://pod.example',
        ttlMs: 10,
      });

      vi.advanceTimersByTime(11);

      expect(store.consume(ticket)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
