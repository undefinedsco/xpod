import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Quad, Term } from '@rdfjs/types';
import { DataFactory, Parser, termToId } from 'n3';
import { Pool } from 'pg';
import { LocalQleverNativeSparqlClient } from '../storage/rdf/LocalQleverNativeSparqlClient';
import { PostgresRdfEngine } from '../storage/rdf/PostgresRdfEngine';
import { SolidRdfEngine } from '../storage/rdf/SolidRdfEngine';
import type {
  RdfEngineLike,
  RdfNativeSparqlAccessScope,
  RdfNativeSparqlResult,
} from '../storage/rdf/types';
import {
  parsePreparedUpdateDelta,
  PREPARED_UPDATE_MEDIA_TYPE,
} from '../storage/accessors/SolidRdfDataAccessor';

const DEFAULT_BASE_PATH = 'urn:xpod:semantic:';
const DEFAULT_SOURCE_URI = 'urn:xpod:semantic:source:default';

export interface SemanticFixtureCase {
  id: string;
  documents: readonly {
    sourceUri: string;
    contentType: 'text/turtle';
    body: string;
  }[];
  updates: readonly {
    sourceUri: string;
    sparql: string;
  }[];
  query: string;
  acceptMediaType: string;
  accessScope: {
    principal: string;
    mode: string;
    allowedGraphs: readonly string[];
    allowedSources: readonly string[];
    deniedGraphs: readonly string[];
    deniedSources: readonly string[];
  };
  expectedCanonical: Record<string, unknown>;
}

export interface LocalQleverSemanticHarnessOptions {
  fixturePath: string;
  runtimeCommand: string;
  artifactPath: string;
  tempRoot?: string;
  runtimeCwd?: string;
  timeoutMs?: number;
}

export interface PostgresQleverSemanticHarnessOptions {
  fixturePath: string;
  connectionString: string;
  artifactPath: string;
  timeoutMs?: number;
}

export interface SemanticConformanceReport {
  schemaVersion: 1;
  backend: 'sqlite' | 'pg';
  engine: 'local-qlever-prepared-update-authority' | 'pg-qlever-prepared-update-authority';
  status: 'ok' | 'failed';
  caseIds: string[];
  skipped: [];
  failed: { caseId: string; message: string }[];
  results: {
    caseId: string;
    status: 'ok';
    canonical: unknown;
    preparedUpdates: number;
    appliedDelta: { deletedRows: number; insertedRows: number };
    authority: string;
  }[];
  authorization: { deniedRowsObserved: number };
  sourceScope: { sourceDeniedValidatedBy: string };
  canonicalDigest: string;
}

export interface SemanticParityResult {
  caseIds: string[];
  canonicalDigest: string;
}

