# RDF3X/QLever Large-scale Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a product-shaped benchmark that makes an evidence-based decision on replacing Cloud/PG RDF3X with QLever.

**Architecture:** Reuse the existing models benchmark seed and PostgreSQL RDF engine, adding a focused comparison module for shared SPARQL workloads, normalized correctness, measurements, and replacement gates. The existing native benchmark script becomes the manual local/external runner; local Docker provides repeatable development runs, while one isolated SealOS PostgreSQL database provides the one-time 2M/10M decision run.

**Tech Stack:** TypeScript, Bun, Vitest, RDF/JS, `PostgresRdfEngine`, `SolidRdfSparqlEngine`, PostgreSQL 17, QLever PostgreSQL extension, Docker, SealOS.

---

## File structure

- Create `src/storage/rdf/cloud-replacement-benchmark.ts` — workload contracts, canonical binding normalization, alternating engine measurement, concurrency measurement, replacement gates, and report rendering.
- Modify `src/storage/rdf/models-benchmark.ts` — expose deterministic, bounded synthetic message batches without changing existing seed behavior.
- Modify `src/storage/rdf/index.ts` — export the Cloud replacement benchmark public contracts used by scripts and tests.
- Replace `scripts/native-rdf3x-benchmark.ts` — reuse the current entry point as the local/external RDF3X/QLever comparison runner; remove its uniform two-graph fixture.
- Modify `tests/native/NativeRdf3xBenchmarkScript.test.ts` — lock CLI safety, dry-run shape, credential redaction, and external-database constraints.
- Create `tests/storage/rdf/CloudReplacementBenchmark.test.ts` — unit-test deterministic workloads, correctness checks, percentiles, throughput, gates, and report rendering.
- Create `tests/integration/CloudReplacementBenchmark.integration.test.ts` — opt-in real PG17/QLever small-scale smoke over shared facts.
- Modify `package.json` — add one manual benchmark command; do not add CI or scheduled commands.
- Create `docs/rdf-cloud-engine-benchmark.md` — operator commands and interpretation rules.
- Create `docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.json` after the one-time run — sanitized raw evidence.
- Create `docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.md` after the one-time run — concise decision report.

## Task 1: Add bounded product-shaped seed batches

**Files:**
- Modify: `src/storage/rdf/models-benchmark.ts:405-410,4580-4641`
- Test: `tests/storage/rdf/PostgresRdfEngine.test.ts`

- [ ] **Step 1: Write failing tests for deterministic bounded batches**

```ts
import { buildRdfModelsSyntheticMessageBatch } from '../../../src/storage/rdf/models-benchmark';

it('builds deterministic skewed synthetic message batches without retaining the full target', () => {
  const first = buildRdfModelsSyntheticMessageBatch({ start: 100, count: 3, syntheticPodCount: 16 });
  const second = buildRdfModelsSyntheticMessageBatch({ start: 100, count: 3, syntheticPodCount: 16 });
  expect(first).toEqual(second);
  expect(first).toHaveLength(27);
  expect(new Set(first.map((quad) => quad.subject.value))).toHaveLength(3);
});

it('uses hot pods and threads while retaining long-tail coverage', () => {
  const quads = buildRdfModelsSyntheticMessageBatch({ start: 0, count: 200, syntheticPodCount: 32 });
  const parents = quads
    .filter((quad) => quad.predicate.value === 'http://rdfs.org/sioc/ns#has_member')
    .map((quad) => quad.object.value);
  expect(parents.some((value) => value.includes('/synthetic-31/'))).toBe(true);
  expect(parents.filter((value) => value.includes('https://pod.example/alice/')).length)
    .toBeGreaterThan(parents.filter((value) => value.includes('/synthetic-31/')).length);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
bun test tests/storage/rdf/PostgresRdfEngine.test.ts --run --timeout=300000
```

Expected: FAIL because `buildRdfModelsSyntheticMessageBatch` is not exported.

- [ ] **Step 3: Implement the bounded generator using the existing message vocabulary**

```ts
export interface RdfModelsSyntheticMessageBatchOptions {
  start: number;
  count: number;
  syntheticPodCount: number;
}

export function buildRdfModelsSyntheticMessageBatch(
  options: RdfModelsSyntheticMessageBatchOptions,
): Quad[] {
  const quads: Quad[] = [];
  const podCount = Math.max(1, Math.floor(options.syntheticPodCount));
  const start = Math.max(0, Math.floor(options.start));
  const count = Math.max(0, Math.floor(options.count));
  for (let offset = 0; offset < count; offset += 1) {
    const index = start + offset;
    const hot = index % 10 < 8;
    const podIndex = hot ? index % Math.min(4, podCount) : index % podCount;
    const threadIndex = hot ? index % 8 : index % RDF_MODELS_SYNTHETIC_THREAD_COUNT;
    const pod = rdfModelsSyntheticPodIri(podIndex);
    seedSyntheticMessage(quads, `${pod}/.data`, index, threadIndex);
  }
  return quads;
}
```

Extract the existing pod naming expression into a shared helper, use it from
`seedSyntheticThreads`, and change the message helper signature. These are the
complete behavioral edits; the remaining quad construction is not modified:

