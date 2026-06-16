import { describe, expect, it } from 'vitest';
import {
  InMemoryWakeAgentQueue,
  ServerGroupReconcilerService,
  wakeAgentQueueKey,
} from '../../../src/api/reconciler';

const THREAD = 'https://alice.example/.data/chat/team/index.ttl#this';
const MESSAGE = 'https://alice.example/.data/chat/team/2026/06/14/messages.ttl#msg_1';
const SECRETARY = 'https://alice.example/.data/agents/secretary.ttl#this';
const REVIEWER = 'https://alice.example/.data/agents/reviewer.ttl#this';

describe('ServerGroupReconcilerService', () => {
  it('enqueues explicit routeTargetAgent with semantic wake fields', async () => {
    const queue = new InMemoryWakeAgentQueue();
    const service = new ServerGroupReconcilerService({
      wakeQueue: queue,
      now: () => new Date('2026-06-14T10:00:00.000Z'),
    });

    const result = await service.reconcileThreadMessage({
      thread: THREAD,
      triggerMessage: MESSAGE,
      actor: 'https://alice.example/profile/card#me',
      role: 'user',
      content: 'hello team',
      reconcilerOwner: 'server',
      routeTargetAgent: SECRETARY,
    });

    expect(result.inserted).toBe(1);
    expect(result.wakeJobs).toEqual([
      expect.objectContaining({
        thread: THREAD,
        triggerMessage: MESSAGE,
        agent: SECRETARY,
        reason: 'manual',
        status: 'queued',
      }),
    ]);
    expect(wakeAgentQueueKey(result.wakeJobs[0])).toBe(`steer_queue:${THREAD}:${SECRETARY}`);
  });

  it('skips client-owned threads because client reconciliation is client-side', async () => {
    const service = new ServerGroupReconcilerService({ wakeQueue: new InMemoryWakeAgentQueue() });

    await expect(service.reconcileThreadMessage({
      thread: THREAD,
      triggerMessage: MESSAGE,
      reconcilerOwner: 'client',
      role: 'user',
      content: '@secretary please help',
      mentions: [SECRETARY],
    })).resolves.toMatchObject({
      inserted: 0,
      skippedReason: 'not_server_reconciled',
    });
  });

  it('dedupes repeated wake decisions by thread, trigger message, and agent', async () => {
    const service = new ServerGroupReconcilerService({ wakeQueue: new InMemoryWakeAgentQueue() });
    const input = {
      thread: THREAD,
      triggerMessage: MESSAGE,
      reconcilerOwner: 'server' as const,
      role: 'user',
      content: '@secretary please help',
      mentions: [SECRETARY],
    };

    const first = await service.reconcileThreadMessage(input);
    const second = await service.reconcileThreadMessage(input);

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.wakeJobs[0].id).toBe(first.wakeJobs[0].id);
  });

  it('wakes only mentioned agents from model mention fields', async () => {
    const service = new ServerGroupReconcilerService({ wakeQueue: new InMemoryWakeAgentQueue() });

    const result = await service.reconcileThreadMessage({
      thread: THREAD,
      triggerMessage: MESSAGE,
      reconcilerOwner: 'server',
      role: 'user',
      content: '@reviewer check this',
      mentions: [REVIEWER],
      participants: [SECRETARY, REVIEWER],
    });

    expect(result.inserted).toBe(1);
    expect(result.wakeJobs.map((job) => job.agent)).toEqual([REVIEWER]);
    expect(result.wakeJobs[0].reason).toBe('mention');
  });
});
