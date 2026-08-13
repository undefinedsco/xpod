import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { Pool } from 'pg';
import { PostgresRdfEngine } from '../storage/rdf/PostgresRdfEngine';
import { RdfQuerySparqlEngine } from '../storage/rdf/RdfQuerySparqlEngine';
import {
  RdfSparqlAdapter,
  type RdfSparqlUpdateDelta,
} from '../storage/rdf/RdfSparqlAdapter';
import { applyRdfAccessScope, type RdfAccessScope } from '../storage/rdf/RdfAccessScope';
import type { RdfEngineLike, RdfNativeSparqlResult } from '../storage/rdf/types';
import {
  DEFAULT_BASE_PATH,
  assertPath,
  buildSemanticReport,
  connectionStringWithSearchPath,
  exactQuadPattern,
  makeAccessScope,
  quoteIdentifier,
  runCaseWithEngine,
  serializeQuads,
  slug,
  termToSparqlJson,
  type PostgresPublicSemanticHarnessOptions,
  type SemanticCaseExecutor,
  type SemanticConformanceReport,
  type SemanticFixtureCase,
  type SemanticFixtureModule,
} from './RdfSemanticConformance';

export async function runPostgresPublicSemanticConformance(
  options: PostgresPublicSemanticHarnessOptions,
): Promise<SemanticConformanceReport> {
  assertPath('fixturePath', options.fixturePath);
  assertPath('artifactPath', options.artifactPath);
  if (!options.connectionString) {
    throw new Error('connectionString is required');
  }

  const fixture = require(path.resolve(options.fixturePath)) as SemanticFixtureModule;
  const admin = new Pool({ connectionString: options.connectionString, max: 1 });
  const results: SemanticConformanceReport['results'] = [];
  const failed: SemanticConformanceReport['failed'] = [];
  try {
    for (let index = 0; index < fixture.semanticConformanceCases.length; index += 1) {
      const testCase = fixture.semanticConformanceCases[index];
      const schema = `xpod_semantic_public_${process.pid}_${index}_${randomUUID().replaceAll('-', '')}`;
      try {
        await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        const connectionString = connectionStringWithSearchPath(options.connectionString, schema);
        const engine = new PostgresRdfEngine({
          driver: 'pg',
          connectionString,
          rdfAccelerationProfile: 'pg-hot-operators',
          maintenanceIntervalMs: 0,
        });
        results.push(await runPublicRdfQuerySemanticCase(
          engine,
          testCase,
          options.timeoutMs,
          `postgres-public-schema:${schema}`,
        ));
      } catch (error) {
        failed.push({
          caseId: testCase.id,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      }
    }
  } finally {
    await admin.end();
  }

  const report = buildSemanticReport({
    backend: 'pg',
    engine: 'pg-public-rdf-query-authority',
    caseIds: fixture.REQUIRED_CASES,
    failed,
    results,
    sourceDeniedValidatedBy: 'allowedSourceUrls/deniedSourceUrls resolved by PG RDF query authority',
  });
  mkdirSync(path.dirname(options.artifactPath), { recursive: true });
  writeFileSync(options.artifactPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function runPublicRdfQuerySemanticCase(
  engine: RdfEngineLike,
  testCase: SemanticFixtureCase,
  timeoutMs: number | undefined,
  authority: string,
): Promise<SemanticConformanceReport['results'][number]> {
  return runCaseWithEngine(engine, testCase, timeoutMs, authority, true, publicRdfQueryExecutor);
}

const publicRdfQueryExecutor: SemanticCaseExecutor = {
  prepareAndApplyUpdate: prepareAndApplyPublicRdfQueryUpdate,
  query: queryPublicRdfQueryEngine,
};

async function prepareAndApplyPublicRdfQueryUpdate(
  engine: RdfEngineLike,
  sparql: string,
  sourceUri: string,
  _timeoutMs: number | undefined,
): Promise<{ deletedRows: number; insertedRows: number }> {
  const adapter = new RdfSparqlAdapter();
  const delta: RdfSparqlUpdateDelta = adapter.compileUpdateDelta(sparql, DEFAULT_BASE_PATH, {
    defaultGraph: sourceUri,
  });
  const writeScope = writeAccessScope(sourceUri);
  const graphDeltas = new Map<string, { graphIri: string; sourceUri: string; deletes: Quad[]; inserts: Quad[] }>();
  const appendDeletes = (quads: Quad[]): void => {
    for (const quad of quads) {
      graphDeltaForPublicUpdate(graphDeltas, quad).deletes.push(quad);
    }
  };
  const appendInserts = (quads: Quad[]): void => {
    for (const quad of quads) {
      graphDeltaForPublicUpdate(graphDeltas, quad).inserts.push(quad);
    }
  };

  for (const operation of delta.operations) {
    if (operation.type === 'insert') {
      appendInserts(operation.quads ?? []);
    } else if (operation.type === 'delete') {
      appendDeletes(operation.quads ?? []);
    } else if (operation.type === 'insertDeleteWhere') {
      const result = await engine.query(applyRdfAccessScope(assertPublicUpdateQuery(operation.query), writeScope));
      appendDeletes(adapter.materializeDeleteWhere(operation.deletes, result.bindings));
      appendInserts(adapter.materializeDeleteWhere(operation.inserts, result.bindings));
    } else if (operation.type === 'insertWhere') {
      const result = await engine.query(applyRdfAccessScope(assertPublicUpdateQuery(operation.query), writeScope));
      appendInserts(adapter.materializeDeleteWhere(operation.inserts, result.bindings));
    } else {
      const result = await engine.query(applyRdfAccessScope(assertPublicUpdateQuery(operation.query), writeScope));
      appendDeletes(adapter.materializeDeleteWhere(operation.template, result.bindings));
    }
  }

  const summary = { deletedRows: 0, insertedRows: 0 };
  for (const graph of graphDeltas.values()) {
    const applied = await engine.applyDelta(
      graph.deletes.map(exactQuadPattern),
      graph.inserts,
      {
        source: {
          source: graph.sourceUri,
          workspace: 'semantic',
          localPath: `/semantic/${slug(graph.sourceUri)}`,
          contentType: 'text/turtle',
        },
      },
    );
    summary.deletedRows += applied.deletedRows;
    summary.insertedRows += applied.insertedRows;
  }
  await engine.refreshDerivedIndexes({ mode: 'full' });
  return summary;
}

function graphDeltaForPublicUpdate(
  deltas: Map<string, { graphIri: string; sourceUri: string; deletes: Quad[]; inserts: Quad[] }>,
  quad: Quad,
): { graphIri: string; sourceUri: string; deletes: Quad[]; inserts: Quad[] } {
  if (quad.graph.termType !== 'NamedNode') {
    throw new Error('Public semantic conformance updates must resolve to a named source graph');
  }
  const graphIri = quad.graph.value;
  let delta = deltas.get(graphIri);
  if (!delta) {
    delta = {
      graphIri,
      sourceUri: graphIri,
      deletes: [],
      inserts: [],
    };
    deltas.set(graphIri, delta);
  }
  return delta;
}

async function queryPublicRdfQueryEngine(
  engine: RdfEngineLike,
  testCase: SemanticFixtureCase,
  timeoutMs: number | undefined,
): Promise<RdfNativeSparqlResult> {
  const sparql = new RdfQuerySparqlEngine(engine);
  const adapter = new RdfSparqlAdapter();
  const compiled = adapter.compile(testCase.query, DEFAULT_BASE_PATH);
  const accessScope = makeAccessScope(testCase) as RdfAccessScope;
  if (testCase.acceptMediaType === 'application/n-triples') {
    const quads = await sparql.queryQuads(testCase.query, DEFAULT_BASE_PATH, accessScope, { timeoutMs });
    return {
      status: 'ok',
      mediaType: 'application/n-triples',
      body: await serializeQuads(quads),
      queryStatus: 0,
    };
  }
  if (compiled.queryType === 'ASK') {
    const result = await sparql.queryBoolean(testCase.query, DEFAULT_BASE_PATH, accessScope, { timeoutMs });
    return {
      status: 'ok',
      mediaType: 'application/sparql-results+json',
      body: JSON.stringify({ head: {}, boolean: result }),
      queryStatus: 0,
    };
  }
  const bindings = await sparql.queryBindings(testCase.query, DEFAULT_BASE_PATH, accessScope, { timeoutMs });
  const metadata = typeof bindings.metadata === 'function' ? await bindings.metadata() : undefined;
  const variables = metadata?.variables?.map((variable: { value: string }) => variable.value) ?? [];
  const rows: Record<string, Record<string, string>>[] = [];
  const seenVariables = new Set<string>();
  for await (const binding of bindings as AsyncIterable<Iterable<[Term | string, Term]>>) {
    const row: Record<string, Record<string, string>> = {};
    for (const [ variable, term ] of binding) {
      const name = typeof variable === 'string' ? variable : variable.value;
      row[name] = termToSparqlJson(term);
      seenVariables.add(name);
    }
    rows.push(row);
  }
  return {
    status: 'ok',
    mediaType: 'application/sparql-results+json',
    body: JSON.stringify({
      head: { vars: variables.length > 0 ? variables : [...seenVariables] },
      results: { bindings: rows },
    }),
    queryStatus: 0,
  };
}

function assertPublicUpdateQuery(query: Parameters<RdfEngineLike['query']>[0] | undefined): Parameters<RdfEngineLike['query']>[0] {
  if (!query) {
    throw new Error('Public semantic conformance update operation is missing its RDF query');
  }
  return query;
}

function writeAccessScope(sourceUri: string): RdfAccessScope {
  return {
    basePath: DEFAULT_BASE_PATH,
    mode: 'write',
    resolved: true,
    principal: 'urn:xpod:semantic-writer',
    version: `semantic-write-${sourceUri}`,
  };
}
