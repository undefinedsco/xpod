import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Literal, Quad, Term } from '@rdfjs/types';
import { DataFactory, Parser, termToId, Writer } from 'n3';
import type {
  RdfEngineLike,
  RdfNativeSparqlAccessScope,
  RdfNativeSparqlResult,
} from '../storage/rdf/types';

export const DEFAULT_BASE_PATH = 'urn:xpod:semantic:';

export interface SemanticFixtureCase {
  id: string;
  documents: readonly {
    sourceUri: string;
    graph?: 'source' | 'default';
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

export type PostgresPublicSemanticHarnessOptions = PostgresQleverSemanticHarnessOptions;

export interface SemanticConformanceReport {
  schemaVersion: 1;
  backend: 'sqlite' | 'pg';
  engine:
    | 'local-qlever-prepared-update-authority'
    | 'pg-qlever-prepared-update-authority'
    | 'pg-public-rdf-query-authority';
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

export interface SemanticFixtureModule {
  REQUIRED_CASES: readonly string[];
  semanticConformanceCases: readonly SemanticFixtureCase[];
}

export interface SemanticCaseExecutor {
  prepareAndApplyUpdate(
    engine: RdfEngineLike,
    sparql: string,
    sourceUri: string,
    timeoutMs: number | undefined,
  ): Promise<{ deletedRows: number; insertedRows: number }>;
  query(
    engine: RdfEngineLike,
    testCase: SemanticFixtureCase,
    timeoutMs: number | undefined,
  ): Promise<RdfNativeSparqlResult>;
}

export async function runCaseWithEngine(
  engine: RdfEngineLike,
  testCase: SemanticFixtureCase,
  timeoutMs: number | undefined,
  authority: string,
  seedDocuments = true,
  executor: SemanticCaseExecutor,
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
      const applied = await executor.prepareAndApplyUpdate(engine, update.sparql, update.sourceUri, timeoutMs);
      preparedUpdates += 1;
      appliedDelta.deletedRows += applied.deletedRows;
      appliedDelta.insertedRows += applied.insertedRows;
    }
    await engine.refreshDerivedIndexes({ mode: 'full' });

    const queryResult = await executor.query(engine, testCase, timeoutMs);
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

export async function seedDocument(
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
  const graph = document.graph === 'default'
    ? DataFactory.defaultGraph()
    : DataFactory.namedNode(document.sourceUri);
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

export function makeAccessScope(testCase: SemanticFixtureCase): RdfNativeSparqlAccessScope {
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

export function exactQuadPattern(quad: Quad) {
  return {
    graph: quad.graph,
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
  };
}

export function queryOperation(mediaType: string): 'queryBindings' | 'queryQuads' {
  return mediaType === 'application/n-triples' ? 'queryQuads' : 'queryBindings';
}

export function validateEnvelope(result: RdfNativeSparqlResult, context: string, mediaType: string): void {
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

export async function serializeQuads(quads: AsyncIterable<Quad>): Promise<string> {
  const writer = new Writer({ format: 'N-Triples' });
  for await (const quad of quads) {
    writer.addQuad(quad);
  }
  return new Promise((resolve, reject) => {
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export function termToSparqlJson(term: Term): Record<string, string> {
  switch (term.termType) {
    case 'NamedNode':
      return { type: 'uri', value: term.value };
    case 'BlankNode':
      return { type: 'bnode', value: term.value };
    case 'Literal': {
      const literal = term as Literal;
      if (literal.language) {
        return { type: 'literal', value: literal.value, 'xml:lang': literal.language };
      }
      const datatype = literal.datatype?.value;
      if (datatype && datatype !== 'http://www.w3.org/2001/XMLSchema#string') {
        return { type: 'literal', value: literal.value, datatype };
      }
      return { type: 'literal', value: literal.value };
    }
    default:
      return { type: 'literal', value: term.value };
  }
}

export function buildSemanticReport(options: {
  backend: SemanticConformanceReport['backend'];
  engine: SemanticConformanceReport['engine'];
  caseIds: readonly string[];
  failed: SemanticConformanceReport['failed'];
  results: SemanticConformanceReport['results'];
  sourceDeniedValidatedBy: string;
}): SemanticConformanceReport {
  const deniedRowsObserved = options.results.reduce(
    (total, result) => total + observedDeniedRows(result.canonical),
    0,
  );
  const report: SemanticConformanceReport = {
    schemaVersion: 1,
    backend: options.backend,
    engine: options.engine,
    status: options.failed.length === 0 && deniedRowsObserved === 0 ? 'ok' : 'failed',
    caseIds: [...options.caseIds],
    skipped: [],
    failed: options.failed,
    results: options.results,
    authorization: { deniedRowsObserved },
    sourceScope: {
      sourceDeniedValidatedBy: options.sourceDeniedValidatedBy,
    },
    canonicalDigest: '',
  };
  report.canonicalDigest = `sha256:${createHash('sha256').update(digestPayload(report)).digest('hex')}`;
  return report;
}

export function assertPath(name: string, value: string): void {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  if ((name === 'fixturePath' || name === 'runtimeCommand') && !existsSync(value)) {
    throw new Error(`${name} does not exist: ${value}`);
  }
}

export function connectionStringWithSearchPath(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  return url.toString();
}

export function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

export function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 80) || createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function quadIdentity(quad: Quad): string {
  return [quad.graph, quad.subject, quad.predicate, quad.object]
    .map((term: Term) => termToId(term as never))
    .join('\u001f');
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
