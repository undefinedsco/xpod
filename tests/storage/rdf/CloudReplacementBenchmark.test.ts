import { describe, expect, expectTypeOf, it } from 'vitest';
import { DataFactory } from 'n3';
import {
  buildCloudReplacementTopology,
  CLOUD_REPLACEMENT_GROUP_WEIGHTS,
  cloudReplacementWorkloads,
  type CloudReplacementEngineId,
  type CloudReplacementWorkload,
  type CloudReplacementWorkloadGroup,
} from '../../../src/storage/rdf/cloud-replacement-benchmark';
import { applyRdfAccessScope, rdfAccessGraphAllowed } from '../../../src/storage/rdf/RdfAccessScope';
import { RdfQuadIndex } from '../../../src/storage/rdf/RdfQuadIndex';
import { RdfSparqlAdapter } from '../../../src/storage/rdf/RdfSparqlAdapter';
import { SolidRdfEngine } from '../../../src/storage/rdf/SolidRdfEngine';
import {
  buildRdfModelsBenchmarkSeed,
  buildRdfModelsSyntheticMessageBatch,
} from '../../../src/storage/rdf/models-benchmark';

const ALICE_POD = 'https://pod.example/alice/';
const ALICE_CHAT_PREFIX = 'https://pod.example/alice/.data/chat/';
const ALICE_CHAT_INDEX = `${ALICE_CHAT_PREFIX}default/index.ttl`;
const DAY_ONE = `${ALICE_CHAT_PREFIX}default/2026/05/01/messages.ttl`;
const DENIED_DAY = `${ALICE_CHAT_PREFIX}default/2026/05/05/messages.ttl`;

const QUERY_PREFIXES = [
  'PREFIX sioc: <http://rdfs.org/sioc/ns#>',
  'PREFIX dct: <http://purl.org/dc/terms/>',
  'PREFIX udfs: <https://undefineds.co/ns#>',
  'PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>',
  'PREFIX ai: <https://vocab.xpod.dev/ai#>',
].join('\n');

const SHARED_QUERY_BODIES = {
  'point-lookup': 'SELECT ?content WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> sioc:content ?content } }',
  'subject-star': 'SELECT ?p ?o WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> ?p ?o } }',
  'latest-message': 'SELECT ?message ?created WHERE { GRAPH ?g { ?message sioc:has_member <https://pod.example/alice/.data/chat/default/index.ttl#thread_1>; dct:created ?created } } ORDER BY DESC(?created) LIMIT 1',
  'keyset-page': 'SELECT ?message ?rank WHERE { GRAPH ?g { ?message udfs:rank ?rank . FILTER(?rank > 100) } } ORDER BY ?rank LIMIT 50',
  'exact-graph': 'SELECT ?message WHERE { GRAPH <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl> { ?message a meeting:Message } }',
  'selective-po': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97; udfs:status "indexed" } }',
  'two-hop-chain': 'SELECT ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }',
  'four-hop-chain': 'SELECT ?message ?owner WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } }',
  'eight-hop-chain': 'SELECT ?message ?category WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } GRAPH ?g5 { ?owner udfs:provider ?provider } GRAPH ?g6 { ?provider ai:hasModel ?model } GRAPH ?g7 { ?model udfs:capability ?capability } GRAPH ?g8 { ?capability udfs:category ?category } }',
  'message-star': 'SELECT ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }',
  'message-snowflake': 'SELECT ?message ?threadCreated ?score WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread; udfs:score ?score } GRAPH ?g2 { ?thread dct:created ?threadCreated; udfs:workspace ?workspace } }',
  'bounded-many-to-many': 'SELECT ?left ?right WHERE { GRAPH ?g1 { ?left sioc:has_member ?thread; udfs:rank ?leftRank } GRAPH ?g2 { ?right sioc:has_member ?thread; udfs:rank ?rightRank } FILTER(?leftRank < 20 && ?rightRank < 20 && ?left != ?right) }',
  'low-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 0) } }',
  'medium-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 50) } }',
  'high-selectivity-filter': 'SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97 } }',
  'count-distinct-threads': 'SELECT (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } }',
  'ordered-top-k': 'SELECT ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100',
  'optional-content': 'SELECT ?message ?content WHERE { GRAPH ?g { ?message a meeting:Message . OPTIONAL { ?message sioc:content ?content } } }',
  'union-status-score': 'SELECT DISTINCT ?message WHERE { { GRAPH ?g { ?message udfs:status "indexed" } } UNION { GRAPH ?g { ?message udfs:score 100 } } }',
  'top-thread-aggregate': 'SELECT ?thread (COUNT(?message) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?thread ORDER BY DESC(?count) ?thread LIMIT 20',
} as const;