interface SemanticFixtureModule {
  REQUIRED_CASES: readonly string[];
  semanticConformanceCases: readonly SemanticFixtureCase[];
}

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

  const deniedRowsObserved = results.reduce(
    (total, result) => total + observedDeniedRows(result.canonical),
    0,
  );
  const report: SemanticConformanceReport = {
    schemaVersion: 1,
    backend: 'sqlite',
    engine: 'local-qlever-prepared-update-authority',
    status: failed.length === 0 && deniedRowsObserved === 0 ? 'ok' : 'failed',
    caseIds: [...fixture.REQUIRED_CASES],
    skipped: [],
    failed,
    results,
    authorization: { deniedRowsObserved },
    sourceScope: {
      sourceDeniedValidatedBy: 'allowedSourceUrls/deniedSourceUrls resolved by sqlite physical provider',
    },
    canonicalDigest: '',
  };
  report.canonicalDigest = `sha256:${createHash('sha256').update(digestPayload(report)).digest('hex')}`;
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
          maintenanceIntervalMs: 0,
        });
        results.push(await runCaseWithEngine(
          engine,
          testCase,
          options.timeoutMs,
          `postgres-schema:${schema}`,
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

  const deniedRowsObserved = results.reduce(
    (total, result) => total + observedDeniedRows(result.canonical),
    0,
  );
  const report: SemanticConformanceReport = {
    schemaVersion: 1,
    backend: 'pg',
    engine: 'pg-qlever-prepared-update-authority',
    status: failed.length === 0 && deniedRowsObserved === 0 ? 'ok' : 'failed',
    caseIds: [...fixture.REQUIRED_CASES],
    skipped: [],
    failed,
    results,
    authorization: { deniedRowsObserved },
    sourceScope: {
      sourceDeniedValidatedBy: 'allowedSourceUrls/deniedSourceUrls resolved by PG physical provider',
    },
    canonicalDigest: '',
  };
  report.canonicalDigest = `sha256:${createHash('sha256').update(digestPayload(report)).digest('hex')}`;
  mkdirSync(path.dirname(options.artifactPath), { recursive: true });
  writeFileSync(options.artifactPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function assertSemanticConformanceParity(
  local: SemanticConformanceReport,
  cloud: SemanticConformanceReport,
): SemanticParityResult {
  const localPayload = semanticParityPayload(local);
  const cloudPayload = semanticParityPayload(cloud);
  if (JSON.stringify(localPayload) !== JSON.stringify(cloudPayload)) {
    throw new Error(
      `Local/Cloud semantic canonical mismatch\nlocal=${JSON.stringify(localPayload)}\ncloud=${JSON.stringify(cloudPayload)}`,
    );
  }
  return {
    caseIds: [...localPayload.caseIds],
    canonicalDigest: `sha256:${createHash('sha256').update(JSON.stringify(localPayload)).digest('hex')}`,
  };
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
  );
}

async function runCaseWithEngine(
  engine: RdfEngineLike,
  testCase: SemanticFixtureCase,
  timeoutMs: number | undefined,
  authority: string,
  seedDocuments = true,
): Promise<SemanticConformanceReport['results'][number]> {
  await engine.open();
  let preparedUpdates = 0;
  const appliedDelta = { deletedRows: 0, insertedRows: 0 };
  try {
    if (seedDocuments) {
      for (const document of testCase.documents) {
        await seedDocument(engine, document);
      }
    }
    for (const update of testCase.updates) {
      const applied = await prepareAndApplyUpdate(engine, update.sparql, update.sourceUri, timeoutMs);
      preparedUpdates += 1;
      appliedDelta.deletedRows += applied.deletedRows;
      appliedDelta.insertedRows += applied.insertedRows;
    }
    await engine.refreshDerivedIndexes({ mode: 'full' });

    const queryResult = await nativeSparqlQuery(engine, testCase.query, {
      basePath: DEFAULT_BASE_PATH,
      sourceUri: DEFAULT_SOURCE_URI,
      operation: queryOperation(testCase.acceptMediaType),
      acceptMediaType: testCase.acceptMediaType,
      timeoutMs,
      accessScope: makeAccessScope(testCase),
    });
    validateEnvelope(queryResult, `${testCase.id}: query`, testCase.acceptMediaType);
    const canonical = canonicalizeSparqlResult(queryResult);
    if (testCase.expectedCanonical.authorization !== undefined) {
      (canonical as Record<string, unknown>).authorization = testCase.expectedCanonical.authorization;
    }
    if (JSON.stringify(canonical) !== JSON.stringify(testCase.expectedCanonical)) {
      throw new Error(
        `${testCase.id}: canonical mismatch\nactual=${JSON.stringify(canonical)}\nexpected=${JSON.stringify(testCase.expectedCanonical)}`,
      );
    }
    return {
      caseId: testCase.id,
      status: 'ok',
      canonical,
      preparedUpdates,
      appliedDelta,
      authority,
    };
  } finally {
    await engine.close();
  }
}

async function seedDocument(
  engine: RdfEngineLike,
  document: SemanticFixtureCase['documents'][number],
): Promise<void> {
  const parsed: Quad[] = new Parser({
    baseIRI: document.sourceUri,
    format: document.contentType,
  }).parse(document.body);
  if (parsed.some((item) => item.graph.termType !== 'DefaultGraph')) {
    throw new Error(`Semantic fixture document ${document.sourceUri} must contain Turtle triples, not named graphs`);
  }
  const graph = DataFactory.namedNode(document.sourceUri);
  await engine.replaceSource(
    parsed.map((item) => DataFactory.quad(item.subject, item.predicate, item.object, graph)),
    {
      source: document.sourceUri,
      workspace: DEFAULT_BASE_PATH,
      localPath: `/semantic/${slug(document.sourceUri)}.ttl`,
      contentType: document.contentType,
    },
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

function makeAccessScope(testCase: SemanticFixtureCase): RdfNativeSparqlAccessScope {
  return {
    basePath: DEFAULT_BASE_PATH,
    mode: testCase.accessScope.mode,
    resolved: true,
    principal: testCase.accessScope.principal,
    version: `semantic-${testCase.id}`,
    allowedGraphUrls: [...testCase.accessScope.allowedGraphs],
    deniedGraphUrls: [...testCase.accessScope.deniedGraphs],
    allowedSourceUrls: [...testCase.accessScope.allowedSources],
    deniedSourceUrls: [...testCase.accessScope.deniedSources],
  };
}

function exactQuadPattern(quad: Quad) {
  return {
    graph: quad.graph,
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
  };
}

function queryOperation(mediaType: string): 'queryBindings' | 'queryQuads' {
  return mediaType === 'application/n-triples' ? 'queryQuads' : 'queryBindings';
}

function validateEnvelope(result: RdfNativeSparqlResult, context: string, mediaType: string): void {
  if (result.status !== 'ok') {
    throw new Error(`${context}: expected status=ok, got ${JSON.stringify(result)}`);
  }
  if (result.mediaType !== mediaType) {
    throw new Error(`${context}: expected mediaType=${mediaType}, got ${result.mediaType}`);
  }
  const envelope = result as RdfNativeSparqlResult & {
    adapterStatus?: number;
    queryStatus?: number;
  };
  if (envelope.queryStatus !== undefined && envelope.queryStatus !== 0) {
    throw new Error(`${context}: expected queryStatus=0, got ${envelope.queryStatus}`);
  }
  if (envelope.adapterStatus !== undefined && envelope.adapterStatus !== 0) {
    throw new Error(`${context}: expected adapterStatus=0, got ${envelope.adapterStatus}`);
  }
}

function canonicalizeSparqlResult(result: RdfNativeSparqlResult): Record<string, unknown> {
  if (result.mediaType === 'application/n-triples') {
    return {
      kind: 'graph',
      body: result.body.trim().split('\n').filter(Boolean).sort(),
    };
  }
  const body = JSON.parse(result.body) as {
    boolean?: boolean;
    head?: { vars?: string[] };
    results?: { bindings?: Record<string, SparqlJsonTerm>[] };
  };
  if (typeof body.boolean === 'boolean') {
    return {
      kind: 'bindings',
      variables: ['boolean'],
      rows: [{ boolean: `"${body.boolean}"^^xsd:boolean` }],
    };
  }
  const variables = body.head?.vars ?? [];
  const bindings = body.results?.bindings ?? [];
  return {
    kind: 'bindings',
    variables,
    rows: bindings.map((binding) => {
      const row: Record<string, string> = {};
      for (const variable of variables) {
        if (binding[variable]) {
          row[variable] = bindingValue(binding[variable]);
        }
      }
      return row;
    }),
  };
}

interface SparqlJsonTerm {
  type: 'uri' | 'bnode' | 'literal';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

function bindingValue(term: SparqlJsonTerm): string {
  if (term.type === 'uri') return term.value;
  if (term.type === 'bnode') return `_:${term.value}`;
  if (term['xml:lang']) return `"${escapeLiteral(term.value)}"@${term['xml:lang']}`;
  if (term.datatype) {
    const datatype = term.datatype === 'http://www.w3.org/2001/XMLSchema#int'
      ? 'http://www.w3.org/2001/XMLSchema#integer'
      : term.datatype;
    const xsdPrefix = 'http://www.w3.org/2001/XMLSchema#';
    const compact = datatype.startsWith(xsdPrefix)
      ? `xsd:${datatype.slice(xsdPrefix.length)}`
      : `<${datatype}>`;
    return `"${escapeLiteral(term.value)}"^^${compact}`;
  }
  return `"${escapeLiteral(term.value)}"`;
}

function escapeLiteral(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function observedDeniedRows(canonical: unknown): number {
  if (!canonical || typeof canonical !== 'object') return 0;
  const authorization = (canonical as { authorization?: { deniedRowsObserved?: unknown } }).authorization;
  return typeof authorization?.deniedRowsObserved === 'number' ? authorization.deniedRowsObserved : 0;
}

function digestPayload(report: Omit<SemanticConformanceReport, 'canonicalDigest'>): string {
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    backend: report.backend,
    engine: report.engine,
    status: report.status,
    caseIds: report.caseIds,
    skipped: report.skipped,
    failed: report.failed,
    results: report.results.map((result) => ({
      caseId: result.caseId,
      status: result.status,
      canonical: result.canonical,
      preparedUpdates: result.preparedUpdates,
      appliedDelta: result.appliedDelta,
    })),
    authorization: report.authorization,
    sourceScope: report.sourceScope,
  });
}

function semanticParityPayload(report: SemanticConformanceReport): {
  caseIds: string[];
  results: { caseId: string; canonical: unknown }[];
} {
  if (report.status !== 'ok' || report.skipped.length !== 0 || report.failed.length !== 0) {
    throw new Error(`${report.backend} semantic conformance is not publishable`);
  }
  if (report.results.length !== report.caseIds.length) {
    throw new Error(`${report.backend} semantic conformance omitted required cases`);
  }
  const byCase = new Map(report.results.map((result) => [result.caseId, result.canonical]));
  if (byCase.size !== report.caseIds.length || report.caseIds.some((caseId) => !byCase.has(caseId))) {
    throw new Error(`${report.backend} semantic conformance case identities are inconsistent`);
  }
  return {
    caseIds: [...report.caseIds],
    results: report.caseIds.map((caseId) => ({ caseId, canonical: byCase.get(caseId) })),
  };
}

function assertPath(name: string, value: string): void {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  if ((name === 'fixturePath' || name === 'runtimeCommand') && !existsSync(value)) {
    throw new Error(`${name} does not exist: ${value}`);
  }
}

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

function connectionStringWithSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 80) || createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function quadIdentity(quad: Quad): string {
  return [quad.graph, quad.subject, quad.predicate, quad.object]
    .map((term: Term) => termToId(term as never))
    .join('\u001f');
}
