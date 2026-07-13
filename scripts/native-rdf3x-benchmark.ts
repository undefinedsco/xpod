import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DataFactory } from 'n3';
import { Pool } from 'pg';
import { PostgresRdfEngine } from '../src/storage/rdf/PostgresRdfEngine';
import { RdfAccessMode, type RdfAccessScope } from '../src/storage/rdf/RdfAccessScope';
import { SolidRdfSparqlEngine } from '../src/storage/rdf/SolidRdfSparqlEngine';

const args = process.argv.slice(2);
const scale = positiveInteger('scale', 20_000);
const iterations = positiveInteger('iterations', 5);
const image = option('image') ?? process.env.XPOD_RDF_POSTGRES_IMAGE ?? 'xpod-rdf-postgres:pg17-dev';
const out = option('out') ?? `.test-data/rdf-engine-perf-reports/native-rdf3x-${scale}.json`;

if (args.includes('--help')) {
  process.stdout.write(`Usage: bun scripts/native-rdf3x-benchmark.ts [options]\n\n` +
    `  --scale=N          Number of generated subjects. Default: 20000\n` +
    `  --iterations=N     Warm samples per case. Default: 5\n` +
    `  --image=NAME       PG17 image with a ready native SPARQL provider\n` +
    `  --out=PATH         JSON report path\n` +
    `  --dry-run          Print the benchmark plan without Docker\n`);
  process.exit(0);
}

const plan = {
  scale,
  iterations,
  image,
  engines: [ 'direct-sql', 'rdf3x', 'native-sparql' ],
  measurements: [ 'firstRunMs', 'warmMedianMs' ],
  cases: [ 'point-lookup', 'two-pattern-join', 'three-pattern-join', 'scoped-two-pattern-join' ],
};

if (args.includes('--dry-run')) {
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  process.exit(0);
}

await run();
process.exit(0);