const SHORT_IDS = [
  'point-lookup',
  'subject-star',
  'latest-message',
  'keyset-page',
  'exact-graph',
  'selective-po',
] as const;

const LARGE_IDS = [
  'two-hop-chain',
  'four-hop-chain',
  'eight-hop-chain',
  'message-star',
  'message-snowflake',
  'bounded-many-to-many',
  'low-selectivity-filter',
  'medium-selectivity-filter',
  'high-selectivity-filter',
  'count-distinct-threads',
  'ordered-top-k',
  'optional-content',
  'union-status-score',
  'top-thread-aggregate',
] as const;

const AUTHORIZATION_IDS = [
  'authorization-inherited-prefix',
  'authorization-explicit-allow',
  'authorization-explicit-deny',
  'authorization-scoped-broad-join',
] as const;

const AUTHORIZATION_QUERY_SOURCES = {
  'authorization-inherited-prefix': 'message-star',
  'authorization-explicit-allow': 'two-hop-chain',
  'authorization-explicit-deny': 'count-distinct-threads',
  'authorization-scoped-broad-join': 'ordered-top-k',
} as const;

const ROW_EXPECTATIONS = {
  'point-lookup': { expectedRows: 1, minRows: undefined },
  'subject-star': { expectedRows: 9, minRows: undefined },
  'latest-message': { expectedRows: 1, minRows: undefined },
  'keyset-page': { expectedRows: 50, minRows: undefined },
  'exact-graph': { expectedRows: undefined, minRows: 1 },
  'selective-po': { expectedRows: undefined, minRows: 1 },
  'two-hop-chain': { expectedRows: undefined, minRows: 1 },
  'four-hop-chain': { expectedRows: undefined, minRows: 1 },
  'eight-hop-chain': { expectedRows: undefined, minRows: 1 },
  'message-star': { expectedRows: undefined, minRows: 1 },
  'message-snowflake': { expectedRows: undefined, minRows: 1 },
  'bounded-many-to-many': { expectedRows: undefined, minRows: 1 },
  'low-selectivity-filter': { expectedRows: undefined, minRows: 1 },
  'medium-selectivity-filter': { expectedRows: undefined, minRows: 1 },
  'high-selectivity-filter': { expectedRows: undefined, minRows: 1 },
  'count-distinct-threads': { expectedRows: 1, minRows: undefined },
  'ordered-top-k': { expectedRows: 100, minRows: undefined },
  'optional-content': { expectedRows: undefined, minRows: 1 },
  'union-status-score': { expectedRows: undefined, minRows: 1 },
  'top-thread-aggregate': { expectedRows: undefined, minRows: 1 },
  'authorization-inherited-prefix': { expectedRows: undefined, minRows: 1 },
  'authorization-explicit-allow': { expectedRows: undefined, minRows: 1 },
  'authorization-explicit-deny': { expectedRows: 1, minRows: undefined },
  'authorization-scoped-broad-join': { expectedRows: 100, minRows: undefined },
} as const;

