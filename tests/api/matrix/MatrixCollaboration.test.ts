import { describe, expect, it, vi } from 'vitest';
import { deliveryResource, messageResource, MessageRole, runResource, runStepResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { InMemoryWakeAgentQueue } from '../../../src/api/reconciler/WakeAgentQueue';
import { ServerGroupReconcilerService } from '../../../src/api/reconciler/ServerGroupReconcilerService';
import { AgentWakeRuntimeService } from '../../../src/api/reconciler/AgentWakeRuntimeService';
import { getProtocolMetadata, withProtocolMetadata } from '../../../src/api/protocol-metadata';
import { readPersistedEvent, verifyPersistedEvent } from '../../../src/api/matrix/persistedEvent';

const agentA = 'https://pod.example/alice/agents/builder#this';
const agentB = 'https://pod.example/alice/agents/reviewer#this';

async function fixture() {
  const { context, rows, db } = matrixHarness();
  const queue = new InMemoryWakeAgentQueue();
  const journal = new InMemoryMatrixEventJournal();
  const makeStore = (wakeQueue = queue) => new PodMatrixStore({ serverName: 'example.test', journal,
    serverGroupReconcilerService: new ServerGroupReconcilerService({ wakeQueue }) });
  const store = makeStore();
  const runtime = new AgentWakeRuntimeService(queue, store);
  const room = await store.createRoom({ name: 'Build and review' }, context);
  await store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [
    { agent: agentA, executor: context.webId, workspace: context.podUrl, allowedActors: [context.webId], handoffTo: [agentB] },
    { agent: agentB, executor: context.webId, workspace: context.podUrl, allowedActors: [context.webId], handoffTo: [] },
  ] }, context);
  const request = (agent = agentA) => ({ roomId: room.roomId, agent, runtimeId: 'contract-test' });
  const content = { body: 'Implement the task', msgtype: 'm.text', 'co.undefineds.mentions': [agentA] };
  return { context, rows, db, queue, journal, store, runtime, room, request, content, makeStore };
}

