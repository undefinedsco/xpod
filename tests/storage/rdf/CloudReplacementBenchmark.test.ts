import { describe, expect, expectTypeOf, it } from 'vitest';
import { DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';
import {
  buildCloudReplacementTopology,
  CLOUD_REPLACEMENT_GROUP_WEIGHTS,
  canonicalCloudReplacementDigests,
  canonicalCloudReplacementRow,
  canonicalCloudReplacementTerm,
  cloudReplacementWorkloads,
  compareCloudReplacementCase,
  type CloudReplacementBinding,
  type CloudReplacementCorrectness,
  type CloudReplacementEngineAdapter,
  type CloudReplacementEngineId,
  type CloudReplacementExecution,
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

const AUTHORIZATION_QUERY_BODIES = {
  'authorization-inherited-prefix': 'SELECT ?g ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }',
  'authorization-explicit-allow': 'SELECT ?g1 ?g2 ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }',
  'authorization-explicit-deny': 'SELECT ?g (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?g ORDER BY ?g',
  'authorization-scoped-broad-join': 'SELECT ?g ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100',
} as const;

const AUTHORIZATION_GRAPH_VARIABLES = {
  'authorization-inherited-prefix': [ 'g' ],
  'authorization-explicit-allow': [ 'g1', 'g2' ],
  'authorization-explicit-deny': [ 'g' ],
  'authorization-scoped-broad-join': [ 'g' ],
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
  'authorization-explicit-deny': { expectedRows: undefined, minRows: 1 },
  'authorization-scoped-broad-join': { expectedRows: 100, minRows: undefined },
} as const;

const pointCase: CloudReplacementWorkload = {
  id: 'point-lookup',
  group: 'short',
  purpose: 'test fixture',
  sparql: 'SELECT ?s WHERE { VALUES ?s { <urn:s:1> <urn:s:2> } }',
  sharedSurface: true,
  orderSensitive: false,
  concurrencyRepresentative: true,
  expectedRows: 2,
};

const authorizationCase: CloudReplacementWorkload = {
  ...pointCase,
  id: 'authorization-oracle',
  group: 'authorization',
  expectedRows: 1,
  concurrencyRepresentative: false,
  accessScope: {
    basePath: ALICE_CHAT_PREFIX,
    mode: 'read',
    deniedGraphUrls: [ DENIED_DAY ],
  },
  authorizationGraphVariables: [ 'g' ],
};

function fakeAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  rows: string[],
  options: {
    fallbackReason?: string;
    orderedDigest?: string;
    multisetDigest?: string;
    onExecute?: () => void;
  } = {},
): CloudReplacementEngineAdapter<Id> {
  const digests = canonicalCloudReplacementDigests(rows);
  return {
    id,
    async execute() {
      options.onExecute?.();
      return {
        rows,
        orderedDigest: options.orderedDigest ?? digests.orderedDigest,
        multisetDigest: options.multisetDigest ?? digests.multisetDigest,
        fallbackReason: options.fallbackReason ?? null,
        physicalPlan: [ `${id}:fake` ],
      };
    },
  };
}

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
    expectTypeOf<CloudReplacementWorkload['authorizationGraphVariables']>()
      .toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<CloudReplacementExecution['fallbackReason']>().toEqualTypeOf<string | null>();
    expectTypeOf<CloudReplacementCorrectness['rdf3x']>().toEqualTypeOf<CloudReplacementExecution>();
    expectTypeOf<CloudReplacementBinding>()
      .toEqualTypeOf<Readonly<Record<string, Term | undefined>>>();
    expectTypeOf<CloudReplacementEngineAdapter<'rdf3x'>['id']>().toEqualTypeOf<'rdf3x'>();
  });

  it('normalizes binding order without hiding ordered-result differences', async () => {
    const left = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:2', 's=NamedNode:urn:s:1' ]);
    const right = fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]);

    const comparison = await compareCloudReplacementCase(pointCase, left, right);

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(false);
    expect(comparison.correct).toBe(true);
    expect(comparison.failures).not.toContain('order-mismatch');
    expect(comparison.rdf3x.physicalPlan).toEqual([ 'rdf3x:fake' ]);
    expect(comparison.qlever.physicalPlan).toEqual([ 'qlever:fake' ]);
  });

  it('fails correctness when either adapter reports fallback', async () => {
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', [ 'o=Literal:ok' ]),
      fakeAdapter('qlever', [ 'o=Literal:ok' ], { fallbackReason: 'unsupported' }),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-fallback:unsupported');
  });

  it('fails correctness when an adapter reports an empty fallback reason', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', rows),
      fakeAdapter('qlever', rows, { fallbackReason: '' }),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-fallback:');
  });

  it('recomputes digests when different rows forge the same declared digest', async () => {
    const rdf3xRows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    const qleverRows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:3' ];
    const forged = canonicalCloudReplacementDigests(rdf3xRows);
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', rdf3xRows),
      fakeAdapter('qlever', qleverRows, forged),
    );

    expect(comparison.sameMultiset).toBe(false);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-invalid-ordered-digest');
    expect(comparison.failures).toContain('qlever-invalid-multiset-digest');
    expect(comparison.failures).toContain('multiset-mismatch');
  });

  it('rejects forged different digests without inventing a row mismatch', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', rows),
      fakeAdapter('qlever', rows, {
        orderedDigest: 'forged-ordered',
        multisetDigest: 'forged-multiset',
      }),
    );

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(true);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('qlever-invalid-ordered-digest');
    expect(comparison.failures).toContain('qlever-invalid-multiset-digest');
    expect(comparison.failures).not.toContain('multiset-mismatch');
  });

  it('reports exact expected-row failures for each engine', async () => {
    const comparison = await compareCloudReplacementCase(
      pointCase,
      fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]),
      fakeAdapter('qlever', [ 's=NamedNode:urn:s:1' ]),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toEqual([
      'rdf3x-expected-rows:expected=2:actual=1',
      'qlever-expected-rows:expected=2:actual=1',
    ]);
  });

  it('reports minimum-row failures per engine without hiding zero rows', async () => {
    const minimumCase: CloudReplacementWorkload = {
      ...pointCase,
      expectedRows: undefined,
      minRows: 2,
    };
    const comparison = await compareCloudReplacementCase(
      minimumCase,
      fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]),
      fakeAdapter('qlever', []),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toEqual([
      'rdf3x-min-rows:min=2:actual=1',
      'qlever-min-rows:min=2:actual=0',
      'multiset-mismatch',
    ]);
    expect(comparison.qlever.rows).toEqual([]);
  });

  it('requires matching order only for order-sensitive workloads', async () => {
    const comparison = await compareCloudReplacementCase(
      { ...pointCase, orderSensitive: true },
      fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:2', 's=NamedNode:urn:s:1' ]),
      fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]),
    );

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(false);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('order-mismatch');
  });

  it('canonicalizes variable order and all RDF literal identity fields', () => {
    const plain = DataFactory.literal('plain');
    const integer = DataFactory.literal('1', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#integer'));
    const decimal = DataFactory.literal('1', DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#decimal'));
    const english = DataFactory.literal('chat', 'en');
    const french = DataFactory.literal('chat', 'fr');
    const subject = DataFactory.namedNode('urn:s:1');

    expect(canonicalCloudReplacementTerm(plain)).toBe(JSON.stringify([
      'Literal',
      'plain',
      '',
      'http://www.w3.org/2001/XMLSchema#string',
    ]));
    expect(canonicalCloudReplacementTerm(english)).toBe(JSON.stringify([
      'Literal',
      'chat',
      'en',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString',
    ]));
    expect(canonicalCloudReplacementTerm(integer)).toBe(JSON.stringify([
      'Literal',
      '1',
      '',
      'http://www.w3.org/2001/XMLSchema#integer',
    ]));
    expect(canonicalCloudReplacementTerm(decimal)).toBe(JSON.stringify([
      'Literal',
      '1',
      '',
      'http://www.w3.org/2001/XMLSchema#decimal',
    ]));
    expect(canonicalCloudReplacementTerm(integer)).not.toBe(canonicalCloudReplacementTerm(decimal));
    expect(canonicalCloudReplacementTerm(english)).not.toBe(canonicalCloudReplacementTerm(french));
    expect(canonicalCloudReplacementRow({ value: integer, subject }))
      .toBe(canonicalCloudReplacementRow({ subject, value: integer }));
    expect(canonicalCloudReplacementRow({ value: integer })).not
      .toBe(canonicalCloudReplacementRow({ value: decimal }));
    expect(canonicalCloudReplacementRow({ value: english })).not
      .toBe(canonicalCloudReplacementRow({ value: french }));
  });

  it('canonicalizes missing and explicitly unbound variables identically', () => {
    const subject = DataFactory.namedNode('urn:s:1');

    expect(canonicalCloudReplacementRow({})).toBe(canonicalCloudReplacementRow({ missing: undefined }));
    expect(canonicalCloudReplacementRow({ subject })).toBe(canonicalCloudReplacementRow({
      missing: undefined,
      subject,
    }));
  });

  it('builds deterministic ordered and multiplicity-preserving multiset digests', () => {
    const first = canonicalCloudReplacementRow({ s: DataFactory.namedNode('urn:s:1') });
    const second = canonicalCloudReplacementRow({ s: DataFactory.namedNode('urn:s:2') });
    const original = canonicalCloudReplacementDigests([ first, second, first ]);
    const reordered = canonicalCloudReplacementDigests([ first, first, second ]);
    const deduplicated = canonicalCloudReplacementDigests([ first, second ]);

    expect(original.orderedDigest).not.toBe(reordered.orderedDigest);
    expect(original.multisetDigest).toBe(reordered.multisetDigest);
    expect(original.multisetDigest).not.toBe(deduplicated.multisetDigest);
    expect(original).toEqual(canonicalCloudReplacementDigests([ first, second, first ]));
  });

  it('executes both adapters and propagates authorization errors unchanged', async () => {
    const authorizationError = new Error('authorization denied');
    let qleverExecuted = false;
    const rdf3x: CloudReplacementEngineAdapter<'rdf3x'> = {
      id: 'rdf3x',
      execute() {
        throw authorizationError;
      },
    };
    const qlever: CloudReplacementEngineAdapter<'qlever'> = {
      id: 'qlever',
      async execute() {
        qleverExecuted = true;
        return fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ])
          .execute(pointCase);
      },
    };

    await expect(compareCloudReplacementCase(pointCase, rdf3x, qlever)).rejects.toBe(authorizationError);
    expect(qleverExecuted).toBe(true);
  });

  it('rejects swapped adapter identities before either adapter executes', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    let executions = 0;
    const rdf3x = fakeAdapter('qlever', rows, {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'rdf3x'>;
    const qlever = fakeAdapter('rdf3x', rows, {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'qlever'>;

    await expect(compareCloudReplacementCase(pointCase, rdf3x, qlever)).rejects.toThrow(
      'Cloud replacement adapter configuration error: expected rdf3x at rdf3x position, received qlever',
    );
    expect(executions).toBe(0);
  });

  it('rejects duplicate adapter identities before either adapter executes', async () => {
    const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
    let executions = 0;
    const rdf3x = fakeAdapter('rdf3x', rows, {
      onExecute: () => executions += 1,
    });
    const qlever = fakeAdapter('rdf3x', rows, {
      onExecute: () => executions += 1,
    }) as unknown as CloudReplacementEngineAdapter<'qlever'>;

    await expect(compareCloudReplacementCase(pointCase, rdf3x, qlever)).rejects.toThrow(
      'Cloud replacement adapter configuration error: expected qlever at qlever position, received rdf3x',
    );
    expect(executions).toBe(0);
  });

  it('fails authorization correctness when both adapters return the same denied graph', async () => {
    const deniedRow = canonicalCloudReplacementRow({
      g: DataFactory.namedNode(DENIED_DAY),
      message: DataFactory.namedNode(`${DENIED_DAY}#message`),
    });
    const comparison = await compareCloudReplacementCase(
      authorizationCase,
      fakeAdapter('rdf3x', [ deniedRow ]),
      fakeAdapter('qlever', [ deniedRow ]),
    );

    expect(comparison.sameMultiset).toBe(true);
    expect(comparison.sameOrder).toBe(true);
    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain(
      `rdf3x-authorization-row:0:denied-graph:g:${DENIED_DAY}`,
    );
    expect(comparison.failures).toContain(
      `qlever-authorization-row:0:denied-graph:g:${DENIED_DAY}`,
    );
  });

  it('fails authorization correctness when a required graph variable is missing', async () => {
    const missingGraphRow = canonicalCloudReplacementRow({
      message: DataFactory.namedNode(`${DAY_ONE}#message`),
    });
    const comparison = await compareCloudReplacementCase(
      authorizationCase,
      fakeAdapter('rdf3x', [ missingGraphRow ]),
      fakeAdapter('qlever', [ missingGraphRow ]),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain('rdf3x-authorization-row:0:missing-graph-variable:g');
    expect(comparison.failures).toContain('qlever-authorization-row:0:missing-graph-variable:g');
  });

  it.each([
    [ 'malformed row', 'not-json', 'malformed' ],
    [
      'non-named graph',
      canonicalCloudReplacementRow({ g: DataFactory.literal(DAY_ONE) }),
      'non-named-graph-variable:g',
    ],
  ])('fails authorization correctness for a %s', async (_name, row, failure) => {
    const comparison = await compareCloudReplacementCase(
      authorizationCase,
      fakeAdapter('rdf3x', [ row ]),
      fakeAdapter('qlever', [ row ]),
    );

    expect(comparison.correct).toBe(false);
    expect(comparison.failures).toContain(`rdf3x-authorization-row:0:${failure}`);
    expect(comparison.failures).toContain(`qlever-authorization-row:0:${failure}`);
  });

  it('fails closed when an authorization workload omits its oracle configuration', async () => {
    const row = canonicalCloudReplacementRow({ g: DataFactory.namedNode(DAY_ONE) });
    const withoutScope: CloudReplacementWorkload = {
      ...authorizationCase,
      accessScope: undefined,
    };
    const withoutVariables: CloudReplacementWorkload = {
      ...authorizationCase,
      authorizationGraphVariables: undefined,
    };

    const missingScope = await compareCloudReplacementCase(
      withoutScope,
      fakeAdapter('rdf3x', [ row ]),
      fakeAdapter('qlever', [ row ]),
    );
    const missingVariables = await compareCloudReplacementCase(
      withoutVariables,
      fakeAdapter('rdf3x', [ row ]),
      fakeAdapter('qlever', [ row ]),
    );

    expect(missingScope.failures).toContain('authorization-missing-access-scope');
    expect(missingVariables.failures).toContain('authorization-missing-graph-variables');
    expect(missingScope.correct).toBe(false);
    expect(missingVariables.correct).toBe(false);
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
    for (const [ authorizationId, body ] of Object.entries(AUTHORIZATION_QUERY_BODIES)) {
      expect(casesById.get(authorizationId)?.sparql).toBe(`${QUERY_PREFIXES}\n${body}`);
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
        'authorization-explicit-deny',
        'authorization-scoped-broad-join',
      ]);
    expect(Object.fromEntries(cases.map((testCase) => [
      testCase.id,
      { expectedRows: testCase.expectedRows, minRows: testCase.minRows },
    ]))).toEqual(ROW_EXPECTATIONS);
  });

  it('uses the four exact authorization scopes', () => {
    const workloads = cloudReplacementWorkloads();
    const authorizationCases = workloads
      .filter((testCase) => testCase.group === 'authorization');
    expect(workloads.filter((testCase) => testCase.group !== 'authorization')
      .every((testCase) => testCase.authorizationGraphVariables === undefined)).toBe(true);
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
    expect(Object.fromEntries(authorizationCases.map((testCase) => [
      testCase.id,
      testCase.authorizationGraphVariables,
    ]))).toEqual(AUTHORIZATION_GRAPH_VARIABLES);
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
      expect(explicitResult.bindings.every((binding) =>
        binding.g1.termType === 'NamedNode' && binding.g1.value === DAY_ONE &&
        binding.g2.termType === 'NamedNode' && binding.g2.value === ALICE_CHAT_INDEX)).toBe(true);

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
      const authorizationGraphs: string[] = [];
      const deniedByScopeGraphs: string[] = [];
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
          const serialize = (bindings: typeof result.bindings): string =>
            JSON.stringify(bindings.map((binding) => canonicalCloudReplacementRow(binding)));
          stableOrder = serialize(result.bindings) === serialize(repeated.bindings);
        }
        let authorizationSafe = true;
        if (testCase.group === 'authorization') {
          authorizationSafe = Boolean(
            testCase.accessScope && testCase.authorizationGraphVariables?.length,
          );
          for (const binding of result.bindings) {
            for (const variable of testCase.authorizationGraphVariables ?? []) {
              const graph = binding[variable];
              if (!graph || graph.termType !== 'NamedNode' ||
                !testCase.accessScope || !rdfAccessGraphAllowed(graph.value, testCase.accessScope)) {
                authorizationSafe = false;
              } else {
                authorizationGraphs.push(graph.value);
                if (!rdfAccessGraphAllowed(DENIED_DAY, testCase.accessScope)) {
                  deniedByScopeGraphs.push(graph.value);
                }
              }
            }
          }
        }
        return {
          id: testCase.id,
          rowCount,
          expectedRows: testCase.expectedRows,
          minRows: testCase.minRows,
          meetsRows,
          stableOrder,
          authorizationSafe,
        };
      });

      expect(outcomes).toHaveLength(24);
      expect(outcomes.filter((outcome) =>
        !outcome.meetsRows || !outcome.stableOrder || !outcome.authorizationSafe)).toEqual([]);
      expect(authorizationGraphs.length).toBeGreaterThan(0);
      expect(deniedByScopeGraphs).not.toContain(DENIED_DAY);
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