describe('cloud replacement benchmark', () => {
  it('declares replacement weights before performance results exist', () => {
    expect(CLOUD_REPLACEMENT_GROUP_WEIGHTS).toEqual({ short: 0.60, large: 0.30, authorization: 0.10 });
    expect(Object.isFrozen(CLOUD_REPLACEMENT_GROUP_WEIGHTS)).toBe(true);
  });

  it('keeps the workload type contracts fixed', () => {
    expectTypeOf<CloudReplacementEngineId>().toEqualTypeOf<'rdf3x' | 'qlever'>();
    expectTypeOf<CloudReplacementWorkloadGroup>()
      .toEqualTypeOf<'short' | 'large' | 'authorization'>();
    expectTypeOf<CloudReplacementWorkload['sharedSurface']>().toEqualTypeOf<true>();
    expectTypeOf<CloudReplacementWorkload['orderSensitive']>().toEqualTypeOf<boolean>();
    expectTypeOf<CloudReplacementWorkload['concurrencyRepresentative']>().toEqualTypeOf<boolean>();
  });

  it('covers the exact shared workload matrix without QLever-only cases', () => {
    const cases = cloudReplacementWorkloads();
    expect(new Set(cases.map((testCase) => testCase.group)))
      .toEqual(new Set([ 'short', 'large', 'authorization' ]));
    expect(cases.filter((testCase) => testCase.group === 'short').map((testCase) => testCase.id))
      .toEqual(SHORT_IDS);
    expect(cases.filter((testCase) => testCase.group === 'large').map((testCase) => testCase.id))
      .toEqual(LARGE_IDS);
    expect(cases.filter((testCase) => testCase.group === 'authorization').map((testCase) => testCase.id))
      .toEqual(AUTHORIZATION_IDS);
    expect(cases).toHaveLength(24);
    expect(cases.every((testCase) => testCase.sharedSurface)).toBe(true);
    expect(cases.every((testCase) => testCase.purpose.length > 0)).toBe(true);
    expect(cases.every((testCase) => typeof testCase.orderSensitive === 'boolean')).toBe(true);
    expect(cases.every((testCase) =>
      (testCase.expectedRows === undefined) !== (testCase.minRows === undefined))).toBe(true);
    expect(cases.every((testCase) =>
      !/(?:ql:|contains-word|contains-entity|similar-entities|nearest-neighbor|geof:)/iu.test(testCase.sparql)))
      .toBe(true);
  });

  it('uses the exact standard-SPARQL query bodies and prefixes', () => {
    const casesById = new Map(cloudReplacementWorkloads().map((testCase) => [ testCase.id, testCase ]));
    for (const [ id, body ] of Object.entries(SHARED_QUERY_BODIES)) {
      expect(casesById.get(id)?.sparql).toBe(`${QUERY_PREFIXES}\n${body}`);
    }
    for (const [ authorizationId, sourceId ] of Object.entries(AUTHORIZATION_QUERY_SOURCES)) {
      expect(casesById.get(authorizationId)?.sparql).toBe(`${QUERY_PREFIXES}\n${SHARED_QUERY_BODIES[sourceId]}`);
    }
  });

  it('compiles every workload on the embedded RDF3X adapter surface', () => {
    const adapter = new RdfSparqlAdapter();
    for (const testCase of cloudReplacementWorkloads()) {
      expect(() => adapter.compile(testCase.sparql, ALICE_CHAT_PREFIX), testCase.id).not.toThrow();
    }
  });

  it('marks only the fixed concurrency representatives', () => {
    expect(cloudReplacementWorkloads()
      .filter((testCase) => testCase.concurrencyRepresentative)
      .map((testCase) => testCase.id))
      .toEqual([
        'point-lookup',
        'latest-message',
        'four-hop-chain',
        'eight-hop-chain',
        'count-distinct-threads',
        'authorization-scoped-broad-join',
      ]);
  });

  it('sets ordering and exact row expectations explicitly for every case', () => {
    const cases = cloudReplacementWorkloads();
    expect(cases.filter((testCase) => testCase.orderSensitive).map((testCase) => testCase.id))
      .toEqual([
        'latest-message',
        'keyset-page',
        'ordered-top-k',
        'top-thread-aggregate',
        'authorization-scoped-broad-join',
      ]);
    expect(Object.fromEntries(cases.map((testCase) => [
      testCase.id,
      { expectedRows: testCase.expectedRows, minRows: testCase.minRows },
    ]))).toEqual(ROW_EXPECTATIONS);
  });

  it('uses the four exact authorization scopes', () => {
    const authorizationCases = cloudReplacementWorkloads()
      .filter((testCase) => testCase.group === 'authorization');
    expect(authorizationCases.map((testCase) => testCase.accessScope)).toEqual([
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        version: 'inherited-prefix',
      },
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        allowedGraphUrls: [
          'https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl',
          'https://pod.example/alice/.data/chat/default/index.ttl',
        ],
        version: 'explicit-allow',
      },
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        deniedGraphUrls: [ 'https://pod.example/alice/.data/chat/default/2026/05/05/messages.ttl' ],
        version: 'explicit-deny',
      },
      {
        basePath: 'https://pod.example/alice/.data/chat/',
        mode: 'read',
        principal: 'urn:xpod-benchmark:alice',
        deniedGraphPrefixes: [ 'https://pod.example/alice/.data/chat/default/2026/05/05/' ],
        version: 'scoped-broad-join',
      },
    ]);
  });

  it('allows both explicit two-hop graphs and denies the populated denied day', () => {
    const workloads = cloudReplacementWorkloads();
    const explicitAllow = workloads
      .find((testCase) => testCase.id === 'authorization-explicit-allow');
    expect(explicitAllow?.accessScope).toBeDefined();
    expect(rdfAccessGraphAllowed(DAY_ONE, explicitAllow!.accessScope!)).toBe(true);
    expect(rdfAccessGraphAllowed(ALICE_CHAT_INDEX, explicitAllow!.accessScope!)).toBe(true);
    expect(rdfAccessGraphAllowed(DENIED_DAY, explicitAllow!.accessScope!)).toBe(false);
    for (const id of [ 'authorization-explicit-deny', 'authorization-scoped-broad-join' ]) {
      const workload = workloads.find((testCase) => testCase.id === id);
      expect(workload?.accessScope).toBeDefined();
      expect(rdfAccessGraphAllowed(DENIED_DAY, workload!.accessScope!)).toBe(false);
    }
  });

  it('executes explicit allow and the top-thread aggregate on a real RDF seed', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    const engine = new SolidRdfEngine({ index });
    const threadOne = `${ALICE_CHAT_INDEX}#thread_1`;
    const threadTwo = `${ALICE_CHAT_INDEX}#thread_2`;
    const hasMember = DataFactory.namedNode('http://rdfs.org/sioc/ns#has_member');
    const dayOneGraph = DataFactory.namedNode(DAY_ONE);
    engine.put([
      ...buildCloudReplacementTopology(1),
      DataFactory.quad(DataFactory.namedNode(`${DAY_ONE}#smoke_1`), hasMember,
        DataFactory.namedNode(threadOne), dayOneGraph),
      DataFactory.quad(DataFactory.namedNode(`${DAY_ONE}#smoke_2`), hasMember,
        DataFactory.namedNode(threadOne), dayOneGraph),
      DataFactory.quad(DataFactory.namedNode(`${DAY_ONE}#smoke_3`), hasMember,
        DataFactory.namedNode(threadTwo), dayOneGraph),
    ]);

    try {
      const adapter = new RdfSparqlAdapter();
      const workloads = cloudReplacementWorkloads();
      const explicitAllow = workloads.find((testCase) => testCase.id === 'authorization-explicit-allow');
      if (!explicitAllow?.accessScope) {
        throw new Error('authorization-explicit-allow must define an access scope');
      }
      const explicitResult = engine.query(applyRdfAccessScope(
        adapter.compile(explicitAllow.sparql, ALICE_CHAT_PREFIX).query,
        explicitAllow.accessScope,
      ));
      expect(explicitResult.bindings).toHaveLength(3);

      const aggregate = workloads.find((testCase) => testCase.id === 'top-thread-aggregate');
      if (!aggregate) {
        throw new Error('top-thread-aggregate workload is required');
      }
      const aggregateResult = engine.query(adapter.compile(aggregate.sparql, ALICE_CHAT_PREFIX).query);
      expect(aggregateResult.bindings.map((binding) => ({
        thread: binding.thread.value,
        count: binding.count.value,
      }))).toEqual([
        { thread: threadOne, count: '2' },
        { thread: threadTwo, count: '1' },
      ]);
      expect(aggregate.minRows).toBe(1);
      expect(aggregateResult.bindings.length).toBeGreaterThanOrEqual(aggregate.minRows ?? 0);
    } finally {
      await engine.close();
    }
  });

  it('executes all 24 workloads against the planned 32-pod skew fixture', async () => {
    const index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    const engine = new SolidRdfEngine({ index });
    const batch = buildRdfModelsSyntheticMessageBatch({ start: 0, count: 1024, syntheticPodCount: 32 });
    const workloads = cloudReplacementWorkloads();
    expect(batch.some((quad) => quad.graph.value === DENIED_DAY)).toBe(true);
    for (const id of [ 'authorization-explicit-deny', 'authorization-scoped-broad-join' ]) {
      const workload = workloads.find((testCase) => testCase.id === id);
      expect(workload?.accessScope).toBeDefined();
      expect(rdfAccessGraphAllowed(DENIED_DAY, workload!.accessScope!)).toBe(false);
    }
    engine.put([
      ...buildRdfModelsBenchmarkSeed({ syntheticMessages: 0, syntheticPodCount: 32 }),
      ...batch,
      ...buildCloudReplacementTopology(32),
    ]);

    try {
      const adapter = new RdfSparqlAdapter();
      const outcomes = workloads.map((testCase) => {
        const compiled = adapter.compile(testCase.sparql, ALICE_POD);
        const query = testCase.accessScope
          ? applyRdfAccessScope(compiled.query, testCase.accessScope)
          : compiled.query;
        const result = engine.query(query);
        const rowCount = result.bindings.length;
        const meetsRows = testCase.expectedRows === undefined
          ? rowCount >= (testCase.minRows ?? 0)
          : rowCount === testCase.expectedRows;
        let stableOrder = true;
        if (testCase.orderSensitive) {
          const repeated = engine.query(query);
          const serialize = (bindings: typeof result.bindings): string => JSON.stringify(bindings.map((binding) =>
            Object.fromEntries(Object.entries(binding)
              .sort(([ left ], [ right ]) => left.localeCompare(right))
              .map(([ variable, term ]) => [ variable, `${term.termType}:${term.value}` ]))));
          stableOrder = serialize(result.bindings) === serialize(repeated.bindings);
        }
        return {
          id: testCase.id,
          rowCount,
          expectedRows: testCase.expectedRows,
          minRows: testCase.minRows,
          meetsRows,
          stableOrder,
        };
      });

      expect(outcomes).toHaveLength(24);
      expect(outcomes.filter((outcome) => !outcome.meetsRows || !outcome.stableOrder)).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it('builds one reusable relationship topology per synthetic pod', () => {
    const quads = buildCloudReplacementTopology(2);
    expect(quads).toHaveLength(140);
    expect(quads.filter((quad) => quad.predicate.value === 'http://rdfs.org/sioc/ns#has_parent'))
      .toHaveLength(128);
    expect(quads.filter((quad) => quad.predicate.value === 'https://vocab.xpod.dev/ai#hasModel'))
      .toHaveLength(2);
    for (const predicate of [
      'https://undefineds.co/ns#workspace',
      'https://undefineds.co/ns#owner',
      'https://undefineds.co/ns#provider',
      'https://vocab.xpod.dev/ai#hasModel',
      'https://undefineds.co/ns#capability',
      'https://undefineds.co/ns#category',
    ]) {
      expect(quads.filter((quad) => quad.predicate.value === predicate)).toHaveLength(2);
    }
    expect(quads.some((quad) => quad.subject.value ===
      'https://pod.example/alice/.data/chat/default/index.ttl#thread_64')).toBe(true);
    expect(quads.some((quad) => quad.subject.value ===
      'https://pod.example/synthetic-1/.data/chat/default/index.ttl#thread_64')).toBe(true);
  });

  it('uses product provider identities and stores provider relations in the provider graph', () => {
    const provider = 'https://pod.example/alice/settings/providers/benchmark.ttl';
    const model = `${provider}#benchmark-model`;
    const capability = `${provider}#capability-agent`;
    const quads = buildCloudReplacementTopology(1);
    expect(quads.find((quad) => quad.predicate.value === 'https://vocab.xpod.dev/ai#hasModel'))
      .toMatchObject({
        subject: { value: provider },
        object: { value: model },
        graph: { value: provider },
      });
    expect(quads.find((quad) => quad.subject.value === model &&
      quad.predicate.value === 'https://undefineds.co/ns#capability'))
      .toMatchObject({ object: { value: capability }, graph: { value: provider } });
    expect(quads.find((quad) => quad.subject.value === capability &&
      quad.predicate.value === 'https://undefineds.co/ns#category'))
      .toMatchObject({ graph: { value: provider } });
    expect(quads.some((quad) => quad.predicate.value === 'https://undefineds.co/ns/ai#hasModel'))
      .toBe(false);
    expect(quads.some((quad) => [ quad.subject, quad.object, quad.graph ]
      .some((term) => term.value.includes('#this#model')))).toBe(false);
    expect(quads.find((quad) => quad.predicate.value === 'http://rdfs.org/sioc/ns#has_parent'))
      .toMatchObject({ graph: { value: 'https://pod.example/alice/.data/chat/default/index.ttl' } });
  });

  it('floors pod counts and always builds at least one pod', () => {
    expect(buildCloudReplacementTopology(2.9)).toHaveLength(140);
    expect(buildCloudReplacementTopology(0)).toHaveLength(70);
    expect(buildCloudReplacementTopology(-2)).toHaveLength(70);
  });
});