```diff
@@
-const RDF_MODELS_SYNTHETIC_THREAD_COUNT = 64;
+export const RDF_MODELS_SYNTHETIC_THREAD_COUNT = 64;
@@
+export function rdfModelsSyntheticPodIri(podIndex: number): string {
+  return podIndex === 0
+    ? RDF_MODELS_BENCHMARK_POD
+    : `https://pod.example/synthetic-${podIndex}`;
+}
+
-    const pod = podIndex === 0 ? RDF_MODELS_BENCHMARK_POD : `https://pod.example/synthetic-${podIndex}`;
+    const pod = rdfModelsSyntheticPodIri(podIndex);
@@
-function seedSyntheticMessage(quads: Quad[], data: string, index: number): void {
-  const thread = syntheticThreadIri(data, index % RDF_MODELS_SYNTHETIC_THREAD_COUNT);
+function seedSyntheticMessage(
+  quads: Quad[],
+  data: string,
+  index: number,
+  threadIndex = index % RDF_MODELS_SYNTHETIC_THREAD_COUNT,
+): void {
+  const thread = syntheticThreadIri(data, threadIndex);
```

- [ ] **Step 4: Run focused tests and typecheck**

```bash
bun test tests/storage/rdf/PostgresRdfEngine.test.ts --run --timeout=300000
bun run build:ts
```

Expected: PASS; existing models benchmark seed tests remain unchanged.

- [ ] **Step 5: Commit the seed boundary**

```bash
git add src/storage/rdf/models-benchmark.ts tests/storage/rdf/PostgresRdfEngine.test.ts
git commit -m "📦 Keep large RDF benchmark seeds bounded" -m "Generate product-shaped message facts in deterministic batches so 10M-fact experiments do not retain the full fixture in memory.

Constraint: Existing models benchmark fixtures must remain byte-for-byte deterministic
Confidence: high
Scope-risk: narrow
Tested: PostgresRdfEngine benchmark seed tests and TypeScript build"
```

## Task 2: Define shared SPARQL workloads and immutable decision weights

**Files:**
- Create: `src/storage/rdf/cloud-replacement-benchmark.ts`
- Modify: `src/storage/rdf/index.ts`
- Test: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`

- [ ] **Step 1: Write failing workload-shape tests**

```ts
import {
  buildCloudReplacementTopology,
  CLOUD_REPLACEMENT_GROUP_WEIGHTS,
  cloudReplacementWorkloads,
} from '../../../src/storage/rdf/cloud-replacement-benchmark';

it('declares replacement weights before performance results exist', () => {
  expect(CLOUD_REPLACEMENT_GROUP_WEIGHTS).toEqual({ short: 0.60, large: 0.30, authorization: 0.10 });
});

it('covers all shared workload groups without QLever-only cases', () => {
  const cases = cloudReplacementWorkloads();
  expect(new Set(cases.map((testCase) => testCase.group)))
    .toEqual(new Set([ 'short', 'large', 'authorization' ]));
  expect(cases.filter((testCase) => testCase.group === 'short').length).toBeGreaterThanOrEqual(6);
  expect(cases.filter((testCase) => testCase.group === 'large').length).toBeGreaterThanOrEqual(10);
  expect(cases.filter((testCase) => testCase.group === 'authorization').length).toBeGreaterThanOrEqual(4);
  expect(cases.every((testCase) => testCase.sharedSurface)).toBe(true);
});

it('builds one reusable relationship topology per synthetic pod', () => {
  const quads = buildCloudReplacementTopology(2);
  expect(quads.filter((quad) => quad.predicate.value === 'http://rdfs.org/sioc/ns#has_parent'))
    .toHaveLength(128);
  expect(quads.filter((quad) => quad.predicate.value === 'https://vocab.xpod.dev/ai#hasModel'))
    .toHaveLength(2);
});
```

- [ ] **Step 2: Verify RED**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add workload contracts and fixed weights**

```ts
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { RdfAccessMode, type RdfAccessScope } from './RdfAccessScope';
import {
  RDF_MODELS_SYNTHETIC_THREAD_COUNT,
  rdfModelsSyntheticPodIri,
} from './models-benchmark';

export type CloudReplacementEngineId = 'rdf3x' | 'qlever';
export type CloudReplacementWorkloadGroup = 'short' | 'large' | 'authorization';

export interface CloudReplacementWorkload {
  id: string;
  group: CloudReplacementWorkloadGroup;
  purpose: string;
  sparql: string;
  sharedSurface: true;
  orderSensitive: boolean;
  concurrencyRepresentative: boolean;
  expectedRows?: number;
  minRows?: number;
  accessScope?: RdfAccessScope;
  authorizationGraphVariables?: readonly string[];
}

export const CLOUD_REPLACEMENT_GROUP_WEIGHTS = Object.freeze({
  short: 0.60,
  large: 0.30,
  authorization: 0.10,
});
```

Add a small shared topology for the already-generated synthetic threads. This
does not duplicate message facts; it adds the product relationship chain needed
by 2/4/8-hop workloads:

```ts
function benchmarkQuad(subject: string, predicate: string, object: string, graph: string): Quad {
  return DataFactory.quad(
    DataFactory.namedNode(subject),
    DataFactory.namedNode(predicate),
    DataFactory.namedNode(object),
    DataFactory.namedNode(graph),
  );
}

export function buildCloudReplacementTopology(podCount: number): Quad[] {
  const quads: Quad[] = [];
  for (let podIndex = 0; podIndex < Math.max(1, Math.floor(podCount)); podIndex += 1) {
    const pod = rdfModelsSyntheticPodIri(podIndex);
    const data = `${pod}/.data`;
    const graph = `${data}/chat/default/index.ttl`;
    const chat = `${graph}#this`;
    const workspaceGraph = `${data}/workspaces/default/index.ttl`;
    const workspace = `${workspaceGraph}#this`;
    const owner = `${pod}/profile/card#me`;
    const provider = `${pod}/settings/providers/benchmark.ttl`;
    const model = `${provider}#benchmark-model`;
    const capability = `${provider}#capability-agent`;
    const category = 'urn:xpod-benchmark:category:agent';

    for (let threadIndex = 0; threadIndex < RDF_MODELS_SYNTHETIC_THREAD_COUNT; threadIndex += 1) {
      quads.push(DataFactory.quad(
        DataFactory.namedNode(`${graph}#thread_${threadIndex + 1}`),
        DataFactory.namedNode('http://rdfs.org/sioc/ns#has_parent'),
        DataFactory.namedNode(chat),
        DataFactory.namedNode(graph),
      ));
    }
    quads.push(
      benchmarkQuad(chat, 'https://undefineds.co/ns#workspace', workspace, graph),
      benchmarkQuad(workspace, 'https://undefineds.co/ns#owner', owner, workspaceGraph),
      benchmarkQuad(owner, 'https://undefineds.co/ns#provider', provider, provider),
      benchmarkQuad(provider, 'https://vocab.xpod.dev/ai#hasModel', model, provider),
      benchmarkQuad(model, 'https://undefineds.co/ns#capability', capability, provider),
      benchmarkQuad(capability, 'https://undefineds.co/ns#category', category, provider),
    );
  }
  return quads;
}
```

Export `RDF_MODELS_SYNTHETIC_THREAD_COUNT` and
`rdfModelsSyntheticPodIri` from `models-benchmark.ts`; this lets the topology
reuse the exact existing identity scheme.

`cloudReplacementWorkloads()` returns static standard-SPARQL cases:

- short: point lookup, subject-star, latest-message, keyset-page, exact-graph, selective predicate-object;
- large: 2/4/8-hop chains, star, snowflake, many-to-many, three selectivity levels, aggregate/count-distinct, ordered top-k, optional/union/top-level aggregate;
- authorization: inherited prefix, explicit allow, explicit deny, scoped broad join.

Every query uses the existing message/thread/chat/workspace/provider vocabulary
and the topology above. Each case explicitly sets `orderSensitive`; do not infer
correctness behavior by parsing the query string. Do not add text, vector,
spatial, or other QLever-only syntax.

Use this concrete query matrix; `query(body)` prepends the SIOC, DCTERMS,
UDFS, Meeting, and AI prefixes. The AI prefix is
`https://vocab.xpod.dev/ai#`:

| id | group | SPARQL body | ordered | rows |
|---|---|---|---:|---|
| `point-lookup` | short | `SELECT ?content WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> sioc:content ?content } }` | no | 1 |
| `subject-star` | short | `SELECT ?p ?o WHERE { GRAPH ?g { <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl#synthetic_0> ?p ?o } }` | no | 9 |
| `latest-message` | short | `SELECT ?message ?created WHERE { GRAPH ?g { ?message sioc:has_member <https://pod.example/alice/.data/chat/default/index.ttl#thread_1>; dct:created ?created } } ORDER BY DESC(?created) LIMIT 1` | yes | 1 |
| `keyset-page` | short | `SELECT ?message ?rank WHERE { GRAPH ?g { ?message udfs:rank ?rank . FILTER(?rank > 100) } } ORDER BY ?rank LIMIT 50` | yes | 50 |
| `exact-graph` | short | `SELECT ?message WHERE { GRAPH <https://pod.example/alice/.data/chat/default/2026/05/01/messages.ttl> { ?message a meeting:Message } }` | no | at least 1 |
| `selective-po` | short | `SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97; udfs:status "indexed" } }` | no | at least 1 |
| `two-hop-chain` | large | `SELECT ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }` | no | at least 1 |
| `four-hop-chain` | large | `SELECT ?message ?owner WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } }` | no | at least 1 |
| `eight-hop-chain` | large | `SELECT ?message ?category WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } GRAPH ?g3 { ?chat udfs:workspace ?workspace } GRAPH ?g4 { ?workspace udfs:owner ?owner } GRAPH ?g5 { ?owner udfs:provider ?provider } GRAPH ?g6 { ?provider ai:hasModel ?model } GRAPH ?g7 { ?model udfs:capability ?capability } GRAPH ?g8 { ?capability udfs:category ?category } }` | no | at least 1 |
| `message-star` | large | `SELECT ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }` | no | at least 1 |
| `message-snowflake` | large | `SELECT ?message ?threadCreated ?score WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread; udfs:score ?score } GRAPH ?g2 { ?thread dct:created ?threadCreated; udfs:workspace ?workspace } }` | no | at least 1 |
| `bounded-many-to-many` | large | `SELECT ?left ?right WHERE { GRAPH ?g1 { ?left sioc:has_member ?thread; udfs:rank ?leftRank } GRAPH ?g2 { ?right sioc:has_member ?thread; udfs:rank ?rightRank } FILTER(?leftRank < 20 && ?rightRank < 20 && ?left != ?right) }` | no | at least 1 |
| `low-selectivity-filter` | large | `SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 0) } }` | no | at least 1 |
| `medium-selectivity-filter` | large | `SELECT ?message WHERE { GRAPH ?g { ?message udfs:score ?score . FILTER(?score > 50) } }` | no | at least 1 |
| `high-selectivity-filter` | large | `SELECT ?message WHERE { GRAPH ?g { ?message udfs:score 97 } }` | no | at least 1 |
| `count-distinct-threads` | large | `SELECT (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } }` | no | 1 |
| `ordered-top-k` | large | `SELECT ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100` | yes | 100 |
| `optional-content` | large | `SELECT ?message ?content WHERE { GRAPH ?g { ?message a meeting:Message . OPTIONAL { ?message sioc:content ?content } } }` | no | at least 1 |
| `union-status-score` | large | `SELECT DISTINCT ?message WHERE { { GRAPH ?g { ?message udfs:status "indexed" } } UNION { GRAPH ?g { ?message udfs:score 100 } } }` | no | at least 1 |
| `top-thread-aggregate` | large | `SELECT ?thread (COUNT(?message) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?thread ORDER BY DESC(?count) ?thread LIMIT 20` | yes | at least 1 |

Authorization cases use audit variants that explicitly project every graph
variable needed by the independent authorization oracle. Only these four cases
set `authorizationGraphVariables`:

| id | SPARQL body | ordered | rows | graph variables |
|---|---|---:|---|---|
| `authorization-inherited-prefix` | `SELECT ?g ?message ?thread ?created ?score ?workspace WHERE { GRAPH ?g { ?message sioc:has_member ?thread; dct:created ?created; udfs:score ?score; udfs:workspace ?workspace; udfs:status "indexed" } }` | no | at least 1 | `['g']` |
| `authorization-explicit-allow` | `SELECT ?g1 ?g2 ?message ?chat WHERE { GRAPH ?g1 { ?message sioc:has_member ?thread } GRAPH ?g2 { ?thread sioc:has_parent ?chat } }` | no | at least 1 | `['g1', 'g2']` |
| `authorization-explicit-deny` | `SELECT ?g (COUNT(DISTINCT ?thread) AS ?count) WHERE { GRAPH ?g { ?message sioc:has_member ?thread } } GROUP BY ?g ORDER BY ?g` | yes | at least 1 | `['g']` |
| `authorization-scoped-broad-join` | `SELECT ?g ?message ?score WHERE { GRAPH ?g { ?message udfs:score ?score } } ORDER BY DESC(?score) ?message LIMIT 100` | yes | 100 | `['g']` |

The audit variants use these exact scopes:

```ts
const aliceChatPrefix = 'https://pod.example/alice/.data/chat/';
const aliceChatIndex = `${aliceChatPrefix}default/index.ttl`;
const dayOne = `${aliceChatPrefix}default/2026/05/01/messages.ttl`;
const deniedDay = `${aliceChatPrefix}default/2026/05/05/messages.ttl`;
const authorizationScopes: RdfAccessScope[] = [
  { basePath: aliceChatPrefix, mode: RdfAccessMode.READ, principal: 'urn:xpod-benchmark:alice', version: 'inherited-prefix' },
  { basePath: aliceChatPrefix, mode: RdfAccessMode.READ, principal: 'urn:xpod-benchmark:alice', allowedGraphUrls: [ dayOne, aliceChatIndex ], version: 'explicit-allow' },
  { basePath: aliceChatPrefix, mode: RdfAccessMode.READ, principal: 'urn:xpod-benchmark:alice', deniedGraphUrls: [ deniedDay ], version: 'explicit-deny' },
  { basePath: aliceChatPrefix, mode: RdfAccessMode.READ, principal: 'urn:xpod-benchmark:alice', deniedGraphPrefixes: [ `${aliceChatPrefix}default/2026/05/05/` ], version: 'scoped-broad-join' },
];
```

The all-24 real-fixture test requires every projected graph term to be present,
named, and accepted by its case's `rdfAccessGraphAllowed` scope. The Task 3
canonical-row oracle applies the same invariant fail closed to malformed,
missing, non-named, and scope-denied graph terms. A graph denied by a given
scope must never appear in that case's result rows.

Set `concurrencyRepresentative: true` only for `point-lookup`,
`latest-message`, `four-hop-chain`, `eight-hop-chain`,
`count-distinct-threads`, and `authorization-scoped-broad-join`. Run the
1/8/32 sustained tests on this fixed subset in cache-off mode; all cases still
receive both cache-off and production-cache-on latency measurements.

- [ ] **Step 4: Export and verify GREEN**

Add to `src/storage/rdf/index.ts`:

```ts
export * from './cloud-replacement-benchmark';
```

Run:

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
bun run build:ts
```

Expected: PASS.

- [ ] **Step 5: Commit workload definitions**

```bash
git add src/storage/rdf/cloud-replacement-benchmark.ts src/storage/rdf/index.ts tests/storage/rdf/CloudReplacementBenchmark.test.ts
git commit -m "🧪 Compare RDF engines on product workloads" -m "Predeclare shared serving, complex join, and authorization workloads before observing large-scale results.

Rejected: Include QLever-only search cases in the replacement score | RDF3X has no like-for-like baseline
Confidence: high
Scope-risk: narrow
Tested: Cloud replacement workload unit tests and TypeScript build"
```

## Task 3: Add canonical correctness and no-fallback engine adapters

**Files:**
- Modify: `src/storage/rdf/cloud-replacement-benchmark.ts`
- Test: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`

- [ ] **Step 1: Write failing adapter and mismatch tests**

```ts
it('normalizes binding order without hiding ordered-result differences', async () => {
  const left = fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:2', 's=NamedNode:urn:s:1' ]);
  const right = fakeAdapter('qlever', [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]);
  const comparison = await compareCloudReplacementCase(pointCase, left, right);
  expect(comparison.sameMultiset).toBe(true);
  expect(comparison.sameOrder).toBe(false);
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

it('fails correctness for an empty but non-null fallback reason', async () => {
  const rows = [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ];
  const comparison = await compareCloudReplacementCase(
    pointCase,
    fakeAdapter('rdf3x', rows),
    fakeAdapter('qlever', rows, { fallbackReason: '' }),
  );
  expect(comparison.correct).toBe(false);
  expect(comparison.failures).toContain('qlever-fallback:');
});

function fakeAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  rows: string[],
  options: {
    fallbackReason?: string;
    orderedDigest?: string;
    multisetDigest?: string;
  } = {},
): CloudReplacementEngineAdapter<Id> {
  const digests = canonicalCloudReplacementDigests(rows);
  return {
    id,
    async execute() {
      return {
        rows,
        orderedDigest: options.orderedDigest ?? digests.orderedDigest,
        multisetDigest: options.multisetDigest ?? digests.multisetDigest,
        fallbackReason: options.fallbackReason ?? null,
        physicalPlan: [ `${id}:fake` ],
        queryElapsedMs: null,
      };
    },
  };
}

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
```

- [ ] **Step 2: Verify RED**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
```

Expected: FAIL because digest revalidation, runtime identity checks, unbound
canonicalization, and the authorization graph oracle are absent.

- [ ] **Step 3: Implement canonical digests and adapter contracts**

```ts
import type { Term } from '@rdfjs/types';

export interface CloudReplacementExecution {
  rows: string[];
  orderedDigest: string;
  multisetDigest: string;
  fallbackReason: string | null;
  physicalPlan: string[];
  queryElapsedMs: number | null;
}

export interface CloudReplacementEngineAdapter<
  Id extends CloudReplacementEngineId = CloudReplacementEngineId,
> {
  readonly id: Id;
  execute(
    workload: CloudReplacementWorkload,
    sampleIdentity?: string,
    signal?: AbortSignal,
  ): Promise<CloudReplacementExecution>;
}

export interface CloudReplacementCorrectness {
  correct: boolean;
  sameMultiset: boolean;
  sameOrder: boolean;
  failures: string[];
  rdf3x: CloudReplacementExecution;
  qlever: CloudReplacementExecution;
}

export type CloudReplacementBinding = Readonly<Record<string, Term | undefined>>;

function canonicalTermTuple(term: Term): [ string, string, string, string ] {
  return term.termType === 'Literal'
    ? [ term.termType, term.value, term.language, term.datatype.value ]
    : [ term.termType, term.value, '', '' ];
}
```

Canonical rows sort variables by variable name and omit `undefined` entries, so
missing and explicitly unbound bindings are identical. Literal identity includes
the RDFJS-provided datatype and language; lock plain `xsd:string`, language-tagged
`rdf:langString`, and typed integer/decimal literals in tests. Ordered digests use
the original row sequence; multiset digests sort every row without deduplicating.

`compareCloudReplacementCase` is fail closed at these boundaries:

- accept `CloudReplacementEngineAdapter<'rdf3x'>` and
  `CloudReplacementEngineAdapter<'qlever'>`; before execution, reject swapped or
  duplicate runtime ids with a configuration error and execute neither adapter;
- use fixed `rdf3x` / `qlever` position labels for every failure;
- treat `null` as the only no-fallback sentinel, including `''` as fallback;
- recompute both digests from `execution.rows`; compare only recomputed values,
  and add `<engine>-invalid-ordered-digest` or
  `<engine>-invalid-multiset-digest` when declarations disagree;
- check expected/minimum rows independently for each engine, always compare the
  recomputed multiset, and require recomputed order only for ordered workloads;
- for authorization workloads, require `accessScope` and non-empty
  `authorizationGraphVariables`, parse every canonical row, and require every
  listed graph variable to exist, be a `NamedNode`, and pass
  `rdfAccessGraphAllowed`; malformed, missing, non-named, or denied graph values
  fail correctness even when both adapters return identical rows and digests;
- propagate adapter exceptions unchanged and pass physical plans through without
  making performance decisions.

Correctness-only executions may report `queryElapsedMs: null`; latency
executions in Task 4 require a finite non-negative value measured only around
the raw engine query/materialization interval.

Negative tests must cover different rows with forged equal declarations, equal
rows with forged different declarations, swapped/duplicate adapter identities,
missing/unbound canonical variables, and identical denied authorization rows.

- [ ] **Step 4: Verify correctness tests**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
bun run build:ts
```

