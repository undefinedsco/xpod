import { describe, expect, it } from 'vitest';
import {
  activateClientReconciler,
  normalizeReconcilerOwner,
  reconcilerCoordinationMetadata,
  withReconcilerCoordinationMetadata,
  selectClientReconcilerClient,
  sharedWakeAgentJobDedupeKey,
  type ClientCapability,
  type ClientReconcilerLease,
  type SharedWakeAgentJob,
} from '../../../src/api/reconciler';

describe('Reconciler coordination contract', () => {
  it('uses owner-only coordination metadata', () => {
    expect(normalizeReconcilerOwner('client')).toBe('client');
    expect(normalizeReconcilerOwner('server')).toBe('server');
    expect(normalizeReconcilerOwner('direct')).toBe('client');
    expect(normalizeReconcilerOwner('group')).toBe('client');
    expect(reconcilerCoordinationMetadata('client')).toEqual({ reconcilerOwner: 'client' });
  });



  it('strips obsolete conversationKind metadata instead of preserving a topology enum', () => {
    expect(withReconcilerCoordinationMetadata({
      conversationKind: 'group',
      custom: true,
    }, 'server')).toEqual({
      custom: true,
      reconcilerOwner: 'server',
    });
  });

  it('dedupes wake jobs by thread, trigger message, and agent only', () => {
    const base: SharedWakeAgentJob = {
      id: 'wake-1',
      thread: 'https://pod.example/.data/chat/client-owned/index.ttl#thread',
      triggerMessage: 'https://pod.example/.data/chat/client-owned/2026/06/14/messages.ttl#msg_1',
      agent: 'https://pod.example/.data/agents/secretary.ttl',
      reason: 'mention',
      status: 'queued',
      createdAt: '2026-06-14T00:00:00.000Z',
    };
    const retried: SharedWakeAgentJob = {
      ...base,
      id: 'wake-2',
      reason: 'manual',
      status: 'failed',
      createdAt: '2026-06-14T00:00:30.000Z',
    };

    expect(sharedWakeAgentJobDedupeKey(base)).toBe(sharedWakeAgentJobDedupeKey(retried));
  });

  it('selects one active client-owned-thread client and prefers stable processes', () => {
    const now = new Date('2026-06-14T10:00:00.000Z');
    const clients: ClientCapability[] = [
      {
        clientId: 'web-1',
        kind: 'web',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [],
        heartbeatAt: '2026-06-14T09:59:59.000Z',
      },
      {
        clientId: 'desktop-1',
        kind: 'desktop',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: ['file://localhost/work/demo'],
        heartbeatAt: '2026-06-14T09:59:58.000Z',
      },
      {
        clientId: 'other-user-cli',
        kind: 'cli',
        user: 'https://bob.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [],
        heartbeatAt: '2026-06-14T09:59:59.000Z',
      },
    ];

    expect(selectClientReconcilerClient(clients, {
      ownerUser: 'https://alice.example/profile/card#me',
      now,
    })?.clientId).toBe('desktop-1');
  });

  it('keeps a fresh existing client-owned-thread lease owner active', () => {
    const now = new Date('2026-06-14T10:00:00.000Z');
    const currentLease: ClientReconcilerLease = {
      thread: 'https://pod.example/.data/chat/client-owned/index.ttl#thread',
      ownerClientId: 'web-1',
      ownerUser: 'https://alice.example/profile/card#me',
      fencingToken: 'token-1',
      expiresAt: '2026-06-14T10:00:10.000Z',
    };
    const clients: ClientCapability[] = [
      {
        clientId: 'web-1',
        kind: 'web',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [],
        heartbeatAt: '2026-06-14T09:59:59.000Z',
      },
      {
        clientId: 'cli-1',
        kind: 'cli',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [],
        heartbeatAt: '2026-06-14T09:59:59.000Z',
      },
    ];

    expect(selectClientReconcilerClient(clients, {
      ownerUser: 'https://alice.example/profile/card#me',
      now,
      currentLease,
    })?.clientId).toBe('web-1');
  });

  it('activates one client-owned-thread coordinator lease through the pod center helper', () => {
    const now = new Date('2026-06-14T10:00:00.000Z');
    const clients: ClientCapability[] = [
      {
        clientId: 'web-1',
        kind: 'web',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [],
        heartbeatAt: '2026-06-14T09:59:59.000Z',
      },
      {
        clientId: 'cli-1',
        kind: 'cli',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: ['file://localhost/work/demo'],
        heartbeatAt: '2026-06-14T09:59:59.000Z',
      },
    ];

    expect(activateClientReconciler({
      thread: 'https://pod.example/.data/chat/client-owned/index.ttl#thread',
      ownerUser: 'https://alice.example/profile/card#me',
      clients,
      now,
      fencingToken: 'fence-1',
    })).toMatchObject({
      thread: 'https://pod.example/.data/chat/client-owned/index.ttl#thread',
      ownerClientId: 'cli-1',
      ownerUser: 'https://alice.example/profile/card#me',
      fencingToken: 'fence-1',
      expiresAt: '2026-06-14T10:00:30.000Z',
    });
  });

  it('returns no client-owned-thread lease when no eligible client is alive', () => {
    expect(activateClientReconciler({
      thread: 'https://pod.example/.data/chat/client-owned/index.ttl#thread',
      ownerUser: 'https://alice.example/profile/card#me',
      clients: [{
        clientId: 'web-1',
        kind: 'web',
        user: 'https://alice.example/profile/card#me',
        canCoordinateClientOwnedThread: true,
        canRunAgent: true,
        workspaces: [],
        heartbeatAt: '2026-06-14T09:00:00.000Z',
      }],
      now: new Date('2026-06-14T10:00:00.000Z'),
    })).toBeUndefined();
  });
});