async function run(): Promise<void> {
  const container = `xpod-native-rdf3x-bench-${process.pid}`;
  let setup: PostgresRdfEngine | undefined;
  let rdf3xStore: PostgresRdfEngine | undefined;
  let nativeStore: PostgresRdfEngine | undefined;
  let pool: Pool | undefined;
  try {
    docker('rm', '-f', container, true);
    docker(
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=xpod',
      '-e', 'POSTGRES_DB=xpod',
      '-p', '127.0.0.1::5432',
      image,
    );
    await waitForPostgres(container);
    const port = docker('port', container, '5432/tcp').trim().split(':').at(-1);
    if (!port) {
      throw new Error('Docker did not publish PostgreSQL port 5432');
    }
    const connectionString = `postgres://postgres:xpod@127.0.0.1:${port}/xpod`;

    setup = new PostgresRdfEngine({
      connectionString,
      deferPgCustomIndexInitialization: true,
    });
    await setup.open();
    pool = new Pool({ connectionString, max: 1 });
    const ids = await seed(setup, pool, scale);
    await setup.close();
    setup = undefined;

    rdf3xStore = new PostgresRdfEngine({
      connectionString,
      deferPgCustomIndexInitialization: true,
      queryResultCacheEnabled: false,
      materializedResultCacheEnabled: false,
    });
    nativeStore = new PostgresRdfEngine({
      connectionString,
      nativeSparqlEnabled: true,
      deferPgCustomIndexInitialization: true,
      queryResultCacheEnabled: false,
      materializedResultCacheEnabled: false,
    });
    await rdf3xStore.open();
    await rdf3xStore.refreshDerivedIndexes({ mode: 'full' });
    await nativeStore.open();

    const rdf3x = new SolidRdfSparqlEngine(rdf3xStore);
    const native = new SolidRdfSparqlEngine(nativeStore);
    const cases = benchmarkCases(scale, ids);
    const results = [];
    for (const benchmarkCase of cases) {
      const direct = await measure(
        () => runDirect(pool!, benchmarkCase.sql),
        benchmarkCase.expectedRows,
      );
      const rdf3xResult = await measure(
        () => runSparql(rdf3x, benchmarkCase.sparql, benchmarkCase.accessScope),
        benchmarkCase.expectedRows,
      );
      const nativeResult = await measure(
        () => runSparql(native, benchmarkCase.sparql, benchmarkCase.accessScope),
        benchmarkCase.expectedRows,
      );
      results.push({
        id: benchmarkCase.id,
        expectedRows: benchmarkCase.expectedRows,
        directSql: direct,
        rdf3x: { ...rdf3xResult, metrics: rdf3x.getMetrics().lastPrimary },
        native: { ...nativeResult, metrics: native.getMetrics().lastPrimary },
      });
    }

    const storage = await rdf3xStore.storageStats();
    const report = {
      generatedAt: new Date().toISOString(),
      ...plan,
      quads: scale + Math.floor(scale / 10) + Math.floor(scale / 100),
      storage: {
        factsBytes: storage.factsBytes,
        rdf3xBytes: storage.rdf3x?.stats.databaseBytes ?? 0,
        derivedBytes: storage.derivedBytes,
        totalBytes: storage.totalBytes,
        totalToFactsRatio: storage.totalToFactsRatio,
      },
      results,
      notes: [
        'All engines read the same PostgreSQL facts in one disposable PG17 instance.',
        'firstRunMs is cold at the engine/query-cache layer; PostgreSQL shared buffers may already contain seeded pages.',
        'directSql returns numeric term ids and is a lower bound; RDF3X and native SPARQL also parse SPARQL and materialize RDF bindings.',
        'native SPARQL warm samples include its backend-session result cache when the request identity is unchanged.',
      ],
    };
    const target = path.resolve(out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await nativeStore?.close().catch(() => undefined);
    await rdf3xStore?.close().catch(() => undefined);
    await setup?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    docker('rm', '-f', container, true);
  }
}

interface BenchmarkCase {
  id: string;
  sparql: string;
  sql: string;
  expectedRows: number;
  accessScope?: RdfAccessScope;
}

interface BenchmarkTermIds {
  subject1: number;
  p1: number;
  p2: number;
  p3: number;
  o1: number;
  o2: number;
  o3: number;
  graphA: number;
  graphB: number;
}

function benchmarkCases(scaleValue: number, ids: BenchmarkTermIds): BenchmarkCase[] {
  const base = 'urn:bench:';
  const graphPattern = `GRAPH ?g { ?s <urn:bench:p> <urn:bench:o> . ?s <urn:bench:p2> <urn:bench:o2> }`;
  const twoPatternSql = `
    SELECT q1.subject_id
    FROM rdf_quads q1
    JOIN rdf_quads q2
      ON q2.graph_id = q1.graph_id AND q2.subject_id = q1.subject_id
    WHERE q1.predicate_id = ${ids.p1} AND q1.object_id = ${ids.o1}
      AND q2.predicate_id = ${ids.p2} AND q2.object_id = ${ids.o2}
  `;
  return [
    {
      id: 'point-lookup',
      sparql: `SELECT ?o WHERE { GRAPH ?g { <urn:bench:s:1> <urn:bench:p> ?o } }`,
      sql: `SELECT object_id FROM rdf_quads WHERE subject_id = ${ids.subject1} AND predicate_id = ${ids.p1}`,
      expectedRows: 1,
    },
    {
      id: 'two-pattern-join',
      sparql: `SELECT ?s WHERE { ${graphPattern} }`,
      sql: twoPatternSql,
      expectedRows: Math.floor(scaleValue / 10),
    },
    {
      id: 'three-pattern-join',
      sparql: `SELECT ?s WHERE { GRAPH ?g {
        ?s <urn:bench:p> <urn:bench:o> .
        ?s <urn:bench:p2> <urn:bench:o2> .
        ?s <urn:bench:p3> <urn:bench:o3>
      } }`,
      sql: `${twoPatternSql}
        AND EXISTS (
          SELECT 1 FROM rdf_quads q3
          WHERE q3.graph_id = q1.graph_id AND q3.subject_id = q1.subject_id
            AND q3.predicate_id = ${ids.p3} AND q3.object_id = ${ids.o3}
        )`,
      expectedRows: Math.floor(scaleValue / 100),
    },
    {
      id: 'scoped-two-pattern-join',
      sparql: `SELECT ?s WHERE { ${graphPattern} }`,
      sql: `${twoPatternSql} AND q1.graph_id = ${ids.graphA}`,
      expectedRows: Math.floor(scaleValue / 10) - Math.floor(scaleValue / 20),
      accessScope: {
        basePath: base,
        mode: RdfAccessMode.READ,
        principal: 'urn:bench:alice',
        version: 'permission-1',
        allowedGraphUrls: [ 'urn:bench:g:a' ],
      },
    },
  ];
}

async function seed(
  engine: PostgresRdfEngine,
  poolValue: Pool,
  scaleValue: number,
): Promise<BenchmarkTermIds> {
  const p1 = DataFactory.namedNode('urn:bench:p');
  const p2 = DataFactory.namedNode('urn:bench:p2');
  const p3 = DataFactory.namedNode('urn:bench:p3');
  const o1 = DataFactory.namedNode('urn:bench:o');
  const o2 = DataFactory.namedNode('urn:bench:o2');
  const o3 = DataFactory.namedNode('urn:bench:o3');
  const graphA = DataFactory.namedNode('urn:bench:g:a');
  const graphB = DataFactory.namedNode('urn:bench:g:b');
  const quads = [];
  for (let id = 1; id <= scaleValue; id += 1) {
    const subject = DataFactory.namedNode(`urn:bench:s:${id}`);
    const graph = id % 4 === 0 ? graphB : graphA;
    quads.push(DataFactory.quad(subject, p1, o1, graph));
    if (id % 10 === 0) {
      quads.push(DataFactory.quad(subject, p2, o2, graph));
    }
    if (id % 100 === 0) {
      quads.push(DataFactory.quad(subject, p3, o3, graph));
    }
  }
  await engine.put(quads);
  await poolValue.query('ANALYZE rdf_terms');
  await poolValue.query('ANALYZE rdf_quads');
  const values = [
    'urn:bench:s:1',
    p1.value,
    p2.value,
    p3.value,
    o1.value,
    o2.value,
    o3.value,
    graphA.value,
    graphB.value,
  ];
  const rows = await poolValue.query<{ id: string; value: string }>(
    'SELECT id, value FROM rdf_terms WHERE value = ANY($1::text[])',
    [ values ],
  );
  const byValue = new Map(rows.rows.map((row) => [ row.value, Number(row.id) ]));
  const id = (value: string): number => {
    const resolved = byValue.get(value);
    if (resolved === undefined) {
      throw new Error(`Missing benchmark term id for ${value}`);
    }
    return resolved;
  };
  return {
    subject1: id('urn:bench:s:1'),
    p1: id(p1.value),
    p2: id(p2.value),
    p3: id(p3.value),
    o1: id(o1.value),
    o2: id(o2.value),
    o3: id(o3.value),
    graphA: id(graphA.value),
    graphB: id(graphB.value),
  };
}

async function runDirect(poolValue: Pool, sql: string): Promise<number> {
  return (await poolValue.query(sql)).rowCount ?? 0;
}

async function runSparql(
  engine: SolidRdfSparqlEngine,
  sparql: string,
  accessScope?: RdfAccessScope,
): Promise<number> {
  const stream = await engine.queryBindings(sparql, 'urn:bench:', accessScope);
  let rows = 0;
  for await (const _binding of stream as unknown as AsyncIterable<unknown>) {
    rows += 1;
  }
  return rows;
}

async function measure(runOnce: () => Promise<number>, expectedRows: number) {
  const first = await timed(runOnce);
  assertRows(first.rows, expectedRows);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const sample = await timed(runOnce);
    assertRows(sample.rows, expectedRows);
    samples.push(sample.ms);
  }
  return {
    rows: first.rows,
    firstRunMs: round(first.ms),
    warmMedianMs: round(median(samples)),
    warmSamplesMs: samples.map(round),
  };
}

