import { describe, expect, it } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { cancelRun } from '../../src/api/runs/RunCancellation';
import type { RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';

describe('first Chat runtime cancellation', () => {
  it('aborts a silent first provider call and ends the same durable Run', async () => {
    const store = new InMemoryStore<StoreContext>();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let aborted = false;
    const backend = { async *start(input: RunExecutionInput) {
      started();
      await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    } };
    const service = new ChatKitService({ store, enableAgentRuntime: true, runExecutionBackend: backend });
    const context = { userId: 'owner', auth: { type: 'solid', webId: 'https://pod.example/alice/profile/card#me' } };
    const result = await service.process(JSON.stringify({ type: 'threads.create', params: {
      workspace: 'https://pod.example/alice/', input: { content: [{ type: 'input_text', text: 'Wait for me' }] },
    }, metadata: { runtime: { runner: { type: 'pi', protocol: 'pi' } } } }), context);
    const drain = (async () => { if (result.type === 'streaming') for await (const _chunk of result.stream()) { /* Drain until Stop. */ } })();
    await running;
    const [run] = await store.listRuns({}, context);
    await cancelRun({ store, runId: run.id, context, resourceIri: () => 'https://pod.example/alice/run' });
    await drain;
    expect(aborted).toBe(true);
    expect(await store.loadRun(run.id, context)).toMatchObject({ id: run.id, status: 'cancelled' });
    expect((await store.loadRunSteps(run.id, context)).some(step => step.type === 'run.cancelled')).toBe(true);
  });
});
