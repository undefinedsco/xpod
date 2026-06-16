import { describe, expect, it } from 'vitest';
import { ClientReconcilerCoordinator } from '../../../src/api/reconciler';

const USER = 'https://alice.example/profile/card#me';
const THREAD = 'https://alice.example/.data/chat/client-owned/index.ttl#this';

describe('ClientReconcilerCoordinator', () => {
  it('selects one eligible client-owned-thread coordinator and prefers stable clients', async () => {
    let now = new Date('2026-06-14T10:00:00.000Z');
    const coordinator = new ClientReconcilerCoordinator({ now: () => now });

    await coordinator.upsertClientCapability({
      clientId: 'web-1',
      kind: 'web',
      user: USER,
      canCoordinateClientOwnedThread: true,
      canRunAgent: true,
    });
    await coordinator.upsertClientCapability({
      clientId: 'desktop-1',
      kind: 'desktop',
      user: USER,
      canCoordinateClientOwnedThread: true,
      canRunAgent: true,
      workspaces: [ 'file://localhost/work/demo' ],
    });

    const lease = await coordinator.activate({ thread: THREAD, ownerUser: USER, requesterClientId: 'web-1' });

    expect(lease).toMatchObject({
      thread: THREAD,
      ownerUser: USER,
      ownerClientId: 'desktop-1',
      expiresAt: '2026-06-14T10:00:30.000Z',
    });
    expect(lease?.fencingToken).toBeTypeOf('string');
    now = new Date('2026-06-14T10:00:01.000Z');
    expect(await coordinator.getLease(THREAD)).toMatchObject({ ownerClientId: 'desktop-1' });
  });

  it('keeps a fresh existing lease holder instead of stealing with a higher priority client', async () => {
    let now = new Date('2026-06-14T10:00:00.000Z');
    const coordinator = new ClientReconcilerCoordinator({ now: () => now });

    await coordinator.upsertClientCapability({
      clientId: 'web-1',
      kind: 'web',
      user: USER,
      canCoordinateClientOwnedThread: true,
    });
    const first = await coordinator.activate({ thread: THREAD, ownerUser: USER, requesterClientId: 'web-1' });
    expect(first?.ownerClientId).toBe('web-1');

    now = new Date('2026-06-14T10:00:01.000Z');
    await coordinator.upsertClientCapability({
      clientId: 'cli-1',
      kind: 'cli',
      user: USER,
      canCoordinateClientOwnedThread: true,
    });
    const renewed = await coordinator.activate({ thread: THREAD, ownerUser: USER, requesterClientId: 'cli-1' });

    expect(renewed?.ownerClientId).toBe('web-1');
    expect(renewed?.fencingToken).toBe(first?.fencingToken);
    expect(renewed?.expiresAt).toBe('2026-06-14T10:00:31.000Z');
  });

  it('moves the lease when the current owner stops heartbeating', async () => {
    let now = new Date('2026-06-14T10:00:00.000Z');
    const coordinator = new ClientReconcilerCoordinator({
      now: () => now,
      heartbeatTtlMs: 1_000,
      leaseTtlMs: 30_000,
    });

    await coordinator.upsertClientCapability({
      clientId: 'web-1',
      kind: 'web',
      user: USER,
      canCoordinateClientOwnedThread: true,
    });
    const first = await coordinator.activate({ thread: THREAD, ownerUser: USER });
    expect(first?.ownerClientId).toBe('web-1');

    now = new Date('2026-06-14T10:00:02.000Z');
    await coordinator.upsertClientCapability({
      clientId: 'cli-1',
      kind: 'cli',
      user: USER,
      canCoordinateClientOwnedThread: true,
    });
    const moved = await coordinator.activate({ thread: THREAD, ownerUser: USER });

    expect(moved?.ownerClientId).toBe('cli-1');
    expect(moved?.fencingToken).not.toBe(first?.fencingToken);
  });

  it('only releases a lease from its current owner', async () => {
    const coordinator = new ClientReconcilerCoordinator({
      now: () => new Date('2026-06-14T10:00:00.000Z'),
    });
    await coordinator.upsertClientCapability({
      clientId: 'desktop-1',
      kind: 'desktop',
      user: USER,
      canCoordinateClientOwnedThread: true,
    });
    await coordinator.activate({ thread: THREAD, ownerUser: USER });

    await expect(coordinator.releaseLease({
      thread: THREAD,
      ownerUser: USER,
      clientId: 'web-1',
    })).resolves.toBe(false);
    expect(await coordinator.getLease(THREAD)).toMatchObject({ ownerClientId: 'desktop-1' });

    await expect(coordinator.releaseLease({
      thread: THREAD,
      ownerUser: USER,
      clientId: 'desktop-1',
    })).resolves.toBe(true);
    await expect(coordinator.getLease(THREAD)).resolves.toBeUndefined();
  });
});
