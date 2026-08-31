import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { LocalQleverNativeSparqlClient } from '../storage/rdf/LocalQleverNativeSparqlClient';
import { PostgresRdfEngine } from '../storage/rdf/PostgresRdfEngine';
import { SolidRdfEngine } from '../storage/rdf/SolidRdfEngine';
import type { RdfEngineLike, RdfNativeSparqlResult } from '../storage/rdf/types';
import {
  parsePreparedUpdateDelta,
  PREPARED_UPDATE_MEDIA_TYPE,
} from '../storage/accessors/SolidRdfDataAccessor';
import {
  DEFAULT_BASE_PATH,
  assertPath,
  buildSemanticReport,
  connectionStringWithSearchPath,
  exactQuadPattern,
  makeAccessScope,
  queryOperation,
  quoteIdentifier,
  runCaseWithEngine,
  seedDocument,
  slug,
  validateEnvelope,
  type LocalQleverSemanticHarnessOptions,
  type PostgresQleverSemanticHarnessOptions,
  type SemanticCaseExecutor,
  type SemanticConformanceReport,
  type SemanticFixtureCase,
  type SemanticFixtureModule,
} from './RdfSemanticConformance';

export async function runLocalQleverSemanticConformance(
  options: LocalQleverSemanticHarnessOptions,
): Promise<SemanticConformanceReport> {
  assertPath('fixturePath', options.fixturePath);
  assertPath('runtimeCommand', options.runtimeCommand);
  assertPath('artifactPath', options.artifactPath);

  const fixture = require(path.resolve(options.fixturePath)) as SemanticFixtureModule;
  const tempRoot = options.tempRoot ?? path.join(os.tmpdir(), `xpod-qlever-sqlite-semantic-${process.pid}-${randomUUID()}`);
  mkdirSync(tempRoot, { recursive: true });

  const results: SemanticConformanceReport['results'] = [];
  const failed: SemanticConformanceReport['failed'] = [];
  for (let index = 0; index < fixture.semanticConformanceCases.length; index += 1) {
    const testCase = fixture.semanticConformanceCases[index];
    const dbPath = path.join(tempRoot, `${String(index).padStart(2, '0')}-${slug(testCase.id)}.sqlite`);
    try {
      results.push(await runLocalCase(options, testCase, dbPath));
    } catch (error) {
      failed.push({
        caseId: testCase.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = buildSemanticReport({
    backend: 'sqlite',
    engine: 'local-qlever-prepared-update-authority',
    caseIds: fixture.REQUIRED_CASES,
    failed,
    results,
    sourceDeniedValidatedBy: 'allowedSourceUrls/deniedSourceUrls resolved by sqlite physical provider',
  });
  mkdirSync(path.dirname(options.artifactPath), { recursive: true });
  writeFileSync(options.artifactPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function runPostgresQleverSemanticConformance(
  options: PostgresQleverSemanticHarnessOptions,
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
      const schema = `xpod_semantic_${process.pid}_${index}_${randomUUID().replaceAll('-', '')}`;
      try {
        await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
        const connectionString = connectionStringWithSearchPath(options.connectionString, schema);
        const engine = new PostgresRdfEngine({
          driver: 'pg',
          connectionString,
          rdfAccelerationProfile: 'pg-hot-operators',
          nativeSparqlEnabled: true,
          maintenanceIntervalMs: 0,
        });
        results.push(await runCaseWithEngine(
          engine,
          testCase,
          options.timeoutMs,
          `postgres-schema:${schema}`,
          true,
          nativeSemanticCaseExecutor,
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
    engine: 'pg-qlever-prepared-update-authority',
    caseIds: fixture.REQUIRED_CASES,
    failed,
    results,
    sourceDeniedValidatedBy: 'allowedSourceUrls/deniedSourceUrls resolved by PG physical provider',
  });
  mkdirSync(path.dirname(options.artifactPath), { recursive: true });
  writeFileSync(options.artifactPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runLocalCase(
  options: LocalQleverSemanticHarnessOptions,
  testCase: SemanticFixtureCase,
  dbPath: string,
): Promise<SemanticConformanceReport['results'][number]> {
  rmSync(dbPath, { force: true });
  const seedEngine = new SolidRdfEngine({ index: { path: dbPath } });
  await seedEngine.open();
  try {
    for (const document of testCase.documents) {
      await seedDocument(seedEngine, document);
    }
  } finally {
    await seedEngine.close();
  }

  const client = new LocalQleverNativeSparqlClient({
    command: options.runtimeCommand,
    args: ['--sqlite-path', dbPath],
    cwd: options.runtimeCwd,
    startupTimeoutMs: options.timeoutMs,
    requestTimeoutMs: options.timeoutMs,
  });
  const engine = new SolidRdfEngine({
    index: { path: dbPath },
    nativeSparqlClient: client,
  });
  return await runCaseWithEngine(
    engine,
    testCase,
    options.timeoutMs,
    `sqlite:${dbPath}`,
    false,
    nativeSemanticCaseExecutor,
  );
}

async function prepareAndApplyUpdate(
  engine: RdfEngineLike,
  sparql: string,
  sourceUri: string,
  timeoutMs: number | undefined,
): Promise<{ deletedRows: number; insertedRows: number }> {
  const result = await nativeSparqlQuery(engine, sparql, {
    basePath: DEFAULT_BASE_PATH,
    sourceUri,
    operation: 'prepareUpdate',
    acceptMediaType: PREPARED_UPDATE_MEDIA_TYPE,
    timeoutMs,
    accessScope: {
      basePath: DEFAULT_BASE_PATH,
      mode: 'write',
      resolved: true,
      principal: 'urn:xpod:semantic-writer',
      version: `semantic-write-${sourceUri}`,
    },
  });
  validateEnvelope(result, 'prepareUpdate', PREPARED_UPDATE_MEDIA_TYPE);
  const delta = parsePreparedUpdateDelta(result.body);
  const summary = { deletedRows: 0, insertedRows: 0 };
  for (const graph of delta.graphs) {
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

const nativeSemanticCaseExecutor: SemanticCaseExecutor = {
  prepareAndApplyUpdate,
  query: (engine, testCase, timeoutMs) => nativeSparqlQuery(engine, testCase.query, {
    basePath: DEFAULT_BASE_PATH,
    operation: queryOperation(testCase.acceptMediaType),
    acceptMediaType: testCase.acceptMediaType,
    timeoutMs,
    accessScope: makeAccessScope(testCase),
  }),
};

function nativeSparqlQuery(
  engine: RdfEngineLike,
  query: string,
  options: Parameters<NonNullable<RdfEngineLike['sparqlQuery']>>[1],
): Promise<RdfNativeSparqlResult> {
  if (!engine.sparqlQuery) {
    throw new Error('QLever semantic conformance requires native SPARQL');
  }
  return Promise.resolve(engine.sparqlQuery(query, options));
}