describe('Matrix collaboration contract (in-memory persistence; no LLM)', () => {
  it('delivers builder → reviewer results with shared run/delivery evidence and no wakes after restart', async () => {
    const f = await fixture();
    const trigger = await f.store.sendEvent(f.room.roomId, 'm.room.message', 'task-1', f.content, f.context);
    const first = await f.runtime.claim(f.request(), f.context);
    expect(first.input?.content).toBe('Implement the task');
    expect(first.input?.workspace).toBe(f.context.podUrl);
    const resultA = await f.runtime.complete({ ...f.request(), id: first.job!.id, fencingToken: first.job!.fencingToken!,
      body: 'Implementation is ready', handoffTo: agentB, evidence: ['https://pod.example/alice/artifacts/build'] }, f.context);
    const second = await f.runtime.claim(f.request(agentB), f.context);
    expect(second.input?.content).toBe('Implementation is ready');
    const resultB = await f.runtime.complete({ ...f.request(agentB), id: second.job!.id, fencingToken: second.job!.fencingToken!,
      body: 'Review accepted', evidence: ['https://pod.example/alice/artifacts/review'] }, f.context);
    const sync = await f.store.sync(f.context, { limit: 100 });
    const events = sync.rooms.join[f.room.roomId].timeline.events;
    expect(events.find(event => event.event_id === resultA.eventId)?.content.body).toBe('Implementation is ready');
    expect(events.find(event => event.event_id === resultB.eventId)?.content.body).toBe('Review accepted');
    expect(events.find(event => event.event_id === resultA.eventId)?.content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: trigger.eventId } });
    const messages = f.rows.get(messageResource)!;
    expect(messages.filter(row => row.role === MessageRole.ASSISTANT)).toHaveLength(2);
    const deliveries = f.rows.get(deliveryResource)!;
    const runs = f.rows.get(runResource)!;
    expect(deliveries).toHaveLength(2);
    expect(runs).toHaveLength(2);
    expect(deliveries.every(row => row.status === 'completed')).toBe(true);
    expect(runs.every(row => row.status === 'completed' && row.input && row.workspace === f.context.podUrl)).toBe(true);
    for (const run of runs) {
      expect(deliveries.some(delivery => run.delivery === deliveryResource.buildIri(f.context.podUrl, { id: delivery.id }))).toBe(true);
    }
    expect(f.rows.get(runStepResource)!.filter(row => row.stepType === 'run.completed')).toHaveLength(2);
    const restartedQueue = new InMemoryWakeAgentQueue();
    const restarted = new AgentWakeRuntimeService(restartedQueue, f.makeStore(restartedQueue));
    expect(await restarted.claim(f.request(), f.context)).toEqual({ job: null });
    expect(await restarted.claim(f.request(agentB), f.context)).toEqual({ job: null });
  });

  it('rejects ungranted actors, executors, and handoff targets without delivering work', async () => {
    const f = await fixture();
    const attacker = { ...f.context, webId: 'https://mallory.example/#me' };
    await expect(f.runtime.claim(f.request(), attacker)).rejects.toMatchObject({ status: 403 });
    await expect(f.runtime.claim(f.request('https://pod.example/alice/agents/unregistered'), f.context)).rejects.toMatchObject({ status: 403 });
    await expect(f.store.sendEvent(f.room.roomId, 'm.room.message', 'bad-target', { ...f.content,
      'co.undefineds.mentions': ['https://pod.example/alice/agents/unregistered'] }, f.context)).rejects.toMatchObject({ status: 403 });
    await f.store.sendEvent(f.room.roomId, 'm.room.message', 'task-1', f.content, f.context);
    const { job } = await f.runtime.claim(f.request(), f.context);
    await expect(f.runtime.complete({ ...f.request(), id: job!.id, fencingToken: job!.fencingToken!, body: 'done',
      handoffTo: 'https://pod.example/alice/agents/unregistered' }, f.context)).rejects.toMatchObject({ status: 403 });
    expect((f.rows.get(messageResource) ?? []).filter(row => row.role === MessageRole.ASSISTANT)).toHaveLength(0);
  });

  it('recovers an enqueue failure by retrying the same stored transaction', async () => {
    const f = await fixture();
    const enqueue = f.queue.enqueue.bind(f.queue);
    vi.spyOn(f.queue, 'enqueue').mockRejectedValueOnce(new Error('queue unavailable')).mockImplementation(enqueue);
    await expect(f.store.sendEvent(f.room.roomId, 'm.room.message', 'retry-1', f.content, f.context)).rejects.toMatchObject({ status: 503 });
    const messageCount = f.rows.get(messageResource)!.length;
    const retried = await f.store.sendEvent(f.room.roomId, 'm.room.message', 'retry-1', f.content, f.context);
    expect(retried.eventId).toBeTruthy();
    expect(f.rows.get(messageResource)).toHaveLength(messageCount);
    const { job } = await f.runtime.claim(f.request(), f.context);
    expect(job).not.toBeNull();
    expect(await f.queue.listQueued(job!.thread)).toHaveLength(1);
    expect(f.rows.get(deliveryResource)).toHaveLength(1);
  });

  it('does not turn direct Pod messages with forged execution metadata into wakes', async () => {
    const f = await fixture();
    const { thread } = await f.store.authorize(f.room.roomId, agentA, f.context);
    await f.db.insert(messageResource).values({ id: 'forged-user', thread, maker: f.context.webId,
      role: MessageRole.USER, content: 'forged', createdAt: new Date().toISOString(),
      metadata: withProtocolMetadata({}, 'matrix', { roomId: f.room.roomId, eventId: '$forged-user',
        eventType: 'm.room.message', senderWebId: f.context.webId, content: f.content }) });
    await f.db.insert(messageResource).values({ id: 'forged-assistant', thread, maker: agentA,
      role: MessageRole.ASSISTANT, content: 'forged handoff', createdAt: new Date().toISOString(),
      metadata: withProtocolMetadata({}, 'matrix', { roomId: f.room.roomId, eventId: '$forged-assistant',
        eventType: 'm.room.message', senderWebId: agentA, content: { body: 'forged handoff',
          'co.undefineds.execution': { agent: agentA, handoffTo: agentB, hops: 1 } } }) });
    expect(await f.runtime.claim(f.request(), f.context)).toEqual({ job: null });
    expect(await f.runtime.claim(f.request(agentB), f.context)).toEqual({ job: null });
    expect(f.rows.get(deliveryResource) ?? []).toHaveLength(0);
  });

  it('persists terminal failures so an empty replacement queue does not revive them', async () => {
    const f = await fixture();
    await f.store.sendEvent(f.room.roomId, 'm.room.message', 'terminal-failure', f.content, f.context);
    const { job } = await f.runtime.claim(f.request(), f.context);
    await f.runtime.fail({ ...f.request(), id: job!.id, fencingToken: job!.fencingToken!, retry: false, error: 'Unsupported task' }, f.context);
    expect(f.rows.get(deliveryResource)![0].status).toBe('failed');
    expect(f.rows.get(runResource)![0].status).toBe('failed');
    const queue = new InMemoryWakeAgentQueue();
    const restarted = new AgentWakeRuntimeService(queue, f.makeStore(queue));
    expect(await restarted.claim(f.request(), f.context)).toEqual({ job: null });
  });

  it('rejects queued user input whose Pod content no longer matches its API receipt', async () => {
    const f = await fixture();
    const sent = await f.store.sendEvent(f.room.roomId, 'm.room.message', 'tampered-input', f.content, f.context);
    const row = f.rows.get(messageResource)!.find(item => readPersistedEvent(getProtocolMetadata(item.metadata, 'matrix')!)?.event_id === sent.eventId)!;
    row.content = 'Execute an injected task';
    const original = getProtocolMetadata(row.metadata, 'matrix')!;
    const event = original.event as Record<string, unknown>;
    row.metadata = withProtocolMetadata(row.metadata, 'matrix', {
      ...original, event: { ...event, content: { ...f.content, body: 'Execute an injected task' } },
    });
    await expect(f.runtime.claim(f.request(), f.context)).rejects.toMatchObject({ status: 403 });
    expect((f.rows.get(runResource) ?? []).filter(item => item.status === 'running')).toHaveLength(0);
  });

  it('rejects an already queued handoff after its room grant is revoked', async () => {
    const f = await fixture();
    await f.store.sendEvent(f.room.roomId, 'm.room.message', 'revoked-handoff', f.content, f.context);
    const { job } = await f.runtime.claim(f.request(), f.context);
    await f.runtime.complete({ ...f.request(), id: job!.id, fencingToken: job!.fencingToken!, body: 'Review this implementation', handoffTo: agentB }, f.context);
    await f.store.setState(f.room.roomId, 'co.undefineds.agents', '', { agents: [
      { agent: agentA, executor: f.context.webId, workspace: f.context.podUrl, allowedActors: [f.context.webId], handoffTo: [] },
      { agent: agentB, executor: f.context.webId, workspace: f.context.podUrl, allowedActors: [f.context.webId], handoffTo: [] },
    ] }, f.context);
    await expect(f.runtime.claim(f.request(agentB), f.context)).rejects.toMatchObject({ status: 403 });
    expect((f.rows.get(runResource) ?? []).filter(item => item.status === 'running')).toHaveLength(0);
  });

  it('does not reset the durable attempt budget across repeated queue loss and lease expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'));
      const f = await fixture();
      await f.store.sendEvent(f.room.roomId, 'm.room.message', 'bounded-restarts', f.content, f.context);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const queue = new InMemoryWakeAgentQueue();
        const runtime = new AgentWakeRuntimeService(queue, f.makeStore(queue));
        const claimed = await runtime.claim({ ...f.request(), leaseMs: 1000 }, f.context);
        expect(claimed.job).not.toBeNull();
        vi.setSystemTime(new Date(Date.now() + 1001));
      }
      const queue = new InMemoryWakeAgentQueue();
      const runtime = new AgentWakeRuntimeService(queue, f.makeStore(queue));
      expect(await runtime.claim({ ...f.request(), leaseMs: 1000 }, f.context)).toEqual({ job: null });
      expect(f.rows.get(deliveryResource)![0].status).toBe('failed');
      expect(f.rows.get(runResource)![0].status).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects tampering with an already queued assistant handoff hop count and root', async () => {
    const f = await fixture();
    await f.store.sendEvent(f.room.roomId, 'm.room.message', 'tampered-handoff', f.content, f.context);
    const { job } = await f.runtime.claim(f.request(), f.context);
    const output = await f.runtime.complete({ ...f.request(), id: job!.id, fencingToken: job!.fencingToken!, body: 'Review', handoffTo: agentB }, f.context);
    const row = f.rows.get(messageResource)!.find(item => readPersistedEvent(getProtocolMetadata(item.metadata, 'matrix')!)?.event_id === output.eventId)!;
    const matrix = getProtocolMetadata(row.metadata, 'matrix')!;
    const event = matrix.event as Record<string, unknown>;
    const content = event.content as Record<string, unknown>;
    row.metadata = withProtocolMetadata(row.metadata, 'matrix', { ...matrix, event: { ...event, content: { ...content,
      'co.undefineds.execution': { ...(content['co.undefineds.execution'] as object), hops: 0, root: 'https://attacker.example/root' },
    } } });
    await expect(f.runtime.claim(f.request(agentB), f.context)).rejects.toMatchObject({ status: 403 });
  });

  it('preserves a renewed third-attempt lease beyond the original persisted expiry during recovery', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T01:00:00.000Z'));
      const f = await fixture();
      await f.store.sendEvent(f.room.roomId, 'm.room.message', 'renewed-third-attempt', f.content, f.context);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await f.runtime.claim({ ...f.request(), leaseMs: 1000 }, f.context)).job).not.toBeNull();
        vi.setSystemTime(new Date(Date.now() + 1001));
      }
      const { job } = await f.runtime.claim({ ...f.request(), leaseMs: 1000 }, f.context);
      const lease = { ...f.request(), id: job!.id, fencingToken: job!.fencingToken!, leaseMs: 10_000 };
      await f.runtime.renew(lease, f.context);
      vi.setSystemTime(new Date(Date.now() + 1001));
      expect(await f.runtime.claim(f.request(), f.context)).toEqual({ job: null });
      expect(f.rows.get(runResource)![0].status).toBe('running');
      expect(f.rows.get(deliveryResource)![0].status).not.toBe('failed');
      await expect(f.runtime.complete({ ...lease, body: 'Completed within renewed lease' }, f.context)).resolves.toMatchObject({ eventId: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('seals an existing assistant result after a third-attempt crash before run and delivery completion', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T02:00:00.000Z'));
      const f = await fixture();
      await f.store.sendEvent(f.room.roomId, 'm.room.message', 'result-write-crash', f.content, f.context);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await f.runtime.claim({ ...f.request(), leaseMs: 1000 }, f.context)).job).not.toBeNull();
        vi.setSystemTime(new Date(Date.now() + 1001));
      }
      const { job } = await f.runtime.claim({ ...f.request(), leaseMs: 1000 }, f.context);
      expect(job?.attempts).toBe(3);
      const update = f.db.updateById.bind(f.db);
      const spy = vi.spyOn(f.db, 'updateById').mockImplementation(async (...args: unknown[]) => {
        const [table, , value] = args;
        if (table === runResource && (value as { status?: string }).status === 'completed') {
          throw new Error('Injected crash after output persistence');
        }
        return update(...args);
      });
      try {
        await expect(f.runtime.complete({ ...f.request(), id: job!.id, fencingToken: job!.fencingToken!,
          body: 'Durable result before crash' }, f.context)).rejects.toThrow('Injected crash after output persistence');
      } finally {
        spy.mockRestore();
      }
      expect(f.rows.get(messageResource)!.filter(row => row.role === MessageRole.ASSISTANT)).toHaveLength(1);
      expect(f.rows.get(runResource)![0].status).toBe('running');
      // Pod JSON persistence drops undefined fields such as an absent handoffTo.
      for (const row of f.rows.get(messageResource)!) {
        row.metadata = JSON.parse(JSON.stringify(row.metadata));
      }
      vi.setSystemTime(new Date(Date.now() + 30_001));
      const queue = new InMemoryWakeAgentQueue();
      const restarted = new AgentWakeRuntimeService(queue, f.makeStore(queue));
      expect(await restarted.claim(f.request(), f.context)).toEqual({ job: null });
      expect(f.rows.get(runResource)![0].status).toBe('completed');
      expect(f.rows.get(deliveryResource)![0].status).toBe('completed');
      expect(f.rows.get(messageResource)!.filter(row => row.role === MessageRole.ASSISTANT)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a replacement execution commit after a reservation whose output never reached the Pod', async () => {
    const f = await fixture();
    await f.store.sendEvent(f.room.roomId, 'm.room.message', 'dangling-result', f.content, f.context);
    const claimed = await f.runtime.claim(f.request(), f.context);
    const job = claimed.job!;
    // Attempt 1 reserves its result and dies before the ASSISTANT Message lands.
    const reserve = f.journal.reserveTransaction.bind(f.journal);
    const crashAfterReservation = vi.spyOn(f.journal, 'reserveTransaction')
      .mockImplementation(async (scope, key, candidate) => {
        const reservation = await reserve(scope, key, candidate);
        if (key.includes('wake-result')) throw new Error('Injected crash after result reservation');
        return reservation;
      });
    try {
      await expect(f.store.commitResult(f.room.roomId, job, { body: 'attempt one' }, f.context))
        .rejects.toThrow('Injected crash after result reservation');
    } finally {
      crashAfterReservation.mockRestore();
    }
    expect(f.rows.get(messageResource)!.filter(row => row.role === MessageRole.ASSISTANT)).toHaveLength(0);

    // Attempt 2 cannot reproduce the same bytes, which must not block it forever.
    const replacement = f.makeStore();
    const result = await replacement.commitResult(f.room.roomId, job, { body: 'attempt two' }, f.context);
    expect(typeof result.eventId).toBe('string');
    const assistants = f.rows.get(messageResource)!.filter(row => row.role === MessageRole.ASSISTANT);
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe('attempt two');
    // Taking the reservation over replaces its event id, so the row must carry the
    // event the journal now names; an id that no row carries would strand the result.
    const stored = readPersistedEvent(getProtocolMetadata(assistants[0].metadata, 'matrix')!)!;
    expect(stored.event_id).toBe(result.eventId);
    expect(verifyPersistedEvent(stored)).toEqual({ hasEventId: true, contentHashMatches: true, signed: false });
  });

  it('starts a fresh execution chain for user input despite supplied execution metadata', async () => {
    const f = await fixture();
    await f.store.sendEvent(f.room.roomId, 'm.room.message', 'user-chain-injection', { ...f.content,
      'co.undefineds.execution': { hops: -999, root: 'fake', agent: agentA },
    }, f.context);
    const { job } = await f.runtime.claim(f.request(), f.context);
    const result = await f.runtime.complete({ ...f.request(), id: job!.id, fencingToken: job!.fencingToken!,
      body: 'First authorized stage', handoffTo: agentB }, f.context);
    const event = await f.store.getEvent(f.room.roomId, result.eventId, f.context);
    expect(event.content['co.undefineds.execution']).toMatchObject({ hops: 1, root: job!.triggerMessage });
  });

  it('does not accept a user receipt as an assistant receipt after direct Pod role tampering', async () => {
    const f = await fixture();
    // An executor WebID may also identify an agent; domain separation must still hold.
    await f.store.setState(f.room.roomId, 'co.undefineds.agents', '', { agents: [
      { agent: f.context.webId, executor: f.context.webId, workspace: f.context.podUrl, allowedActors: [f.context.webId], handoffTo: [agentA] },
      { agent: agentA, executor: f.context.webId, workspace: f.context.podUrl, allowedActors: [f.context.webId], handoffTo: [] },
    ] }, f.context);
    const sent = await f.store.sendEvent(f.room.roomId, 'm.room.message', 'role-tampering', { ...f.content,
      'co.undefineds.execution': { agent: f.context.webId, handoffTo: agentA, hops: 1, root: 'https://pod.example/root' },
    }, f.context);
    const row = f.rows.get(messageResource)!.find(item => readPersistedEvent(getProtocolMetadata(item.metadata, 'matrix')!)?.event_id === sent.eventId)!;
    row.role = MessageRole.ASSISTANT;
    await expect(f.runtime.claim(f.request(), f.context)).rejects.toMatchObject({ status: 403 });
    expect((f.rows.get(runResource) ?? []).filter(item => item.status === 'running')).toHaveLength(0);
  });
});