async function timed(runOnce: () => Promise<number>): Promise<{ rows: number; ms: number }> {
  const started = performance.now();
  const rows = await runOnce();
  return { rows, ms: performance.now() - started };
}

function assertRows(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`Benchmark result mismatch: expected ${expected} rows, got ${actual}`);
  }
}

function median(values: number[]): number {
  const sorted = [ ...values ].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = option(name);
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function docker(...input: Array<string | boolean>): string {
  const ignoreFailure = typeof input.at(-1) === 'boolean' ? input.pop() as boolean : false;
  try {
    return execFileSync('docker', input as string[], {
      encoding: 'utf8',
      stdio: [ 'ignore', 'pipe', 'pipe' ],
    });
  } catch (error) {
    if (ignoreFailure) {
      return '';
    }
    throw error;
  }
}

async function waitForPostgres(container: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      docker('exec', container, 'pg_isready', '-U', 'postgres', '-d', 'xpod');
      const capabilities = docker(
        'exec', container, 'psql', '-U', 'postgres', '-d', 'xpod', '-Atc',
        `SELECT xpod_rdf.native_sparql_capabilities()->>'abiVersion', ` +
          `xpod_rdf.native_sparql_capabilities()->>'ready'`,
      ).trim();
      if (capabilities === '1|true') {
        return;
      }
    } catch {
      // PostgreSQL and initdb are still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('PostgreSQL/native SPARQL image did not become ready');
}
