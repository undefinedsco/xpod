import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { RdfAccessMode } from '../../../src/storage/rdf/RdfAccessScope';
import { RdfEngineRdfJsSource } from '../../../src/storage/rdf/RdfEngineRdfJsSource';
import type {
  RdfBindingRow,
  RdfEngineLike,
  RdfQuery,
  RdfQueryResult,
} from '../../../src/storage/rdf/types';

const { defaultGraph, literal, namedNode, quad, variable } = DataFactory;

const BASE_SCOPE = {
  basePath: 'https://pod.example/alice/.data/',
  mode: RdfAccessMode.READ,
  principal: 'https://id.example/alice/profile/card#me',
  version: 'acl-v1',
};

const ALLOWED_SOURCE = 'https://pod.example/alice/.data/imports/allowed.ttl';
const DENIED_SOURCE = 'https://pod.example/alice/.data/imports/denied.ttl';

describe('RdfEngineRdfJsSource', () => {
  it('returns a stream synchronously and queries through the scoped RDF engine path', async () => {
    const engine = fakeEngine([
      {
        subject: namedNode('https://pod.example/alice/.data/card#me'),
        predicate: namedNode('https://schema.org/name'),
        object: literal('Alice'),
        graph: namedNode('https://pod.example/alice/.data/card.ttl'),
      },
    ]);
    const source = new RdfEngineRdfJsSource(engine, {
      accessScope: {
        ...BASE_SCOPE,
        allowedSourceUrls: [ALLOWED_SOURCE],
      },
    });

    const stream = source.match(null, namedNode('https://schema.org/name'));
    expect(engine.query).not.toHaveBeenCalled();

    const quads = await streamToArray(stream);

    expect(quads).toEqual([
      quad(
        namedNode('https://pod.example/alice/.data/card#me'),
        namedNode('https://schema.org/name'),
        literal('Alice'),
        namedNode('https://pod.example/alice/.data/card.ttl'),
      ),
    ]);
    expect(engine.scan).not.toHaveBeenCalled();
    expect(engine.query).toHaveBeenCalledWith(expect.objectContaining({
      patterns: [expect.objectContaining({
        subject: { variable: 'subject' },
        predicate: namedNode('https://schema.org/name'),
        object: { variable: 'object' },
        graph: { variable: 'graph' },
        sourceScope: { allowedSources: [ALLOWED_SOURCE] },
      })],
      select: ['subject', 'object', 'graph'],
      cache: expect.objectContaining({
        scope: expect.objectContaining({
          allowedSourceUrls: [ALLOWED_SOURCE],
        }),
      }),
    }));
  });

  it('keeps default graph matches exact and returns default graph quads', async () => {
    const engine = fakeEngine([
      {
        subject: namedNode('urn:s'),
        predicate: namedNode('urn:p'),
        object: literal('default graph'),
      },
    ]);
    const source = new RdfEngineRdfJsSource(engine);

    const quads = await streamToArray(source.match(null, null, null, defaultGraph()));

    expect(quads).toEqual([
      quad(namedNode('urn:s'), namedNode('urn:p'), literal('default graph'), defaultGraph()),
    ]);
    expect(lastQuery(engine).patterns[0].graph).toEqual(defaultGraph());
  });

  it('treats RDF/JS variable terms as unbound so union-default-graph callers keep graph bindings', async () => {
    const engine = fakeEngine([
      {
        subject: namedNode('urn:s'),
        predicate: namedNode('urn:p'),
        object: namedNode('urn:o'),
        graph: namedNode('urn:g'),
      },
    ]);
    const source = new RdfEngineRdfJsSource(engine);

    const quads = await streamToArray(source.match(null, null, null, variable('g')));

    expect(quads[0].graph).toEqual(namedNode('urn:g'));
    expect(lastQuery(engine).patterns[0].graph).toEqual({ variable: 'graph' });
    expect(lastQuery(engine).select).toContain('graph');
  });

  it('passes denied source ACLs into every match query', async () => {
    const engine = fakeEngine([]);
    const source = new RdfEngineRdfJsSource(engine, {
      accessScope: {
        ...BASE_SCOPE,
        deniedSourceUrls: [DENIED_SOURCE],
      },
    });

    await streamToArray(source.match(namedNode('urn:s'), null, null, null));

    expect(lastQuery(engine).patterns[0]).toEqual(expect.objectContaining({
      subject: namedNode('urn:s'),
      predicate: { variable: 'predicate' },
      object: { variable: 'object' },
      graph: { variable: 'graph' },
      sourceScope: { deniedSources: [DENIED_SOURCE] },
    }));
  });

  it('pushes countQuads into the RDF engine instead of materializing matches', async () => {
    const engine = fakeEngine([
      {
        subject: namedNode('urn:s'),
        predicate: namedNode('urn:p'),
        object: literal('value'),
      },
    ]);
    const source = new RdfEngineRdfJsSource(engine);

    await expect(source.countQuads(null, namedNode('urn:p'), null, defaultGraph())).resolves.toBe(1);

    expect(lastQuery(engine)).toEqual(expect.objectContaining({
      patterns: [expect.objectContaining({
        predicate: namedNode('urn:p'),
        graph: defaultGraph(),
      })],
      select: ['count'],
      aggregates: [{ type: 'count', as: 'count' }],
    }));
  });

  it('propagates an abort while the RDF engine query is still pending', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const engine = fakeEngine([]);
    engine.query.mockImplementation(() => new Promise(() => {}));
    const source = new RdfEngineRdfJsSource(engine, { signal: controller.signal });

    const pending = source.countQuads(null, null, null, null);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('fails the stream with AbortError when the match is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = fakeEngine([]);
    const source = new RdfEngineRdfJsSource(engine, { signal: controller.signal });

    await expect(streamToArray(source.match(null, null, null, null))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(engine.query).not.toHaveBeenCalled();
  });
});

function fakeEngine(bindings: RdfBindingRow[]): RdfEngineLike & {
  query: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
} {
  const result: RdfQueryResult = {
    bindings,
    metrics: {
      engine: 'solid-rdf',
      plan: ['fake'],
      scannedRows: bindings.length,
      joinedRows: bindings.length,
      returnedRows: bindings.length,
      durationMs: 0,
      indexChoices: [],
      filtersApplied: 0,
      filtersPushedDown: 0,
    },
  };
  return {
    open: vi.fn(),
    close: vi.fn(),
    put: vi.fn(),
    replaceSource: vi.fn(),
    deleteSource: vi.fn(),
    delete: vi.fn(),
    applyDelta: vi.fn(),
    scan: vi.fn(),
    query: vi.fn(async (query: RdfQuery) => query.aggregates?.[0]?.type === 'count'
      ? {
          ...result,
          bindings: [{ count: literal(String(bindings.length)) }],
          count: bindings.length,
        }
      : result),
  } as unknown as RdfEngineLike & {
    query: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
  };
}

function lastQuery(engine: ReturnType<typeof fakeEngine>): RdfQuery {
  return engine.query.mock.calls.at(-1)?.[0] as RdfQuery;
}

async function streamToArray(stream: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const values: any[] = [];
    stream.on('data', (value: any) => values.push(value));
    stream.on('end', () => resolve(values));
    stream.on('error', reject);
  });
}