Expected: PASS.

- [ ] **Step 5: Commit correctness boundary**

```bash
git add src/storage/rdf/cloud-replacement-benchmark.ts tests/storage/rdf/CloudReplacementBenchmark.test.ts docs/superpowers/plans/2026-07-16-rdf3x-qlever-large-scale-benchmark.md
git commit -m "🔒 Make RDF engine comparison fail closed" -m "Require canonical result agreement and reject compatibility fallback before any timing can support replacement.

Constraint: Authorization-denied rows must never be normalized away
Constraint: Adapter ids and declared digests are untrusted runtime input
Confidence: high
Scope-risk: narrow
Tested: Adapter identity, digest forgery, canonical RDF term, authorization oracle, ordering, expected-row, and fallback unit tests"
```

## Task 4: Measure alternating latency and sustained concurrency

**Files:**
- Modify: `src/storage/rdf/cloud-replacement-benchmark.ts`
- Test: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`

- [ ] **Step 1: Write failing measurement tests with a fake clock**

```ts
it('alternates engine order and reports p50 p95 p99', async () => {
  const order: string[] = [];
  const identitySource = createCloudReplacementSampleIdentitySource('task4-suite');
  const result = await measureCloudReplacementCase(
    pointCase,
    timedFakeAdapter('rdf3x', order, 10),
    timedFakeAdapter('qlever', order, 5),
    {
      warmupIterations: 3,
      iterations: 20,
      cacheMode: 'off',
      identitySource,
      coldFirstEngine: 'rdf3x',
      operationTimeoutMs: 30_000,
    },
  );
  expect(order.slice(0, 4)).toEqual([ 'rdf3x', 'qlever', 'qlever', 'rdf3x' ]);
  expect(result.rdf3x.samplesMs).toHaveLength(20);
  expect(result.rdf3x.p95Ms).toBe(10);
  expect(result.qlever.p99Ms).toBe(5);
});

it('runs every concurrency lane for the configured duration', async () => {
  let now = 0;
  const identitySource = createCloudReplacementSampleIdentitySource('task4-suite');
  const result = await measureCloudReplacementConcurrency(pointCase, fakeAdapter('rdf3x', [ 's=NamedNode:urn:s:1' ]), {
    concurrency: 8,
    durationMs: 1_000,
    cacheMode: 'off',
    identitySource,
    operationTimeoutMs: 30_000,
    now: () => {
      now += 10;
      return now;
    },
  });
  expect(result.completed).toBeGreaterThan(8);
  expect(result.errors).toBe(0);
  expect(result.throughputPerSecond).toBeGreaterThan(0);
});

function timedFakeAdapter<Id extends CloudReplacementEngineId>(
  id: Id,
  order: string[],
  durationMs: number,
): CloudReplacementEngineAdapter<Id> {
  const base = fakeAdapter(id, [ 's=NamedNode:urn:s:1', 's=NamedNode:urn:s:2' ]);
  return {
    id,
    async execute(workload, sampleIdentity, signal) {
      order.push(id);
      const result = await base.execute(workload, sampleIdentity, signal);
      return { ...result, queryElapsedMs: durationMs };
    },
  };
}
```

- [ ] **Step 2: Verify RED**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
```

Expected: FAIL because measurement functions are absent.

- [ ] **Step 3: Implement measurement contracts**

```ts
export interface CloudReplacementLatency {
  cacheMode: 'off' | 'production';
  coldMs: number;
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface CloudReplacementConcurrency {
  cacheMode: 'off' | 'production';
  concurrency: 1 | 8 | 32;
  durationMs: number;
  elapsedMs: number;
  completed: number;
  errors: number;
  throughputPerSecond: number;
}

export interface CloudReplacementSampleIdentitySource {
  next(engine: CloudReplacementEngineId): string;
}

export interface CloudReplacementPgDiagnostics {
  sharedBlocksRead: number | null;
  sharedBlocksHit: number | null;
  tempBytes: number | null;
  memoryPeakBytes: number | null;
  memoryLimitBytes: number | null;
  diagnosticsUnavailable: string[];
}
```

Create one caller-owned identity source per benchmark run and reuse it across
latency plus all 1/8/32 concurrency calls. The factory rejects empty/newline
namespaces and emits globally monotonic trailing comments:

```ts
const identitySource = createCloudReplacementSampleIdentitySource(runNamespace);
identitySource.next(engine.id);
// # xpod-benchmark-sample:<namespace>:<engine>:<counter>
```

Cache-off options require that shared source; production mode never calls it.
Measure cache-off and production-cache-on separately. The caller supplies
`coldFirstEngine`; the first timed execution occurs only after the caller has
prepared cold state, without claiming to clear PostgreSQL shared buffers. Keep
one alternating round counter across cold, warmup, and measured phases. Cold is
reported separately and never enters steady-state samples or percentiles.

Every latency execution must return finite non-negative `queryElapsedMs` around
only the raw engine query/materialization boundary; digest, canonicalization,
plan reads, and adapter post-processing stay outside it. Both latency and
concurrency use a finite positive per-operation timeout and pass an
`AbortSignal` to adapters. Concurrency workers stop starting work at one common
deadline, await or time out in-flight tail work, report actual `elapsedMs`, and
derive throughput from completed operations divided by actual elapsed seconds.
Exceptions, timeouts, and every non-null fallback reason (including `''`) count
as errors; invalid duration/iteration/timeout inputs fail as specified by tests.

