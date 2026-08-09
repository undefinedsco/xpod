import { describe, expect, it, vi } from 'vitest';
import { RuntimeAiConfigLifecycleService } from '../../../src/api/ai-config/AiConfigLifecycleService';

const owner = { webId: 'https://id.example/alice#me', podUrl: 'https://pod.example/alice/' };

describe('RuntimeAiConfigLifecycleService', () => {
  it('queues, executes and retains successful rebuild evidence by Pod', async () => {
    let release!: () => void;
    const executor = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = new RuntimeAiConfigLifecycleService({ executors: { all: executor }, now: sequenceClock() });

    const job = await service.schedule({ ...owner, target: 'all' });
    expect(job.status).toBe('queued');
    expect((await service.status(owner)).pending).toBe(1);

    await waitUntil(() => executor.mock.calls.length === 1);
    expect((await service.status(owner)).recent[0]?.status).toBe('running');
    release();
    await waitUntil(async () => (await service.status(owner)).recent[0]?.status === 'succeeded');

    const status = await service.status(owner);
    expect(status.pending).toBe(0);
    expect(status.recent[0]).toMatchObject({ target: 'all', status: 'succeeded', progress: 100 });
  });

  it('isolates jobs by Pod and records redacted failures', async () => {
    const service = new RuntimeAiConfigLifecycleService({
      executors: { fts: vi.fn(async () => { throw new Error('apiKey=secret failed'); }) },
    });
    await service.schedule({ ...owner, target: 'fts' });
    await waitUntil(async () => (await service.status(owner)).recent[0]?.status === 'failed');
    expect((await service.status(owner)).recent[0]?.error).toBe('Rebuild failed');
    expect((await service.status({ webId: 'https://id.example/bob#me', podUrl: 'https://pod.example/bob/' })).recent).toEqual([]);
  });

  it('reports only targets backed by a real executor', () => {
    const service = new RuntimeAiConfigLifecycleService({ executors: { vector: vi.fn(async () => undefined) } });
    expect(service.supportedTargets()).toEqual(['vector']);
  });
});

function sequenceClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 9, 0, 0, second++));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition not reached');
}
