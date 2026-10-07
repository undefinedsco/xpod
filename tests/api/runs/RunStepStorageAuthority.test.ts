import { describe, expect, it } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import type { SQL } from 'drizzle-orm';
import { Parser as SparqlParser } from 'sparqljs';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { PodChatKitStore } from '../../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../../src/api/chatkit/store';
import { TaskMaterializer } from '../../../src/api/tasks/TaskMaterializer';
import { RunStateCenter } from '../../../src/api/runs/RunStateCenter';
import { ManagedRunWorker } from '../../../src/api/runs/ManagedRunWorker';
import { RunStep } from '../../../src/api/runs/schema';
import type { RunRecordData } from '../../../src/api/runs/store';
import type { RunExecutionBackend } from '../../../src/api/runs/RunExecutionBackend';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const STORAGE = 'https://storage.example/alice/';
const run: RunRecordData = {
  id: 'task/task_1/2026/10/03/runs.ttl#run_1',
  thread: `${STORAGE}.data/task/task_1/index.ttl#thread_1`,
  workspace: `${STORAGE}work/`, runner: 'urn:test:runner', status: 'running', createdAt: 1, updatedAt: 1,
};

function fixture() {
  const serializer = drizzle({ fetch, info: { webId: WEB_ID, isLoggedIn: true } }, { podUrl: STORAGE });
  const rows: Record<string, unknown>[] = [];
  const quads: Quad[] = [];
  const db = {
    getDialect: () => serializer.getDialect(),
    insert: (resource: typeof RunStep) => ({ values: async (values: Record<string, unknown>) => {
      const parsed = new SparqlParser().parse(serializer.insert(resource).values(values as never).toSPARQL().query);
      if (parsed.type !== 'update') throw new Error('Expected ORM INSERT');
      const stored: Record<string, unknown> = { ...values };
      for (const update of parsed.updates) {
        if (!('updateType' in update) || update.updateType !== 'insert') throw new Error('Expected INSERT DATA');
        for (const graph of update.insert) {
          if (graph.type !== 'graph') throw new Error('Expected document graph');
          for (const triple of graph.triples) {
            quads.push(DataFactory.quad(
              triple.subject as Quad['subject'], triple.predicate as Quad['predicate'], triple.object as Quad['object']));
            // The ORM stores the resolved relation IRI; emulate that read-back shape.
            const predicate = triple.predicate as { value?: string };
            if (predicate.value === RunStep.columns.run.options.predicate) {
              stored.run = triple.object.value;
            }
          }
        }
      }
      rows.push(stored);
    } }),
    select: () => ({ from: (resource: typeof RunStep) => ({ where: async (condition: SQL) => {
      const query = serializer.select().from(resource).where(condition).toSPARQL().query;
      return rows.filter(row => query.includes(`<${String(row.run)}>`));
    } }) }),
  };
  // Standalone's existing internal context contract: the supplied database was opened with
  // an explicit storage binding. No root cache is copied; producers must ask the store first.
  const context = { userId: WEB_ID, auth: { type: 'solid', webId: WEB_ID }, _cachedDb: db } as StoreContext;
  return { store: new PodChatKitStore({}), context, rows, quads };
}

type StepProducer = { appendRunStep(run: RunRecordData, type: string, context: StoreContext): Promise<void> };
const producers = {
  TaskMaterializer: (store: PodChatKitStore) => new TaskMaterializer({ store, executeRuns: false }),
  RunStateCenter: (store: PodChatKitStore) => new RunStateCenter({ store }),
  ManagedRunWorker: (store: PodChatKitStore) => new ManagedRunWorker({ store, runtimeDriver: {} as RunExecutionBackend }),
};

describe('RunStep storage binding across an independent Cloud WebID', () => {
  it.each(Object.entries(producers))('%s writes steps that the same Pod store reads back', async (_name, create) => {
    const { store, context, quads } = fixture();
    const producer = create(store) as unknown as StepProducer;
    await producer.appendRunStep(run, 'run.started', context);
    const events = await store.loadRunSteps(run.id, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: run.id, run: run.id, type: 'run.started' });
    const relation = quads.find(quad => quad.predicate.value === RunStep.columns.run.options.predicate);
    expect(relation?.object.termType).toBe('NamedNode');
    expect(relation?.object.value).toBe(`${STORAGE}.data/${run.id}`);
    expect(quads.some(quad => quad.object.value.startsWith('https://id.example/'))).toBe(false);
  });

  it('rejects a caller-supplied run URI outside the current bound Pod instead of silently rebinding it', async () => {
    const { store, context, rows } = fixture();
    await expect(store.appendRunStep({ id: run.id.replace('#run_1', '#step_1'), runId: run.id, run: `https://id.example/alice/.data/${run.id}`,
      type: 'run.started', createdAt: 1 }, context)).rejects.toThrow(/run relation.*current Pod/);
    expect(rows).toHaveLength(0);
  });

  it('rejects an absolute foreign Run id before inserting a step', async () => {
    const { store, context, rows } = fixture();
    await expect(store.appendRunStep({ id: run.id.replace('#run_1', '#step_1'), runId: `https://foreign.example/.data/${run.id}`,
      run: `https://foreign.example/.data/${run.id}`, type: 'run.started', createdAt: 1 }, context)).rejects.toThrow(/complete Run resource id/);
    expect(rows).toHaveLength(0);
  });
});