- [ ] **Step 4: Verify timing and concurrency tests**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
bun run build:ts
```

Expected: PASS.

- [ ] **Step 5: Commit measurement behavior**

```bash
git add src/storage/rdf/cloud-replacement-benchmark.ts tests/storage/rdf/CloudReplacementBenchmark.test.ts docs/superpowers/plans/2026-07-16-rdf3x-qlever-large-scale-benchmark.md
git commit -m "⏱️ Remove order bias from RDF engine measurements" -m "Alternate engine execution, separate cache modes, and capture latency plus sustained concurrency without comparing incompatible samples.

Confidence: high
Scope-risk: narrow
Tested: Deterministic latency, percentile, cache-mode, and concurrency unit tests"
```

## Task 5: Implement replacement gates and sanitized reports

**Files:**
- Modify: `src/storage/rdf/cloud-replacement-benchmark.ts`
- Test: `tests/storage/rdf/CloudReplacementBenchmark.test.ts`

- [ ] **Step 1: Write failing decision and redaction tests**

```ts
const passingDecisionInput: CloudReplacementDecisionInput = {
  correctnessPassed: true,
  criticalShortP95Ratios: [ 1.05, 1.10 ],
  weightedP95Ratio: 0.75,
  throughputRatio: 1.30,
  largeCaseSpeedups: [ 1.60, 2.10 ],
  errorRate: 0,
  memoryLimitRatio: 0.70,
  tempDiskLimitRatio: 0.10,
};

it('returns the three predeclared replacement outcomes', () => {
  expect(decideCloudReplacement(passingDecisionInput).recommendation).toBe('replace');
  expect(decideCloudReplacement({
    ...passingDecisionInput,
    criticalShortP95Ratios: [ 1.25 ],
  }).recommendation).toBe('selective-routing-candidate');
  expect(decideCloudReplacement({
    ...passingDecisionInput,
    correctnessPassed: false,
  }).recommendation).toBe('retain-rdf3x');
});

it('redacts URLs and credentials from persisted reports', () => {
  const sanitized = sanitizeCloudReplacementEnvironment({
    connectionString: 'postgres://user:secret@db.example/xpod_benchmark',
    postgresVersion: '17.5',
    engineCommit: 'abc123',
  });
  expect(JSON.stringify(sanitized)).not.toContain('secret');
  expect(JSON.stringify(sanitized)).not.toContain('db.example');
  expect(sanitized.database).toBe('xpod_benchmark');
});
```

- [ ] **Step 2: Verify RED**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
```

Expected: FAIL because decision and sanitization functions are absent.

- [ ] **Step 3: Implement immutable replacement thresholds**

```ts
export const CLOUD_REPLACEMENT_THRESHOLDS = Object.freeze({
  maxCriticalShortP95Ratio: 1.20,
  maxWeightedP95Ratio: 0.80,
  minThroughputRatio: 1.25,
  minLargeCaseSpeedup: 1.50,
  minLargeWinningCases: 2,
  maxMemoryLimitRatio: 0.85,
  maxTempDiskLimitRatio: 0.20,
  maxErrorRate: 0,
});

export interface CloudReplacementDecisionInput {
  correctnessPassed: boolean;
  criticalShortP95Ratios: number[];
  weightedP95Ratio: number;
  throughputRatio: number;
  largeCaseSpeedups: number[];
  errorRate: number;
  memoryLimitRatio: number | null;
  tempDiskLimitRatio: number | null;
}

export type CloudReplacementRecommendation =
  | 'replace'
  | 'retain-rdf3x'
  | 'selective-routing-candidate';

export interface CloudReplacementDecision {
  recommendation: CloudReplacementRecommendation;
  passed: Record<string, boolean>;
  observed: CloudReplacementDecisionInput;
}

export function sanitizeCloudReplacementEnvironment(input: {
  connectionString: string;
  postgresVersion: string;
  engineCommit: string;
}): { database: string; postgresVersion: string; engineCommit: string } {
  const url = new URL(input.connectionString);
  return {
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    postgresVersion: input.postgresVersion,
    engineCommit: input.engineCommit,
  };
}
```

Gate order:

1. correctness, authorization, fallback, or error-rate failure → `retain-rdf3x`;
2. all gates pass → `replace`;
3. at least two large cases reach 1.5x but a short, weighted, or resource gate fails → `selective-routing-candidate`;
4. otherwise → `retain-rdf3x`.

Compute weighted p95 ratio from fixed group weights with equal weight per case within a group. Throughput uses total completed operations divided by total measured seconds.

- [ ] **Step 4: Render sanitized JSON and Markdown**

`renderCloudReplacementMarkdown(report)` includes environment identity without host/user/password, target and actual facts, correctness failures, per-case cold/p50/p95/p99, concurrency throughput, index build/storage, resource diagnostics, each gate, and exactly one recommendation.

- [ ] **Step 5: Verify gates, redaction, and Markdown snapshots**

```bash
bun test tests/storage/rdf/CloudReplacementBenchmark.test.ts --run
bun run build:ts
```

Expected: PASS; snapshots contain no connection information.

- [ ] **Step 6: Commit report semantics**

```bash
git add src/storage/rdf/cloud-replacement-benchmark.ts tests/storage/rdf/CloudReplacementBenchmark.test.ts
git commit -m "📊 Turn RDF benchmarks into a replacement decision" -m "Apply predeclared correctness, serving, aggregate, complex-query, and resource gates and render sanitized evidence.

Directive: Do not change weights or thresholds after observing the SealOS run
Confidence: high
Scope-risk: narrow
Tested: Replace, retain, selective-route, resource-gate, and redaction unit tests"
```

## Task 6: Replace the standalone fixture with the safe local/external runner

**Files:**
- Replace: `scripts/native-rdf3x-benchmark.ts`
- Modify: `tests/native/NativeRdf3xBenchmarkScript.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI contract tests**

```ts
expect(help.stdout).toContain('--targetQuads=N');
expect(help.stdout).toContain('--mode=local|external');
expect(help.stdout).toContain('--concurrency=1,8,32');
expect(help.stdout).toContain('XPOD_RDF_BENCHMARK_PG_URL');
expect(help.stdout).not.toContain('--connectionString');

expect(() => parseArgs([ '--mode=external', '--targetQuads=2000000' ], {}))
  .toThrow(/XPOD_RDF_BENCHMARK_PG_URL/);
expect(() => assertDedicatedBenchmarkDatabase('postgres://user:secret@example/xpod'))
  .toThrow(/dedicated benchmark database/);
