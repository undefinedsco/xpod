import { describe, expect, it } from 'vitest';
import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../../src/api/chatkit/store';
import { Run } from '../../../src/api/runs/schema';
import type { RunRecordData } from '../../../src/api/runs/store';

const relations = {
  delivery: 'https://pod.example/alice/.data/chat/default/2026/09/22/deliveries.ttl#delivery_1',
  trigger: 'https://pod.example/alice/.data/chat/default/index.ttl#trigger_1',
  input: 'https://pod.example/alice/.data/chat/default/2026/09/22/messages.ttl#message_1',
};
const run: RunRecordData = {
  id: 'chat/default/2026/09/22/runs.ttl#run_1',
  thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
  workspace: 'https://pod.example/alice/workspaces/default/',
  status: 'queued',
  runner: 'https://pod.example/alice/agents/worker#this',
  createdAt: Date.UTC(2026, 8, 22) / 1000,
  updatedAt: Date.UTC(2026, 8, 22) / 1000,
};

function fixture(initial?: Record<string, unknown>) {
  const rows = new Map<string, Record<string, unknown>>();
  if (initial) {
    rows.set(run.id, initial);
  }
  const db = {
    findById: async (resource: unknown, id: string) => {
      expect(resource).toBe(Run);
      return rows.get(id) ?? null;
    },
    insert: (resource: unknown) => {
      expect(resource).toBe(Run);
      return { values: async (values: Record<string, unknown>) => rows.set(values.id as string, { ...values }) };
    },
    updateById: async (resource: unknown, id: string, values: Record<string, unknown>) => {
      expect(resource).toBe(Run);
      rows.set(id, { ...rows.get(id), ...values });
    },
  };
  const context = { _cachedDb: db, _cachedPodBaseUrl: 'https://pod.example/alice/' } as StoreContext;
  return { store: new PodChatKitStore({}), context, rows };
}

describe('Run collaboration relations', () => {
  it('persists and reads all three shared URI relations when creating a Run', async () => {
    const { store, context, rows } = fixture();
    await store.saveRun({ ...run, ...relations }, context);
    expect(rows.get(run.id)).toMatchObject(relations);
    expect(await store.loadRun(run.id, context)).toMatchObject({ ...run, ...relations });
  });

  it('preserves externally written relations through a runtime status update', async () => {
    const { store, context, rows } = fixture({
      ...run,
      ...relations,
      createdAt: new Date(run.createdAt * 1000).toISOString(),
      updatedAt: new Date(run.updatedAt * 1000).toISOString(),
    });
    const loaded = await store.loadRun(run.id, context);
    await store.saveRun({ ...loaded, status: 'running', updatedAt: run.updatedAt + 1 }, context);
    expect(rows.get(run.id)).toMatchObject({ ...relations, status: 'running' });
    expect(await store.loadRun(run.id, context)).toMatchObject({ ...relations, status: 'running' });
  });

  it('round-trips legacy Runs with absent optional relations', async () => {
    const { store, context } = fixture();
    await store.saveRun({ ...run }, context);
    const loaded = await store.loadRun(run.id, context);
    expect(loaded.delivery).toBeUndefined();
    expect(loaded.trigger).toBeUndefined();
    expect(loaded.input).toBeUndefined();
    await store.saveRun({ ...loaded, status: 'running' }, context);
    expect(await store.loadRun(run.id, context)).toMatchObject({ ...run, status: 'running' });
  });
});
