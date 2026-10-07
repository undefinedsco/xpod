// Root-owned capability regression. Physical operation/drain qualification is separate.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DataFactory } from 'n3';
import { expect, it, vi } from 'vitest';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import { RdfQueryExecutor } from '../../../src/storage/rdf/RdfQueryExecutor';

it('preserves complete sync results but refuses a pending thenable before executing the embedded query', async () => {
  const parent = path.resolve('.test-data/authority-embedded-sync-return');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'root-'));
  const engine = new SolidRdfEngine({ index: { path: path.join(directory, 'rdf.sqlite') } });
  const graph = DataFactory.namedNode('https://root.invalid/alice/messages.ttl');
  const subject = DataFactory.namedNode(`${graph.value}#msg-id`);
  const predicate = DataFactory.namedNode('urn:root:sync-return');
  const query = { patterns: [{ graph, subject, predicate }] };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let providerCalls = 0;
  let restoreExecutor: (() => void) | undefined;
  try {
    await engine.open();
    engine.replaceSource([DataFactory.quad(subject, predicate, DataFactory.literal('retained'), graph)], {
      source: graph.value,
      workspace: 'https://root.invalid/',
    });
    engine.setAuthorityFreshnessProvider({ assertFresh: () => undefined, assertFreshSync: () => undefined });
    expect(engine.query(query).bindings).toHaveLength(1);
    const executor = vi.spyOn(RdfQueryExecutor.prototype, 'query');
    restoreExecutor = () => executor.mockRestore();
    engine.setAuthorityFreshnessProvider({
      assertFresh: () => undefined,
      assertFreshSync: () => { providerCalls += 1; return pending; },
    });
    let error: unknown;
    try { engine.query(query); } catch (caught) { error = caught; }
    expect(providerCalls).toBe(1);
    expect(error, 'pending asynchronous freshness cannot qualify a synchronous read')
      .toMatchObject({ statusCode: 503 });
    expect(executor, 'refusal must precede any query/index execution').not.toHaveBeenCalled();
  } finally {
    release();
    await pending;
    restoreExecutor?.();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