expect(assertDedicatedBenchmarkDatabase('postgres://user:secret@example/xpod_benchmark'))
  .toBe('xpod_benchmark');
expect(benchmarkCleanupSql('xpod_benchmark')).toEqual([
  'DROP SCHEMA public CASCADE',
  'CREATE SCHEMA public',
]);
```

- [ ] **Step 2: Verify RED**

```bash
bun test tests/native/NativeRdf3xBenchmarkScript.test.ts --run
```

Expected: FAIL on the new CLI contract.

- [ ] **Step 3: Implement local and external provisioning**

Export `parseArgs`, `assertDedicatedBenchmarkDatabase`, and
`benchmarkCleanupSql` for tests. `benchmarkCleanupSql` first applies the same
`_benchmark` database-name assertion and then returns only `DROP SCHEMA public
CASCADE` plus `CREATE SCHEMA public`. Accepted options:

```text
--mode=local|external
--targetQuads=N
--iterations=20
--warmupIterations=3
--concurrency=1,8,32
--cacheMode=off|production|both
--operationTimeoutMs=30000
--image=xpod-rdf-postgres:pg17-smoke
--out=.test-data/rdf-engine-perf-reports/...
--dry-run
```

External mode reads only `XPOD_RDF_BENCHMARK_PG_URL`, refuses databases not
ending in `_benchmark`, and never prints the URL. Local mode removes its
disposable Docker container. External mode runs the tested cleanup SQL in a
`finally` block inside the dedicated database; it never connects to or touches
another service database.

- [ ] **Step 4: Implement bounded loading and real adapters**

```ts
const syntheticPodCount = targetQuads >= 10_000_000
  ? 512
  : targetQuads >= 2_000_000
    ? 128
    : 32;

await engine.put(buildRdfModelsBenchmarkSeed({
  syntheticMessages: 0,
  syntheticPodCount,
  caseProfile: 'default',
}));
await engine.put(buildCloudReplacementTopology(syntheticPodCount));

for (let start = 0; loadedFacts < targetQuads; start += messagesPerBatch) {
  const batch = buildRdfModelsSyntheticMessageBatch({
    start,
    count: messagesPerBatch,
    syntheticPodCount,
  });
  await engine.put(batch);
  loadedFacts += batch.length;
}
```

Build RDF3X with `nativeSparqlEnabled: false` and QLever with
`nativeSparqlEnabled: true`. Both use the same facts and are wrapped by
`SolidRdfSparqlEngine` without compatibility fallback. Capture
`getMetrics().lastPrimary`; reject metrics that show fallback or the wrong
selected engine.

Create one `CloudReplacementSampleIdentitySource` for the whole run namespace
and reuse it across every cache-off latency call plus the 1/8/32 concurrency
lanes. Prepare caller-owned cold state before any correctness or warmup work,
run the cold measurement first, and alternate `coldFirstEngine` across
workload/cache-mode calls so neither engine receives a systematic ordering
benefit. The runner is responsible for cold-state preparation; the helper does
not clear PostgreSQL shared buffers.

The real adapters must honor the supplied `AbortSignal` by cancelling the raw
engine operation when possible and returning promptly after abort. Measure
`queryElapsedMs` around only raw engine query/materialization. Read plans,
canonicalize rows, and compute digests after that interval; correctness-only
calls may use `queryElapsedMs: null`. Concurrency intentionally measures the
whole adapter completion interval and reports actual elapsed wall time including
in-flight tail completion. Pass the configured finite positive
`operationTimeoutMs` to every latency and concurrency call, and treat timeout or
non-null fallback (including `''`) as an error rather than a completed operation.

Before and after each engine phase, snapshot `pg_stat_database` block and temp
counters. Time RDF3X derived-index refresh and QLever initialization separately,
then call `storageStats()` for fact and derived-index bytes. The default sustained
concurrency duration is exactly 60 seconds for each 1/8/32 lane. Resource fields
that PostgreSQL cannot expose are `null` with an explicit
`diagnosticsUnavailable` reason until the external resource sampler supplies
their sanitized high-water values.

- [ ] **Step 5: Add one manual package command**

```json
"benchmark:rdf-cloud-replacement": "bun scripts/native-rdf3x-benchmark.ts"
```

Do not add it to CI, releases, or schedules.

- [ ] **Step 6: Verify CLI and dry run**

```bash
bun test tests/native/NativeRdf3xBenchmarkScript.test.ts --run
bun run benchmark:rdf-cloud-replacement --dry-run --mode=local --targetQuads=20000
bun run build:ts
```

Expected: PASS; dry-run JSON contains fixed weights and thresholds but no credentials.

- [ ] **Step 7: Commit the runner**

```bash
git add scripts/native-rdf3x-benchmark.ts tests/native/NativeRdf3xBenchmarkScript.test.ts package.json
git commit -m "🛡️ Make large RDF engine trials isolated and repeatable" -m "Run RDF3X and QLever over shared product facts locally or in a dedicated external benchmark database without persisting credentials.

Constraint: External runs must never target the production database
Rejected: Accept a connection string CLI argument | it leaks through shell history and process listings
Confidence: high
Scope-risk: moderate
Tested: CLI contract, database safety, dry-run, and TypeScript build"
```

## Task 7: Prove the real local PG17/QLever path

**Files:**
- Create: `tests/integration/CloudReplacementBenchmark.integration.test.ts`
- Create: `docs/rdf-cloud-engine-benchmark.md`

- [ ] **Step 1: Write an opt-in integration smoke**

The test launches the same PG17 image as the CLI, loads at least 20k facts, and asserts:

```ts
expect(report.actualFacts).toBeGreaterThanOrEqual(20_000);
expect(report.cases.every((testCase) => testCase.correctness.correct)).toBe(true);
expect(report.cases.every((testCase) => testCase.rdf3x.fallbackReason === null)).toBe(true);
expect(report.cases.every((testCase) => testCase.qlever.fallbackReason === null)).toBe(true);
expect(report.environment.qleverReady).toBe(true);
```

Guard only the expensive body with `XPOD_RUN_CLOUD_RDF_BENCHMARK_SMOKE=1`; the module still loads and typechecks normally.

- [ ] **Step 2: Run the real small-scale smoke**

```bash
XPOD_RUN_CLOUD_RDF_BENCHMARK_SMOKE=1 \
  bun test tests/integration/CloudReplacementBenchmark.integration.test.ts \
  --run --timeout=900000
