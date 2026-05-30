import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataFactory } from 'n3';
import { SqliteQuintStore } from '../../../src/storage/quint';
import { QuintstoreSparqlEngine } from '../../../src/storage/sparql/CompatibilitySparqlEngine';
import {
  DisabledSparqlFeatureError,
  RdfQuadIndex,
  ShadowRdfQuintStore,
  SolidRdfEngine,
  SolidRdfSparqlEngine,
  UnsupportedSparqlQueryError,
  type RdfEngineLike,
  type RdfLocalQuery,
  type RdfLocalQueryResult,
} from '../../../src/storage/rdf';
import { arrayFromStream } from '../../helpers/arrayFromStream';

const { namedNode, literal, quad } = DataFactory;

const BASE = 'https://pod.example/alice/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';
const CONTENT = 'http://rdfs.org/sioc/ns#content';
const HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const UDFS_PRIORITY = 'https://undefineds.co/ns#priority';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

describe('SolidRdfSparqlEngine', () => {
  let index: RdfQuadIndex;
  let rdfEngine: SolidRdfEngine;
  let compatibilityStore: SqliteQuintStore;
  let fallback: QuintstoreSparqlEngine;
  let engine: SolidRdfSparqlEngine;

  beforeEach(async () => {
    index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    rdfEngine = new SolidRdfEngine({ index });
    compatibilityStore = new SqliteQuintStore({ path: ':memory:' });
    fallback = new QuintstoreSparqlEngine(compatibilityStore);
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      vi.fn(),
    );

    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(RDF_TYPE),
        namedNode(MESSAGE),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(CONTENT),
        literal('hello'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(RDF_TYPE),
        namedNode(MESSAGE),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        graph,
      ),
    ]);

  });

  afterEach(async () => {
    await engine.close();
  });

  it('executes local SELECT queries and exposes bindings metadata', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY ?message
    `, BASE);
    const metadata = await stream.metadata?.();
    const results = await arrayFromStream(stream);

    expect(metadata?.variables.map((variable) => variable.value)).toEqual(['message', 'content']);
    expect(results).toHaveLength(1);
    expect(results[0].get('message')?.value).toBe('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    expect(results[0].get('content')?.value).toBe('hello');
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();

    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.indexChoices.length).toBeGreaterThan(0);
    expect(engine.getMetrics().operationCounts.find((count) => count.operation === 'queryBindings')).toMatchObject({
      totalCount: 1,
      fallbackRate: 0,
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('awaits async RDF engine implementations on the primary path', async () => {
    const asyncEngine = new AsyncRdfEngineFake({
      bindings: [
        {
          message: namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_async'),
          content: literal('async hello'),
        },
      ],
      metrics: {
        engine: 'solid-rdf',
        plan: ['AsyncRdfEngineFake'],
        scannedRows: 1,
        joinedRows: 1,
        returnedRows: 1,
        durationMs: 1,
        indexChoices: ['fake'],
        filtersApplied: 0,
        filtersPushedDown: 0,
      },
    });
    engine = new SolidRdfSparqlEngine(asyncEngine);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results).toHaveLength(1);
    expect(results[0].get('message')?.value).toBe('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_async');
    expect(results[0].get('content')?.value).toBe('async hello');
    expect(asyncEngine.calls).toEqual(['query']);
    expect(engine.getMetrics().lastPrimary).toMatchObject({
      operation: 'queryBindings',
      returnedRows: 1,
      plan: ['AsyncRdfEngineFake'],
    });
  });

  it('scopes implicit default graph reads exactly for resource base paths', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/index.ttl';
    const prefixSibling = 'https://pod.example/alice/.data/chat/default/index.ttl.bak';
    rdfEngine.put([
      quad(
        namedNode(`${graph}#msg_resource`),
        namedNode(CONTENT),
        literal('exact graph'),
        namedNode(graph),
      ),
      quad(
        namedNode(`${prefixSibling}#msg_sibling`),
        namedNode(CONTENT),
        literal('sibling graph'),
        namedNode(prefixSibling),
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY ?message
    `, graph);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        message: `${graph}#msg_resource`,
        content: 'exact graph',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('executes local ASK queries', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBoolean');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    await expect(engine.queryBoolean(`
      ASK {
        ?message a <${MESSAGE}> .
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();

    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBoolean',
        returnedRows: 1,
        scannedRows: 2,
      },
    });
  });

  it('executes FROM and FROM NAMED dataset scopes on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const defaultGraph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const namedGraph = 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl';
    rdfEngine.put([
      quad(
        namedNode(`${namedGraph}#msg_3`),
        namedNode(RDF_TYPE),
        namedNode(MESSAGE),
        namedNode(namedGraph),
      ),
      quad(
        namedNode(`${namedGraph}#msg_3`),
        namedNode(CONTENT),
        literal('from other graph'),
        namedNode(namedGraph),
      ),
    ]);

    const defaultScoped = await engine.queryBindings(`
      SELECT ?message ?content
      FROM <${defaultGraph}>
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);
    const defaultResults = await arrayFromStream(defaultScoped);

    expect(defaultResults.map((binding) => binding.get('message')?.value)).toEqual([
      `${defaultGraph}#msg_1`,
    ]);

    const namedScoped = await engine.queryBindings(`
      SELECT ?graph ?message ?content
      FROM NAMED <${namedGraph}>
      WHERE {
        GRAPH ?graph {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);
    const namedResults = await arrayFromStream(namedScoped);

    expect(namedResults.map((binding) => ({
      graph: binding.get('graph')?.value,
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        graph: namedGraph,
        message: `${namedGraph}#msg_3`,
        content: 'from other graph',
      },
    ]);

    const defaultHiddenByNamedOnly = await engine.queryBindings(`
      SELECT ?message ?content
      FROM NAMED <${namedGraph}>
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);

    expect(await arrayFromStream(defaultHiddenByNamedOnly)).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 3,
      fallbackCount: 0,
    });
  });

  it('executes OPTIONAL anti-join queries on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
        }
        FILTER(!BOUND(?content))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?content$bound)');
  });

  it('executes negated string filters on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(namedNode(`${graph.value}#msg_skip`), namedNode(CONTENT), literal('skip this'), graph),
      quad(namedNode(`${graph.value}#msg_draft`), namedNode(CONTENT), literal('draft note'), graph),
      quad(namedNode(`${graph.value}#msg_tmp`), namedNode(CONTENT), literal('keep tmp'), graph),
      quad(namedNode(`${graph.value}#msg_old`), namedNode(CONTENT), literal('old note'), graph),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(!CONTAINS(STR(?content), "skip"))
        FILTER(!STRSTARTS(STR(?content), "draft"))
        FILTER(!STRENDS(STR(?content), "tmp"))
        FILTER(!REGEX(STR(?content), "^old", "i"))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('content')?.value)).toEqual(['hello']);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.includes('$notContains'))).toBe(true);
  });

  it('executes FILTER inside OPTIONAL on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          FILTER(CONTAINS(STR(?content), "missing"))
        }
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalFilter(?content:stringValue$contains)');
  });

  it('executes OPTIONAL-local semi-joins on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?content ?thread WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          FILTER EXISTS {
            ?message <${HAS_MEMBER}> ?thread .
          }
        }
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value ?? null,
      thread: binding.get('thread')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
        thread: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
        thread: null,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalExists(graph:op,subject:?message,predicate:http://rdfs.org/sioc/ns#has_member,object:?thread)');
  });

  it('executes OPTIONAL-local anti-joins on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          FILTER NOT EXISTS {
            ?message <${CONTENT}> "archived" .
          }
          MINUS {
            ?message <${CONTENT}> "hello" .
          }
        }
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: null,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalMinus(graph:op,subject:?message,predicate:http://rdfs.org/sioc/ns#content,object:"archived")');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalMinus(graph:op,subject:?message,predicate:http://rdfs.org/sioc/ns#content,object:"hello")');
  });

  it('executes SELECT DISTINCT on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT DISTINCT ?message WHERE {
        ?message a <${MESSAGE}> .
        ?message ?predicate ?value .
      }
      ORDER BY ?message
      LIMIT 2
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('JoinDistinct(?message)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexJoinDistinct(?message)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Distinct');
  });

  it('pushes single-pattern SELECT DISTINCT ordering and LIMIT on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(UDFS_PRIORITY),
        literal('high'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(UDFS_PRIORITY),
        literal('urgent'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(UDFS_PRIORITY),
        literal('normal'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT DISTINCT ?message WHERE {
        ?message <${UDFS_PRIORITY}> ?priority .
      }
      ORDER BY ?message
      LIMIT 2
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('JoinDistinct(?message)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexJoinDistinct(?message)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexJoinLimit');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Distinct');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Limit');
  });

  it('executes SELECT REDUCED on the embedded primary path without forcing dedupe', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT REDUCED ?message WHERE {
        ?message a <${MESSAGE}> .
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Distinct');
  });

  it('executes GROUP BY COUNT on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      ORDER BY ?thread
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      count: binding.get('count')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count-index)');
  });

  it('executes GROUP BY expression aliases on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?threadKey (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY (STR(?thread) AS ?threadKey)
      ORDER BY ?threadKey
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      threadKey: binding.get('threadKey')?.value,
      count: binding.get('count')?.value,
    }))).toEqual([
      {
        threadKey: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?threadKey:=STR(?thread))');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Aggregate(group-count-index)');
  });

  it('executes multiple GROUP BY COUNT projections on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?thread (COUNT(?message) AS ?messageCount) (COUNT(DISTINCT ?message) AS ?distinctMessageCount) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      ORDER BY ?thread
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      messageCount: binding.get('messageCount')?.value,
      distinctMessageCount: binding.get('distinctMessageCount')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        messageCount: '2',
        distinctMessageCount: '2',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count-multi-distinct)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count-index)');
  });

  it('executes guarded numeric aggregates on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(UDFS_PRIORITY),
        literal('2', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(UDFS_PRIORITY),
        literal('10', namedNode(XSD_INTEGER)),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT (SUM(?priority) AS ?sum) (AVG(?priority) AS ?avg) (MIN(?priority) AS ?min) (MAX(?priority) AS ?max) WHERE {
        ?message <${UDFS_PRIORITY}> ?priority .
        FILTER(isNumeric(?priority))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      sum: binding.get('sum')?.value,
      avg: binding.get('avg')?.value,
      min: binding.get('min')?.value,
      max: binding.get('max')?.value,
    }))).toEqual([
      {
        sum: '12',
        avg: '6',
        min: '2',
        max: '10',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(basic-multi)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(join-basic-multi-index)');
  });

  it('executes grouped guarded numeric aggregates on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(UDFS_PRIORITY),
        literal('2', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(UDFS_PRIORITY),
        literal('10', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(UDFS_PRIORITY),
        literal('4', namedNode(XSD_INTEGER)),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?thread (COUNT(?message) AS ?count) (SUM(?priority) AS ?total) (AVG(?priority) AS ?avg) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
        ?message <${UDFS_PRIORITY}> ?priority .
        FILTER(isNumeric(?priority))
      }
      GROUP BY ?thread
      HAVING (?total > 4)
      ORDER BY DESC(?total)
      LIMIT 1
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      count: binding.get('count')?.value,
      total: binding.get('total')?.value,
      avg: binding.get('avg')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
        total: '12',
        avg: '6',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupAggregateHaving(?total$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupAggregateLimit');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-basic-multi-index)');
  });

  it('executes GROUP BY COUNT HAVING on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      HAVING (?count > 1)
      ORDER BY ?thread
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      count: binding.get('count')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupCountHaving(?count$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Having(?count$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count-index)');
  });

  it('executes GROUP BY COUNT DISTINCT HAVING without exposing hidden aggregate aliases', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      HAVING (COUNT(DISTINCT ?message) > 1)
      ORDER BY ?thread
    `, BASE);
    const metadata = await stream.metadata?.();
    const results = await arrayFromStream(stream);

    expect(metadata?.variables.map((variable) => variable.value)).toEqual(['thread', 'count']);
    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      count: binding.get('count')?.value,
      hidden: binding.get('__rdf_having_aggregate_1')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
        hidden: undefined,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupCountHaving(?__rdf_having_aggregate_1$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count-multi-distinct)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Aggregate(group-count-index)');
  });

  it('pushes GROUP BY COUNT ORDER BY aggregate LIMIT on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(HAS_MEMBER),
        namedNode('https://pod.example/alice/.data/chat/default/index.ttl#thread_2'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?thread (COUNT(?message) AS ?count) WHERE {
        ?message <${HAS_MEMBER}> ?thread .
      }
      GROUP BY ?thread
      ORDER BY DESC(?count) ASC(?thread)
      LIMIT 1
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      count: binding.get('count')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        count: '2',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupCountOrder(desc:count,asc:thread)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexGroupCountLimit');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Sort');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Limit');
  });

  it('pushes mixed-direction multi-variable ORDER BY through BGP self-join', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0'),
        namedNode(RDF_TYPE),
        namedNode(MESSAGE),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:01.000Z'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?createdAt WHERE {
        ?message a <${MESSAGE}> .
        ?message <${DCT_CREATED}> ?createdAt .
      }
      ORDER BY DESC(?createdAt) ASC(?message)
      LIMIT 2
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      createdAt: binding.get('createdAt')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexJoinOrder(desc:createdAt,asc:message)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexJoinLimit');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Sort');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Limit');
  });

  it('executes ORDER BY expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(CONTENT),
        literal('second'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY STR(?content)
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: 'second',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Sort');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?__rdf_order_0_1:=STR(?content))');
  });

  it('pushes same-direction multi-variable ORDER BY and LIMIT through the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:01.000Z'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?createdAt WHERE {
        ?message <${DCT_CREATED}> ?createdAt .
      }
      ORDER BY ASC(?createdAt) ASC(?message)
      LIMIT 2
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      createdAt: binding.get('createdAt')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0',
        createdAt: '2026-05-18T00:00:01.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexOrder(asc:object,subject)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexLimit');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Sort');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Limit');
  });

  it('pushes single-pattern mixed-direction ORDER BY and LIMIT through the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_0'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:01.000Z'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?createdAt WHERE {
        ?message <${DCT_CREATED}> ?createdAt .
      }
      ORDER BY DESC(?createdAt) ASC(?message)
      LIMIT 2
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      createdAt: binding.get('createdAt')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexOrder(desc:object,asc:subject)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexLimit');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Sort');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Limit');
  });

  it('executes reversed variable-term FILTER comparisons on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:01.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?createdAt WHERE {
        ?message <${DCT_CREATED}> ?createdAt .
        FILTER("2026-05-18T00:00:02.000Z" <= ?createdAt)
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      createdAt: binding.get('createdAt')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        createdAt: '2026-05-18T00:00:02.000Z',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('LexicalRange(object$gte)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?createdAt$gte)');
  });

  it('executes numeric literal FILTER comparisons on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_2'),
        namedNode(UDFS_PRIORITY),
        literal('2', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_10'),
        namedNode(UDFS_PRIORITY),
        literal('10', namedNode(XSD_INTEGER)),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?run ?priority WHERE {
        ?run <${UDFS_PRIORITY}> ?priority .
        FILTER(?priority > 9)
      }
      ORDER BY ?run
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      run: binding.get('run')?.value,
      priority: binding.get('priority')?.value,
    }))).toEqual([
      {
        run: 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_10',
        priority: '10',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('NumericRange(object$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?priority$gt)');
  });

  it('executes same-variable OR equality filters on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(CONTENT),
        literal('second'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(?content = "hello" || ?content = "second")
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: 'second',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TermIn(object)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?content$in)');
  });

  it('executes safely negated FILTER comparisons on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(CONTENT),
        literal('second'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(CONTENT),
        literal('archived'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_4'),
        namedNode(CONTENT),
        literal('draft'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(!(?content = "archived"))
        FILTER(!(STRLEN(STR(?content)) > 6))
        FILTER(!(?content IN ("deleted", "blocked")))
        FILTER(!(?content = "draft" || ?content = "queued"))
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        content: 'second',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TermNotIn(object)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?content:stringLength$lte)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?content$ne,?content:stringLength$lte,?content$notIn,?content$notIn)');
  });

  it('executes variable-variable FILTER comparisons on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_low'),
        namedNode(UDFS_PRIORITY),
        literal('2', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_high'),
        namedNode(UDFS_PRIORITY),
        literal('10', namedNode(XSD_INTEGER)),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?low ?high WHERE {
        <${BASE}.data/task/default/2026/05/18/runs.ttl#run_low> <${UDFS_PRIORITY}> ?low .
        <${BASE}.data/task/default/2026/05/18/runs.ttl#run_high> <${UDFS_PRIORITY}> ?high .
        FILTER(?low < ?high)
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      low: binding.get('low')?.value,
      high: binding.get('high')?.value,
    }))).toEqual([
      {
        low: '2',
        high: '10',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?low$lt)');
  });

  it('executes variable-variable string-value and string-length FILTER comparisons on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_a'),
        namedNode(CONTENT),
        literal('hello'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_b'),
        namedNode(CONTENT),
        literal('hello'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?leftValue ?rightValue WHERE {
        <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_a> <${CONTENT}> ?leftValue .
        <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_b> <${CONTENT}> ?rightValue .
        FILTER(STR(?leftValue) = STR(?rightValue))
        FILTER(STRLEN(STR(?leftValue)) = STRLEN(STR(?rightValue)))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      leftValue: binding.get('leftValue')?.value,
      rightValue: binding.get('rightValue')?.value,
    }))).toEqual([
      {
        leftValue: 'hello',
        rightValue: 'hello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?leftValue:stringValue$eq,?leftValue:stringLength$eq)');
  });

  it('executes standard RDF term-test FILTER functions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('7', namedNode(XSD_INTEGER)),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?count WHERE {
        ?message <${DCT_CREATED}> ?count .
        FILTER(isIRI(?message))
        FILTER(isURI(?message))
        FILTER(isLiteral(?count))
        FILTER(isNumeric(?count))
        FILTER(sameTerm(?message, <${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1>))
        FILTER(datatype(?count) = <${XSD_INTEGER}>)
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      count: binding.get('count')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        count: '7',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TermType(subject:iri)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TermType(object:numeric)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Datatype(object$datatype)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?message$termType,?message$termType,?count$termType,?count$termType,?message$sameTerm,?count$datatype)');
  });

  it('executes negated RDF term-test FILTER functions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const msg2 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2`;
    rdfEngine.put([
      quad(
        namedNode(msg1),
        namedNode(DCT_CREATED),
        literal('7', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode(msg2),
        namedNode(DCT_CREATED),
        namedNode(`${BASE}.data/chat/default/2026/05/18/messages.ttl#linked`),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        ?message <${DCT_CREATED}> ?value .
        FILTER(!isLiteral(?message))
        FILTER(!isLiteral(?value))
        FILTER(!isBlank(?value))
        FILTER(!isNumeric(?value))
        FILTER(!sameTerm(?message, <${msg1}>))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        message: msg2,
        value: `${BASE}.data/chat/default/2026/05/18/messages.ttl#linked`,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?message$notTermType,?value$notTermType,?value$notTermType,?value$notTermType,?message$notSameTerm)');
  });

  it('executes case-normalized string FILTER functions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(CONTENT),
        literal('HELLO WORLD'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(LCASE(STR(?content)) = "hello")
        FILTER(CONTAINS(fn:lower-case(STR(?content)), "ell"))
        FILTER(STRSTARTS(UCASE(STR(?content)), "HE"))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        content: 'hello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?content:lowerStringValue$eq,?content:lowerStringValue$contains,?content:upperStringValue$startsWith)');
  });

  it('executes datatype inequality FILTER on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_numeric'),
        namedNode(DCT_CREATED),
        literal('7', namedNode(XSD_INTEGER)),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_text'),
        namedNode(DCT_CREATED),
        literal('plain'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?run ?value WHERE {
        ?run <${DCT_CREATED}> ?value .
        FILTER(datatype(?value) != <${XSD_INTEGER}>)
      }
      ORDER BY ?run
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      run: binding.get('run')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        run: 'https://pod.example/alice/.data/task/default/2026/05/18/runs.ttl#run_text',
        value: 'plain',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Datatype(object$notDatatype)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?value$notDatatype)');
  });

  it('executes lang FILTER on language-tagged literals without fallback', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(CONTENT),
        literal('hello', 'en'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(lang(?content) = "en")
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Language(object$language)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?content$lang)');
  });

  it('executes lang inequality FILTER on literals without fallback', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_en'),
        namedNode(CONTENT),
        literal('hello', 'en'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_fr'),
        namedNode(CONTENT),
        literal('bonjour', 'fr'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(lang(?content) != "en")
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_fr',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Language(object$notLanguage)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?content$notLang)');
  });

  it('executes LANGMATCHES FILTER on language-tagged literals without fallback', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(CONTENT),
        literal('hello', 'en-US'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(LANGMATCHES(LANG(?content), "en"))
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Language(object$langMatches)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?content$langMatches)');
  });

  it('executes negated LANGMATCHES FILTER on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_en'),
        namedNode(CONTENT),
        literal('howdy', 'en-US'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_fr'),
        namedNode(CONTENT),
        literal('bonjour', 'fr'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(!LANGMATCHES(LANG(?content), "en"))
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_fr',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?content$notLangMatches)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Language(object$notLangMatches)');
  });

  it('executes STRSTARTS over IRI object bindings on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?thread WHERE {
        ?message <${HAS_MEMBER}> ?thread .
        FILTER(STRSTARTS(STR(?thread), "${BASE}.data/chat/default/"))
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      thread: binding.get('thread')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('PrefixRange(object)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?thread:stringValue$startsWith)');
  });

  it('executes STR equality over RDF term lexical values without fallback', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(HAS_MEMBER),
        literal('https://pod.example/alice/.data/chat/default/index.ttl#thread_1'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?thread WHERE {
        ?message <${HAS_MEMBER}> ?thread .
        FILTER(STR(?thread) = "${BASE}.data/chat/default/index.ttl#thread_1")
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 3,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?thread:stringValue$eq)');
  });

  it('executes CONCAT BIND expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        ?message <${CONTENT}> ?content .
        BIND(CONCAT(STR(?message), STR(?content)) AS ?value)
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('value')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1hello',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?value:=CONCAT(STR(?message),STR(?content)))');
  });

  it('executes SELECT expression aliases on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message (STR(?message) AS ?messageLexical) (CONCAT(STR(?message), ":", STR(?content)) AS ?label) WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY ?messageLexical
    `, BASE);
    const metadata = await stream.metadata?.();
    const results = await arrayFromStream(stream);

    expect(metadata?.variables.map((variable) => variable.value)).toEqual(['message', 'messageLexical', 'label']);
    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      messageLexical: binding.get('messageLexical')?.value,
      label: binding.get('label')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        messageLexical: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        label: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1:hello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?messageLexical:=STR(?message),?label:=CONCAT(STR(?message),":",STR(?content)))');
  });

  it('executes SUBSTR and XPath substring expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message (SUBSTR(STR(?content), 2, 3) AS ?slice) (fn:substring(STR(?content), 4) AS ?tail) WHERE {
        ?message <${CONTENT}> ?content .
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      slice: binding.get('slice')?.value,
      tail: binding.get('tail')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        slice: 'ell',
        tail: 'lo',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?slice:=SUBSTR(STR(?content),2,3),?tail:=SUBSTR(STR(?content),4))');
  });

  it('executes SUBSTR dynamic start and length expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?slice WHERE {
        ?message <${CONTENT}> ?content .
        BIND(2 AS ?start)
        BIND(SUBSTR(STR(?content), ?start, STRLEN(?content)) AS ?slice)
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      slice: binding.get('slice')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        slice: 'ello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?start:=2,?slice:=SUBSTR(STR(?content),?start,STRLEN(?content)))');
  });

  it('executes standard XPath function-call filters on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3'),
        namedNode(CONTENT),
        literal('goodbye'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      PREFIX fn: <http://www.w3.org/2005/xpath-functions#>
      SELECT ?message ?content WHERE {
        ?message <${CONTENT}> ?content .
        FILTER(fn:contains(STR(?content), "ood"))
        FILTER(fn:string-length(STR(?content)) > 5)
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_3',
        content: 'goodbye',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TextSearch(object$contains)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Filter(?content:stringLength$gt)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?content:stringValue$contains,?content:stringLength$gt)');
  });

  it('executes standard BIND expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?messageLexical ?messageIri ?contentLength WHERE {
        ?message <${CONTENT}> ?content .
        BIND(STR(?message) AS ?messageLexical)
        BIND(IRI(?messageLexical) AS ?messageIri)
        BIND(STRLEN(STR(?content)) AS ?contentLength)
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      messageLexical: binding.get('messageLexical')?.value,
      messageIri: binding.get('messageIri')?.value,
      contentLength: binding.get('contentLength')?.value,
    }))).toEqual([
      {
        messageLexical: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        messageIri: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        contentLength: '5',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?messageLexical:=STR(?message),?messageIri:=IRI(?messageLexical),?contentLength:=STRLEN(?content))');
  });

  it('executes lowercase and uppercase BIND expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?lower ?upper WHERE {
        ?message <${CONTENT}> ?content .
        BIND(LCASE(STR(?content)) AS ?lower)
        BIND(UCASE(STR(?content)) AS ?upper)
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      lower: binding.get('lower')?.value,
      upper: binding.get('upper')?.value,
    }))).toEqual([
      {
        lower: 'hello',
        upper: 'HELLO',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Bind(?lower:=LCASE(STR(?content)),?upper:=UCASE(STR(?content)))');
  });

  it('executes optional BIND expressions on the embedded primary path without fallback', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?contentLabel WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          ?message <${CONTENT}> ?content .
          BIND(CONCAT(STR(?content), "-optional") AS ?contentLabel)
        }
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      contentLabel: binding.get('contentLabel')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        contentLabel: 'hello-optional',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        contentLabel: null,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalBind(?contentLabel:=CONCAT(STR(?content),"-optional"))');
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('executes basic CONSTRUCT on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryQuads');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryQuads(`
      CONSTRUCT {
        ?message <${CONTENT}> ?content .
      }
      WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((quad) => ({
      subject: quad.subject.value,
      predicate: quad.predicate.value,
      object: quad.object.value,
    }))).toEqual([
      {
        subject: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        predicate: CONTENT,
        object: 'hello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryQuads',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Construct');
  });

  it('executes direct DESCRIBE IRI queries on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryQuads');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryQuads(`
      DESCRIBE <https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1>
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((quad) => ({
      subject: quad.subject.value,
      predicate: quad.predicate.value,
      object: quad.object.value,
      graph: quad.graph.termType,
    }))).toEqual([
      {
        subject: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        predicate: RDF_TYPE,
        object: MESSAGE,
        graph: 'DefaultGraph',
      },
      {
        subject: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        predicate: CONTENT,
        object: 'hello',
        graph: 'DefaultGraph',
      },
      {
        subject: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        predicate: HAS_MEMBER,
        object: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        graph: 'DefaultGraph',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryQuads',
        returnedRows: 3,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Describe');
  });

  it('executes variable DESCRIBE queries after embedded WHERE binding', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryQuads');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryQuads(`
      DESCRIBE ?message WHERE {
        ?message <${CONTENT}> "hello" .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((quad) => quad.predicate.value)).toEqual([
      RDF_TYPE,
      CONTENT,
      HAS_MEMBER,
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryQuads',
        returnedRows: 3,
      },
    });
  });

  it('executes wildcard DESCRIBE queries over visible required variables', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryQuads');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryQuads(`
      DESCRIBE * WHERE {
        ?message <${CONTENT}> ?content .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((quad) => quad.predicate.value)).toEqual([
      RDF_TYPE,
      CONTENT,
      HAS_MEMBER,
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryQuads',
        returnedRows: 3,
      },
    });
  });

  it('constructs a single named graph on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'constructGraph');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const stream = await engine.constructGraph(graph, BASE);
    const results = await arrayFromStream(stream);

    expect(results).toHaveLength(5);
    expect(results.every((quad) => quad.graph.termType === 'DefaultGraph')).toBe(true);
    expect(results.map((quad) => quad.subject.value)).toContain('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1');
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'constructGraph',
        returnedRows: 5,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Construct');
  });

  it('returns an empty graph for out-of-scope constructGraph requests without fallback', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'constructGraph');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.constructGraph('https://external.example/alice/data.ttl', BASE);
    const results = await arrayFromStream(stream);

    expect(results).toEqual([]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 0,
      fallbackCount: 0,
    });
  });

  it('lists local named graphs on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'listGraphs');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graphs = await engine.listGraphs(BASE);

    expect([...graphs]).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'listGraphs',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('JoinDistinct(?g)');
    expect(engine.getMetrics().lastPrimary?.plan).toContain('IndexJoinDistinct(?g)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Distinct');
  });

  it('executes single-variable VALUES filters on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const msg2 = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2';
    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        VALUES ?message { <${msg2}> }
        ?message a <${MESSAGE}> .
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([msg2]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TermIn(subject)');
    expect(engine.getMetrics().lastPrimary?.plan).not.toContain('Filter(?message$in)');
  });

  it('executes tuple VALUES on the embedded primary path without losing row correlation', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const msg1 = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1';
    const msg2 = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2';
    const stream = await engine.queryBindings(`
      SELECT ?message ?kind WHERE {
        VALUES (?message ?kind) {
          (<${msg1}> <${MESSAGE}>)
          (<${msg2}> <${CONTENT}>)
        }
        ?message a ?kind .
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      kind: binding.get('kind')?.value,
    }))).toEqual([
      {
        message: msg1,
        kind: MESSAGE,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('TupleValuesJoin(object,subject)');
  });

  it('executes VALUES UNDEF rows on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const msg1 = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1';
    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        VALUES ?message { UNDEF <${msg1}> }
        ?message a <${MESSAGE}> .
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      msg1,
      msg1,
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 3,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('Values(?message)');
  });

  it('executes VALUES inside OPTIONAL on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const msg1 = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1';
    const missing = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#missing';
    const stream = await engine.queryBindings(`
      SELECT ?message ?tag ?content WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          VALUES (?message ?tag) {
            (<${msg1}> "selected")
            (<${missing}> "ignored")
          }
          ?message <${CONTENT}> ?content .
        }
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      tag: binding.get('tag')?.value ?? null,
      content: binding.get('content')?.value ?? null,
    }))).toEqual([
      {
        message: msg1,
        tag: 'selected',
        content: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        tag: null,
        content: null,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('OptionalValues(?message,?tag)');
  });

  it('executes controlled UNION queries on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        { ?message <${CONTENT}> ?value }
        UNION
        { ?message <${HAS_MEMBER}> ?value }
      }
      ORDER BY ?message ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 3,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('Union('))).toBe(true);
  });

  it('executes UNION branch-local BIND expressions on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?value ?label WHERE {
        {
          ?message <${CONTENT}> ?value .
          BIND(CONCAT("content:", STR(?value)) AS ?label)
        }
        UNION
        {
          ?message <${HAS_MEMBER}> ?value .
          BIND(CONCAT("member:", STR(?value)) AS ?label)
        }
      }
      ORDER BY ?message ?label
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value ?? null,
      label: binding.get('label')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
        label: 'content:hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        label: 'member:https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        label: 'member:https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('UnionBind('))).toBe(true);
  });

  it('executes UNION branch-local tuple VALUES on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const msg1 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_1`;
    const msg2 = `${BASE}.data/chat/default/2026/05/18/messages.ttl#msg_2`;
    const thread = `${BASE}.data/chat/default/index.ttl#thread_1`;
    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        {
          VALUES (?message ?value) {
            (<${msg1}> "hello")
            (<${msg2}> "invalid-content")
          }
          ?message <${CONTENT}> ?value .
        }
        UNION
        {
          VALUES (?message ?value) {
            (<${msg2}> <${thread}>)
            (<${msg1}> "invalid-member")
          }
          ?message <${HAS_MEMBER}> ?value .
        }
      }
      ORDER BY ?message ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        message: msg1,
        value: 'hello',
      },
      {
        message: msg2,
        value: thread,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContain('UnionValues(?message,?value)');
  });

  it('executes nested controlled UNION queries on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        { ?message <${CONTENT}> ?value }
        UNION
        {
          { ?message <${HAS_MEMBER}> ?value }
          UNION
          { ?message a <${MESSAGE}> }
        }
      }
      ORDER BY ?message ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: null,
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 5,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('Union('))).toBe(true);
  });

  it('executes UNION branches that keep required patterns before nested UNION groups', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    const graph = namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl');
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:01.000Z'),
        graph,
      ),
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        graph,
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        {
          ?message a <${MESSAGE}> .
          { ?message <${CONTENT}> ?value }
          UNION
          { ?message <${DCT_CREATED}> ?value }
        }
        UNION
        { ?message <${HAS_MEMBER}> ?value }
      }
    `, BASE);
    const results = await arrayFromStream(stream);
    const rows = results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value,
    }));

    expect(rows).toEqual(expect.arrayContaining([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: '2026-05-18T00:00:01.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: '2026-05-18T00:00:02.000Z',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]));
    expect(rows).toHaveLength(5);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 5,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('UnionNested('))).toBe(true);
  });

  it('executes UNION inside OPTIONAL on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        ?message a <${MESSAGE}> .
        OPTIONAL {
          {
            ?message <${CONTENT}> ?value
          }
          UNION
          {
            ?message <${HAS_MEMBER}> ?value
          }
        }
      }
      ORDER BY ?message ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.includes('OptionalUnion('))).toBe(true);
  });

  it('executes controlled MINUS anti-joins on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        MINUS {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContainEqual(
      expect.stringContaining('Minus('),
    );
    expect(engine.getMetrics().lastPrimary?.plan).toContainEqual(
      expect.stringContaining(`predicate:${CONTENT}`),
    );
  });

  it('executes controlled FILTER NOT EXISTS anti-joins on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER NOT EXISTS {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContainEqual(
      expect.stringContaining('Minus('),
    );
  });

  it('executes controlled FILTER EXISTS semi-joins on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER EXISTS {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan).toContainEqual(
      expect.stringContaining('Exists('),
    );
  });

  it('executes dependent joins with controlled UNION branches on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        ?message a <${MESSAGE}> .
        FILTER EXISTS {
          {
            ?message <${CONTENT}> ?value .
          }
          UNION
          {
            ?message <${HAS_MEMBER}> ?value .
          }
        }
        MINUS {
          ?message <${HAS_MEMBER}> ?thread .
          {
            ?message <${CONTENT}> "hello" .
          }
          UNION
          {
            ?message <${CONTENT}> "archived" .
          }
        }
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('ExistsUnion('))).toBe(true);
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('MinusUnion('))).toBe(true);
  });

  it('executes simple inverse property paths on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message WHERE {
        <https://pod.example/alice/.data/chat/default/index.ttl#thread_1> ^<${HAS_MEMBER}> ?message .
      }
      ORDER BY ?message
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => binding.get('message')?.value)).toEqual([
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
      'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
  });

  it('executes fixed-length sequence property paths on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?thread ?content WHERE {
        ?thread ^<${HAS_MEMBER}>/<${CONTENT}> ?content .
      }
      ORDER BY ?content
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      content: binding.get('content')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        content: 'hello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 1,
      },
    });
  });

  it('executes simple alternative property paths on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?message ?value WHERE {
        ?message (<${CONTENT}>|<${HAS_MEMBER}>) ?value .
      }
      ORDER BY ?message ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('message')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 3,
      },
    });
    expect(engine.getMetrics().lastPrimary?.indexChoices.length).toBeGreaterThan(0);
  });

  it('executes fixed alternative segments in sequence property paths on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );
    rdfEngine.put([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2'),
        namedNode(DCT_CREATED),
        literal('2026-05-18T00:00:02.000Z'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);

    const stream = await engine.queryBindings(`
      SELECT ?thread ?value WHERE {
        ?thread ^<${HAS_MEMBER}>/(<${CONTENT}>|<${DCT_CREATED}>) ?value .
      }
      ORDER BY ?value
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      thread: binding.get('thread')?.value,
      value: binding.get('value')?.value,
    }))).toEqual([
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        value: '2026-05-18T00:00:02.000Z',
      },
      {
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
        value: 'hello',
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
  });

  it('applies INSERT DATA and DELETE DATA on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = `${BASE}.data/chat/default/index.ttl`;
    const subject = `${graph}#msg_3`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${subject}> <${CONTENT}> "created" .
        }
      }
    `, BASE);

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${subject}> <${CONTENT}> "created" .
        }
      }
    `, BASE)).resolves.toBe(true);

    await engine.queryVoid(`
      DELETE DATA {
        GRAPH <${graph}> {
          <${subject}> <${CONTENT}> "created" .
        }
      }
    `, BASE);

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${subject}> <${CONTENT}> "created" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 4,
      fallbackCount: 0,
      lastPrimary: {
        operation: 'queryBoolean',
        returnedRows: 0,
      },
    });
    const queryVoidCounts = engine.getMetrics().operationCounts.find((counts) => counts.operation === 'queryVoid');
    expect(queryVoidCounts).toMatchObject({
      primaryCount: 2,
      fallbackCount: 0,
    });
  });

  it('applies DELETE WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE);

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> ?content .
        }
      }
    `, BASE)).resolves.toBe(false);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> ?content .
        }
      }
    `, BASE)).resolves.toBe(false);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> a <${MESSAGE}> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    const queryVoidCounts = engine.getMetrics().operationCounts.find((counts) => counts.operation === 'queryVoid');
    expect(queryVoidCounts).toMatchObject({
      primaryCount: 2,
      fallbackCount: 0,
    });
  });

  it('uses implicit SPARQL UPDATE default graph only for exact resource base paths', async () => {
    const onFallback = vi.fn();
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      undefined,
      undefined,
      true,
      onFallback,
    );

    const resourceGraph = `${BASE}.data/chat/default/index.ttl`;
    const subject = `${resourceGraph}#msg_default_graph`;
    await engine.queryVoid(`
      INSERT DATA {
        <${subject}> <${CONTENT}> "resource default graph" .
      }
    `, resourceGraph);

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${resourceGraph}> {
          <${subject}> <${CONTENT}> "resource default graph" .
        }
      }
    `, BASE)).resolves.toBe(true);

    const containerBase = `${BASE}.data/chat/default/`;
    await expect(engine.queryVoid(`
      INSERT DATA {
        <${containerBase}#msg_container_default_graph> <${CONTENT}> "container default graph" .
      }
    `, containerBase)).rejects.toThrow('No compatibility SPARQL fallback configured for queryVoid');

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${containerBase}> {
          <${containerBase}#msg_container_default_graph> <${CONTENT}> "container default graph" .
        }
      }
    `, BASE)).resolves.toBe(false);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('applies DELETE/INSERT WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);
    const beforeUpdateVersion = index.dataVersion();

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;
    expect(index.dataVersion()).toBe(beforeUpdateVersion + 1);

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello world" .
        }
      }
    `, BASE)).resolves.toBe(false);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> a <${MESSAGE}> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies DELETE/INSERT WHERE with negated string filters on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "skip second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "negated filter rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
        FILTER(!CONTAINS(STR(?old), "skip"))
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "negated filter rewritten" .
          <${msg2}> <${CONTENT}> "skip second" .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:1',
      'insert:1',
    ]));
  });

  it('applies DELETE/INSERT WHERE with negated term-test filters on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "term-test second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "negated term-test rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
        FILTER(!isNumeric(?old))
        FILTER(!sameTerm(?message, <${msg2}>))
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "negated term-test rewritten" .
          <${msg2}> <${CONTENT}> "term-test second" .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:1',
      'insert:1',
    ]));
  });

  it('applies DELETE/INSERT WHERE with negated LANGMATCHES filters on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msgEn = `${graph}#msg_en`;
    const msgFr = `${graph}#msg_fr`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msgEn}> <${CONTENT}> "howdy"@en-US .
          <${msgFr}> <${CONTENT}> "bonjour"@fr .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "negated langmatches rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
        FILTER(!LANGMATCHES(LANG(?old), "en"))
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "negated langmatches rewritten" .
          <${msgFr}> <${CONTENT}> "negated langmatches rewritten" .
          <${msgEn}> <${CONTENT}> "howdy"@en-US .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies INSERT WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT {
        GRAPH <${graph}> {
          ?message <${DCT_CREATED}> "created from insert where" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${DCT_CREATED}> "created from insert where" .
          <${msg2}> <${DCT_CREATED}> "created from insert where" .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:0',
      'insert:2',
    ]));
  });

  it('applies DELETE/INSERT WHERE with FILTER and VALUES on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "values rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
          FILTER(CONTAINS(STR(?old), "hello"))
        }
        VALUES ?message { <${msg1}> }
      }
    `, BASE);

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "values rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
  });

  it('applies DELETE/INSERT WHERE with BIND on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?next .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
          BIND(CONCAT(STR(?old), " rewritten") AS ?next)
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:1',
      'insert:1',
    ]));
  });

  it('applies DELETE/INSERT WHERE with same-variable OR filters on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "or rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
          FILTER(?old = "hello" || ?old = "second")
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "or rewritten" .
          <${msg2}> <${CONTENT}> "or rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies DELETE/INSERT WHERE with controlled UNION on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "union rewritten" .
        }
      }
      WHERE {
        {
          GRAPH <${graph}> {
            ?message <${CONTENT}> ?old .
            FILTER(?old = "hello")
          }
        }
        UNION
        {
          GRAPH <${graph}> {
            ?message <${CONTENT}> ?old .
            FILTER(?old = "second")
          }
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "union rewritten" .
          <${msg2}> <${CONTENT}> "union rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies DELETE/INSERT WHERE with controlled MINUS on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${HAS_MEMBER}> ?thread .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#unread> .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message a <${MESSAGE}> .
          ?message <${HAS_MEMBER}> ?thread .
        }
        MINUS {
          GRAPH <${graph}> {
            ?message <${CONTENT}> ?content .
          }
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#thread_1> .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#unread> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:1',
      'insert:1',
    ]));
  });

  it('applies DELETE/INSERT WHERE with controlled FILTER NOT EXISTS on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${HAS_MEMBER}> ?thread .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#not-exists> .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message a <${MESSAGE}> .
          ?message <${HAS_MEMBER}> ?thread .
        }
        FILTER NOT EXISTS {
          GRAPH <${graph}> {
            ?message <${CONTENT}> ?content .
          }
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#thread_1> .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#not-exists> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:1',
      'insert:1',
    ]));
  });

  it('applies DELETE/INSERT WHERE with controlled FILTER EXISTS on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${HAS_MEMBER}> ?thread .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#exists> .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          ?message a <${MESSAGE}> .
          ?message <${HAS_MEMBER}> ?thread .
        }
        FILTER EXISTS {
          GRAPH <${graph}> {
            ?message <${CONTENT}> ?content .
          }
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#exists> .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg2}> <${HAS_MEMBER}> <${BASE}.data/chat/default/index.ttl#thread_1> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:1',
      'insert:1',
    ]));
  });

  it('applies DELETE/INSERT WHERE with fixed-length property paths on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const thread = `${BASE}.data/chat/default/index.ttl#thread_1`;
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "path rewritten" .
        }
      }
      WHERE {
        GRAPH <${graph}> {
          <${thread}> ^<${HAS_MEMBER}>/<${CONTENT}> ?old .
          <${thread}> ^<${HAS_MEMBER}> ?message .
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "path rewritten" .
          <${msg2}> <${CONTENT}> "path rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello" .
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies WITH-scoped DELETE/INSERT WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      WITH <${graph}>
      DELETE {
        ?message <${CONTENT}> ?old .
      }
      INSERT {
        ?message <${CONTENT}> "with rewritten" .
      }
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "with rewritten" .
          <${msg2}> <${CONTENT}> "with rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello" .
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies single-USING DELETE/INSERT WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const graph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const msg1 = `${graph}#msg_1`;
    const msg2 = `${graph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${graph}> {
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH <${graph}> {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH <${graph}> {
          ?message <${CONTENT}> "using rewritten" .
        }
      }
      USING <${graph}>
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "using rewritten" .
          <${msg2}> <${CONTENT}> "using rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${graph}> {
          <${msg1}> <${CONTENT}> "hello" .
          <${msg2}> <${CONTENT}> "second" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies multi-USING INSERT WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const targetGraph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const otherGraph = 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl';
    const msg1 = `${targetGraph}#msg_1`;
    const msg2 = `${otherGraph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${otherGraph}> {
          <${msg2}> <${CONTENT}> "other graph" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      INSERT {
        GRAPH <${targetGraph}> {
          ?message <${HAS_MEMBER}> <${targetGraph}#multi_using> .
        }
      }
      USING <${targetGraph}>
      USING <${otherGraph}>
      WHERE {
        ?message <${CONTENT}> ?old .
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${HAS_MEMBER}> <${targetGraph}#multi_using> .
          <${msg2}> <${HAS_MEMBER}> <${targetGraph}#multi_using> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'insert:2',
    ]));
  });

  it('applies USING NAMED INSERT WHERE on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const targetGraph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const namedGraph = 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl';
    const msg1 = `${targetGraph}#msg_1`;
    const msg2 = `${namedGraph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "named graph" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      INSERT {
        GRAPH <${targetGraph}> {
          ?message <${HAS_MEMBER}> ?g .
        }
      }
      USING NAMED <${targetGraph}>
      USING NAMED <${namedGraph}>
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${HAS_MEMBER}> <${targetGraph}> .
          <${msg2}> <${HAS_MEMBER}> <${namedGraph}> .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'insert:2',
    ]));
  });

  it('applies finite GRAPH variable templates on the embedded update delta path', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const targetGraph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const namedGraph = 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl';
    const msg1 = `${targetGraph}#msg_1`;
    const msg2 = `${namedGraph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "named graph before" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?message <${CONTENT}> "graph variable rewritten" .
        }
      }
      USING NAMED <${targetGraph}>
      USING NAMED <${namedGraph}>
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${CONTENT}> "graph variable rewritten" .
        }
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "graph variable rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${CONTENT}> "hello" .
        }
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "named graph before" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies graph-variable update templates constrained by explicit graph filters', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const targetGraph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const namedGraph = 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl';
    const msg1 = `${targetGraph}#msg_1`;
    const msg2 = `${namedGraph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "explicit graph filter before" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?message <${CONTENT}> "explicit graph filter rewritten" .
        }
      }
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
        FILTER(?g IN (<${targetGraph}>, <${namedGraph}>))
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${CONTENT}> "explicit graph filter rewritten" .
        }
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "explicit graph filter rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);
    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${CONTENT}> "hello" .
        }
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "explicit graph filter before" .
        }
      }
    `, BASE)).resolves.toBe(false);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('applies graph-variable update templates constrained by VALUES rows', async () => {
    const onFallback = vi.fn();
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const targetGraph = 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl';
    const namedGraph = 'https://pod.example/alice/.data/chat/default/2026/05/19/messages.ttl';
    const msg1 = `${targetGraph}#msg_1`;
    const msg2 = `${namedGraph}#msg_2`;
    await engine.queryVoid(`
      INSERT DATA {
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "values graph before" .
        }
      }
    `, BASE);

    await engine.queryVoid(`
      DELETE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
      }
      INSERT {
        GRAPH ?g {
          ?message <${CONTENT}> "values graph rewritten" .
        }
      }
      WHERE {
        GRAPH ?g {
          ?message <${CONTENT}> ?old .
        }
        VALUES (?g ?message) {
          (<${targetGraph}> <${msg1}>)
          (<${namedGraph}> <${msg2}>)
        }
      }
    `, BASE);
    const updateMetric = engine.getMetrics().lastPrimary;

    await expect(engine.queryBoolean(`
      ASK {
        GRAPH <${targetGraph}> {
          <${msg1}> <${CONTENT}> "values graph rewritten" .
        }
        GRAPH <${namedGraph}> {
          <${msg2}> <${CONTENT}> "values graph rewritten" .
        }
      }
    `, BASE)).resolves.toBe(true);

    expect(onFallback).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(updateMetric?.plan).toEqual(expect.arrayContaining([
      'UpdateDelta',
      'delete:2',
      'insert:2',
    ]));
  });

  it('executes nested OPTIONAL groups on the embedded primary path', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    const stream = await engine.queryBindings(`
      SELECT ?s ?value ?thread WHERE {
        ?s a <${MESSAGE}> .
        OPTIONAL {
          ?s <${CONTENT}> ?value .
          OPTIONAL {
            ?s <${HAS_MEMBER}> ?thread .
          }
        }
      }
      ORDER BY ?s
    `, BASE);
    const results = await arrayFromStream(stream);

    expect(results.map((binding) => ({
      message: binding.get('s')?.value,
      value: binding.get('value')?.value ?? null,
      thread: binding.get('thread')?.value ?? null,
    }))).toEqual([
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1',
        value: 'hello',
        thread: 'https://pod.example/alice/.data/chat/default/index.ttl#thread_1',
      },
      {
        message: 'https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_2',
        value: null,
        thread: null,
      },
    ]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 0,
      totalCount: 1,
      fallbackRate: 0,
      lastPrimary: {
        operation: 'queryBindings',
        returnedRows: 2,
      },
    });
    expect(engine.getMetrics().lastPrimary?.plan.some((entry) => entry.startsWith('OptionalNestedJoin('))).toBe(true);
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('rejects SERVICE federation without invoking the compatibility engine', async () => {
    const onFallback = vi.fn();
    const fallbackSpy = vi.spyOn(fallback, 'queryBindings');
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      fallback,
      undefined,
      true,
      onFallback,
    );

    await expect(engine.queryBindings(`
      SELECT ?message WHERE {
        SERVICE <https://remote.example/sparql> {
          ?message <${CONTENT}> ?content .
        }
      }
    `, BASE)).rejects.toThrow(DisabledSparqlFeatureError);

    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 0,
      fallbackCount: 0,
    });
  });

  it('falls back unsupported queryVoid and unsupported queryQuads to the compatibility engine', async () => {
    const voidSpy = vi.spyOn(fallback, 'queryVoid');
    const quadSpy = vi.spyOn(fallback, 'queryQuads');

    await engine.queryVoid('INSERT DATA { GRAPH <https://external.example/data.ttl> { <https://s> <https://p> <https://o> } }', BASE);
    const stream = await engine.queryQuads(`
      DESCRIBE ?message WHERE {
        OPTIONAL {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE);
    await arrayFromStream(stream);

    expect(voidSpy).toHaveBeenCalled();
    expect(quadSpy).toHaveBeenCalled();
    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 0,
      fallbackCount: 2,
      totalCount: 2,
      fallbackRate: 1,
      lastFallback: {
        operation: 'queryQuads',
      },
    });
    expect(engine.getMetrics().operationCounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'queryQuads',
        totalCount: 1,
        fallbackRate: 1,
      }),
      expect.objectContaining({
        operation: 'queryVoid',
        totalCount: 1,
        fallbackRate: 1,
      }),
    ]));
  });

  it('rejects unsupported shapes when no compatibility fallback is configured', async () => {
    const onFallback = vi.fn();
    engine = new SolidRdfSparqlEngine(
      rdfEngine,
      undefined,
      undefined,
      true,
      onFallback,
    );

    await expect(engine.queryQuads(`
      DESCRIBE ?message WHERE {
        OPTIONAL {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE)).rejects.toThrow(UnsupportedSparqlQueryError);

    expect(onFallback).not.toHaveBeenCalled();
    expect(engine.getMetrics()).toEqual({
      primaryCount: 0,
      fallbackCount: 0,
      totalCount: 0,
      fallbackRate: 0,
      operationCounts: [],
      lastPrimary: undefined,
      lastFallback: undefined,
    });
  });

  it('can reset primary and fallback metrics for bounded benchmark windows', async () => {
    await engine.queryBoolean(`
      ASK {
        ?message a <${MESSAGE}> .
      }
    `, BASE);
    const stream = await engine.queryQuads(`
      DESCRIBE ?message WHERE {
        OPTIONAL {
          ?message a <${MESSAGE}> .
        }
      }
    `, BASE);
    await arrayFromStream(stream);

    expect(engine.getMetrics()).toMatchObject({
      primaryCount: 1,
      fallbackCount: 1,
      totalCount: 2,
      fallbackRate: 0.5,
    });
    expect(() => engine.assertFallbackBudget({
      operations: ['queryBoolean'],
      maxFallbackCount: 0,
      maxFallbackRate: 0,
    })).not.toThrow();
    expect(() => engine.assertFallbackBudget({
      operations: ['queryQuads'],
      maxFallbackCount: 0,
      maxFallbackRate: 0,
    })).toThrow(/queryQuads/);

    engine.resetMetrics();

    expect(engine.getMetrics()).toEqual({
      primaryCount: 0,
      fallbackCount: 0,
      totalCount: 0,
      fallbackRate: 0,
      operationCounts: [],
      lastPrimary: undefined,
      lastFallback: undefined,
    });
    expect(() => engine.assertFallbackBudget()).not.toThrow();
  });

  it('opens the shadow store and backfills existing compatibility rows before local SELECT', async () => {
    await engine.close();

    index = new RdfQuadIndex({ path: ':memory:' });
    const root = await mkdtemp(path.join(os.tmpdir(), 'xpod-rdf-sparql-shadow-'));
    compatibilityStore = new SqliteQuintStore({ path: path.join(root, 'compat.sqlite') });
    await compatibilityStore.open();
    await compatibilityStore.multiPut([
      quad(
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl#msg_1'),
        namedNode(CONTENT),
        literal('hello from durable store'),
        namedNode('https://pod.example/alice/.data/chat/default/2026/05/18/messages.ttl'),
      ),
    ]);
    await compatibilityStore.close();

    try {
      const shadowStore = new ShadowRdfQuintStore({
        compatibilityStore,
        index,
        autoBackfill: {
          clear: true,
          batchSize: 1,
        },
      });
      const fallbackStub = {
        queryBindings: vi.fn(async () => {
          throw new Error('fallback should not be used');
        }),
        queryQuads: vi.fn(async () => {
          throw new Error('fallback should not be used');
        }),
        queryBoolean: vi.fn(async () => {
          throw new Error('fallback should not be used');
        }),
        queryVoid: vi.fn(async () => {
          throw new Error('fallback should not be used');
        }),
        constructGraph: vi.fn(async () => {
          throw new Error('fallback should not be used');
        }),
        listGraphs: vi.fn(async () => {
          throw new Error('fallback should not be used');
        }),
        close: vi.fn(async () => undefined),
      };
      const onFallback = vi.fn();
      rdfEngine = new SolidRdfEngine({ index });
      engine = new SolidRdfSparqlEngine(
        rdfEngine,
        fallbackStub,
        shadowStore,
        true,
        onFallback,
      );

      expect(() => index.stats()).toThrow('RdfQuadIndex is not open');

      const stream = await engine.queryBindings(`
        SELECT ?message ?content WHERE {
          ?message <${CONTENT}> ?content .
        }
      `, BASE);
      const results = await arrayFromStream(stream);

      expect(index.stats().quadCount).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].get('content')?.value).toBe('hello from durable store');
      expect(onFallback).not.toHaveBeenCalled();
      expect(fallbackStub.queryBindings).not.toHaveBeenCalled();
      await shadowStore.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class AsyncRdfEngineFake implements RdfEngineLike {
  public readonly calls: string[] = [];

  public constructor(private readonly result: RdfLocalQueryResult) {}

  public async open(): Promise<void> {
    this.calls.push('open');
  }

  public async close(): Promise<void> {
    this.calls.push('close');
  }

  public async put(): Promise<void> {
    this.calls.push('put');
  }

  public async replaceSource(): Promise<void> {
    this.calls.push('replaceSource');
  }

  public async deleteSource(): Promise<number> {
    this.calls.push('deleteSource');
    return 0;
  }

  public async delete(): Promise<number> {
    this.calls.push('delete');
    return 0;
  }

  public async applyDelta(): Promise<{ deletedRows: number; insertedRows: number }> {
    this.calls.push('applyDelta');
    return { deletedRows: 0, insertedRows: 0 };
  }

  public async scan(): Promise<ReturnType<SolidRdfEngine['scan']>> {
    this.calls.push('scan');
    return {
      quads: [],
      metrics: {
        indexChoice: 'fake',
        queryPlan: ['fake'],
        scannedRows: 0,
        matchedRows: 0,
      },
    };
  }

  public async query(_query: RdfLocalQuery): Promise<RdfLocalQueryResult> {
    this.calls.push('query');
    return this.result;
  }

  public async refreshDerivedIndexes(): Promise<ReturnType<SolidRdfEngine['refreshDerivedIndexes']>> {
    this.calls.push('refreshDerivedIndexes');
    return {
      derivedIndexProfile: 'baseline',
      factsDataVersion: 0,
    };
  }

  public async storageStats(): Promise<ReturnType<SolidRdfEngine['storageStats']>> {
    this.calls.push('storageStats');
    return {
      derivedIndexProfile: 'baseline',
      facts: {
        quadCount: 0,
        termCount: 0,
        sourceCount: 0,
        databaseBytes: 0,
        tableBytes: 0,
        indexBytes: 0,
        dataVersion: 0,
        index: {},
        tables: {},
      },
      factsBytes: 0,
      derivedBytes: 0,
      totalBytes: 0,
      derivedToFactsRatio: 1,
      totalToFactsRatio: 1,
    };
  }
}