```

Expected: PASS with no fallback and identical result digests.

- [ ] **Step 3: Run local 100k and 500k reports**

```bash
bun run benchmark:rdf-cloud-replacement \
  --mode=local --targetQuads=100000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=both \
  --out=.test-data/rdf-engine-perf-reports/cloud-replacement-100k.json

bun run benchmark:rdf-cloud-replacement \
  --mode=local --targetQuads=500000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=both \
  --out=.test-data/rdf-engine-perf-reports/cloud-replacement-500k.json
```

Expected: both complete, all correctness cases pass, and the recommendation is marked local diagnostic evidence rather than a Cloud decision.

- [ ] **Step 4: Document operation and interpretation**

Document local/external commands, secret injection, dedicated `_benchmark` database safety, fixed weights and thresholds, Direct SQL's lower-bound role, QLever-only exclusions, cleanup behavior, and recommendation meanings.

- [ ] **Step 5: Commit verified local operation**

```bash
git add tests/integration/CloudReplacementBenchmark.integration.test.ts docs/rdf-cloud-engine-benchmark.md
git commit -m "✅ Prove RDF3X and QLever share the real product path" -m "Exercise the PG17 extension and both product adapters over the same facts before using external performance evidence.

Confidence: high
Scope-risk: narrow
Tested: Opt-in native integration smoke plus 100k and 500k manual benchmark runs"
```

## Task 8: Run the one-time SealOS 2M/10M experiment

**Files:**
- Create: `docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.json`
- Create: `docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.md`

- [ ] **Step 1: Select a dedicated SealOS benchmark database**

Use a database ending in `_benchmark` on a PG17 image containing the verified QLever extension. Never use Xpod production, billing, identity, gateway, or Inngest databases.

```sql
SELECT current_database(), version();
SELECT xpod_rdf.native_sparql_capabilities();
SELECT count(*) FROM pg_catalog.pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema');
```

Expected: dedicated database, PG17, `ready=true`, and no unrelated application tables.

- [ ] **Step 2: Run the 2M experiment once**

```bash
test -n "${XPOD_RDF_BENCHMARK_PG_URL:-}" || exit 1
bun run benchmark:rdf-cloud-replacement \
  --mode=external --targetQuads=2000000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=both \
  --out=.test-data/rdf-engine-perf-reports/sealos-cloud-replacement-2m.json
```

Expected: all correctness cases pass; the URL is absent from stdout and report.

- [ ] **Step 3: Run the 10M experiment once**

```bash
test -n "${XPOD_RDF_BENCHMARK_PG_URL:-}" || exit 1
bun run benchmark:rdf-cloud-replacement \
  --mode=external --targetQuads=10000000 \
  --iterations=20 --warmupIterations=3 \
  --concurrency=1,8,32 --cacheMode=both \
  --out=.test-data/rdf-engine-perf-reports/sealos-cloud-replacement-10m.json
```

Expected: correctness passes and the batch reaches the predeclared decision.

- [ ] **Step 4: Capture resource high-water evidence**

Sample SealOS/Kubernetes metrics every five seconds during each batch:

```bash
while kill -0 "$BENCHMARK_PID" 2>/dev/null; do
  date -u +%FT%TZ
  kubectl top pod "$PG_POD" --containers -n "$PG_NAMESPACE"
  sleep 5
done > .test-data/rdf-engine-perf-reports/sealos-resource-samples.log
```

Calculate peak memory as a percentage of the container limit and peak disk use as a percentage of the volume. Persist only sanitized values, not namespace, pod name, hostname, or cluster URL.

- [ ] **Step 5: Sanitize and combine evidence**

```bash
rg -n 'postgres://|password|secret|token|api[_-]?key|sealos|\.svc|@[^ ]+/' \
  docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.*
```

Expected: no secrets or infrastructure identifiers. Verify the report includes both scales, concurrency 1/8/32, every gate, and one recommendation.

- [ ] **Step 6: Verify cleanup**

Reconnect and confirm benchmark tables contain no generated facts. Remove a temporary SealOS deployment/database after the report is secured.

- [ ] **Step 7: Commit sanitized reports only**

```bash
git add docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.json docs/reports/rdf-engine/2026-07-rdf3x-qlever-sealos.md
git commit -m "📈 Decide the Cloud RDF engine from large-scale evidence" -m "Record the one-time 2M/10M SealOS comparison under predeclared correctness, latency, throughput, and resource gates.

Constraint: SealOS is decision evidence, not a recurring test environment
Confidence: high
Scope-risk: narrow
Directive: Do not reinterpret the recommendation by changing weights after the run
Tested: 2M and 10M product workloads at concurrency 1, 8, and 32
Not-tested: Long-running mixed read/write production traffic"
```

## Task 9: Run repository-wide verification

**Files:**
- Verify only; modify only files directly responsible for failures caused by Tasks 1-8.

- [ ] **Step 1: Run focused tests**

```bash
bun test \
  tests/storage/rdf/CloudReplacementBenchmark.test.ts \
  tests/native/NativeRdf3xBenchmarkScript.test.ts \
  tests/integration/CloudReplacementBenchmark.integration.test.ts \
  --run --timeout=300000
```

Expected: unit/CLI tests PASS; opt-in integration body SKIP unless enabled.

- [ ] **Step 2: Run RDF storage regressions**

```bash
bun test \
  tests/storage/rdf/PostgresRdfEngine.test.ts \
  tests/storage/rdf/SolidRdfSparqlEngine.test.ts \
  tests/storage/rdf/RdfSparqlAdapter.test.ts \
  --run --timeout=300000
```

Expected: PASS.

- [ ] **Step 3: Run static checks**

```bash
bun run build:ts
bun run build:components
```

Expected: PASS.

- [ ] **Step 4: Run required full integration**

```bash
bun run test:integration
```

Expected: PASS with no new failures.

- [ ] **Step 5: Audit final state**

```bash
git diff --check
git status --short
git log --oneline --max-count=12
```

Expected: cohesive Lore commits; unrelated pre-existing worktree changes remain unstaged and untouched.

## Final evidence report

The completion report includes changed files and commits; local 100k/500k results; SealOS 2M/10M p50/p95/p99 and concurrency; index build/storage and resource peaks; exact gate results; one recommendation; and the remaining risk that long-running mixed read/write traffic was not modeled.
