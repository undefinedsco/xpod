import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DataFactory } from 'n3';
import { Pool } from 'pg';
import { LocalQleverNativeSparqlClient } from '../storage/rdf/LocalQleverNativeSparqlClient';
import { PostgresRdfEngine } from '../storage/rdf/PostgresRdfEngine';
import { SolidRdfEngine } from '../storage/rdf/SolidRdfEngine';
import { variable as rdfVar } from '../storage/rdf/RdfQueryExecutor';
import type {
  RdfBindingRow,
  RdfEngineLike,
  RdfNativeSparqlQueryOptions,
  RdfNativeSparqlResult,
  RdfQuery,
} from '../storage/rdf/types';

const { namedNode, quad } = DataFactory;

export const QLEVER_ACCEPTANCE_GATE_ENV = 'XPOD_QLEVER_ACCEPTANCE_GATE';

export function qleverAcceptanceGateEnabled(): boolean {
  return process.env[QLEVER_ACCEPTANCE_GATE_ENV] === '1';
}

export function requireAcceptanceEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when ${QLEVER_ACCEPTANCE_GATE_ENV}=1`);
  }
  return value;
}

export function createAcceptanceTempDir(name: string): string {
  const dir = join(process.cwd(), '.test-data', `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SearchCanonicalRow {
  source: string;
  sourceKey: string;
  retrievalPointKey: string;
  textSnippet: string;
  vectorSnippet: string;
}

export async function runLocalSearchFusionAcceptance(
  engine = new SolidRdfEngine({
    index: { path: ':memory:' },
    textIndex: { path: ':memory:' },
    vectorIndex: { path: ':memory:' },
    autoOpen: true,
  }),
): Promise<SearchCanonicalRow[]> {
  const oldSource = namedNode('https://pod.example/alice/projects/demo/old-card.md');
  const movedSource = namedNode('https://pod.example/alice/projects/demo/moved-card.md');
  const deniedSource = namedNode('https://pod.example/alice/projects/demo/private-card.md');
  const docType = namedNode('https://schema.org/DigitalDocument');
  const stableSourceKey = 'entity:card:fusion-stable';
  const stablePointKey = 'point:intro';

  try {
    engine.put([
      quad(movedSource, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), docType, movedSource),
      quad(deniedSource, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), docType, deniedSource),
    ]);

    engine.indexTextSource({
      sourceKey: stableSourceKey,
      source: oldSource.value,
      workspace: 'https://pod.example/alice/projects/demo/',
      localPath: 'old-card.md',
      contentType: 'text/markdown',
      sourceHash: 'sha256:stable-card',
    }, 'alpha late vector canonical card', [
      {
        chunkKey: stablePointKey,
        retrievalPointKey: stablePointKey,
        retrievalKind: 'file-chunk',
        ordinal: 0,
        level: 1,
        content: 'alpha late vector canonical card',
        startOffset: 0,
        endOffset: 32,
      },
    ]);

    const beforeVector = engine.query({
      patterns: [],
      textSearch: [{
        query: 'alpha late',
        scope: { workspace: 'https://pod.example/alice/projects/demo/' },
        source: 'source',
        sourceKey: 'sourceKey',
        retrievalPoint: 'retrievalPointKey',
        content: 'textSnippet',
      }],
      vectorSearch: [{
        embedding: [1, 0],
        vectorModel: 'acceptance-embed',
        scope: { workspace: 'https://pod.example/alice/projects/demo/' },
        source: 'vectorSource',
        sourceKey: 'sourceKey',
        retrievalPoint: 'retrievalPointKey',
        content: 'vectorSnippet',
      }],
      select: ['sourceKey', 'retrievalPointKey'],
    });
    if (beforeVector.bindings.length !== 0) {
      throw new Error(`late vector invariant failed: expected no fused bindings before vector indexing, got ${beforeVector.bindings.length}`);
    }

    engine.indexVectorSource({
      sourceKey: stableSourceKey,
      source: oldSource.value,
      workspace: 'https://pod.example/alice/projects/demo/',
      localPath: 'old-card.md',
      contentType: 'text/markdown',
      sourceHash: 'sha256:stable-card',
    }, [{
      chunkKey: stablePointKey,
      ordinal: 0,
      level: 1,
      content: 'alpha late vector canonical card',
      startOffset: 0,
      endOffset: 32,
      embedding: [1, 0],
      model: 'acceptance-embed',
    }]);
    engine.indexTextSource({
      sourceKey: 'entity:card:denied',
      source: deniedSource.value,
      workspace: 'https://pod.example/alice/projects/demo/',
      localPath: 'private-card.md',
      contentType: 'text/markdown',
    }, 'alpha late vector canonical card', [{
      chunkKey: 'point:denied',
      retrievalPointKey: 'point:denied',
      retrievalKind: 'file-chunk',
      ordinal: 0,
      level: 1,
      content: 'alpha late vector canonical card',
      startOffset: 0,
      endOffset: 32,
    }]);
    engine.indexVectorSource({
      sourceKey: 'entity:card:denied',
      source: deniedSource.value,
      workspace: 'https://pod.example/alice/projects/demo/',
      localPath: 'private-card.md',
      contentType: 'text/markdown',
    }, [{
      chunkKey: 'point:denied',
      ordinal: 0,
      level: 1,
      content: 'alpha late vector canonical card',
      startOffset: 0,
      endOffset: 32,
      embedding: [1, 0],
      model: 'acceptance-embed',
    }]);

    engine.moveTextSource(oldSource.value, {
      source: movedSource.value,
      workspace: 'https://pod.example/alice/projects/demo/',
      localPath: 'moved-card.md',
      contentType: 'text/markdown',
    });
    engine.moveVectorSource(oldSource.value, {
      source: movedSource.value,
      workspace: 'https://pod.example/alice/projects/demo/',
      localPath: 'moved-card.md',
      contentType: 'text/markdown',
    });

    const result = engine.query({
      textSearch: [{
        query: 'alpha late',
        scope: {
          workspace: 'https://pod.example/alice/projects/demo/',
          deniedSources: [deniedSource.value],
        },
        source: 'source',
        sourceKey: 'sourceKey',
        retrievalPoint: 'retrievalPointKey',
        content: 'textSnippet',
      }],
      vectorSearch: [{
        embedding: [1, 0],
        vectorModel: 'acceptance-embed',
        scope: {
          workspace: 'https://pod.example/alice/projects/demo/',
          deniedSources: [deniedSource.value],
        },
        source: 'vectorSource',
        sourceKey: 'sourceKey',
        retrievalPoint: 'retrievalPointKey',
        content: 'vectorSnippet',
      }],
      patterns: [{
        graph: rdfVar('source'),
        subject: rdfVar('source'),
        predicate: namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        object: docType,
      }],
      select: ['source', 'sourceKey', 'retrievalPointKey', 'textSnippet', 'vectorSnippet'],
      orderBy: [{ variable: 'source' }],
    });

    return result.bindings.map((binding) => ({
      source: binding.source.value,
      sourceKey: binding.sourceKey.value,
      retrievalPointKey: binding.retrievalPointKey.value,
      textSnippet: binding.textSnippet.value,
      vectorSnippet: binding.vectorSnippet.value,
    }));
  } finally {
    await engine.close();
  }
}

export interface NativeSearchConformanceOptions {
  workspace?: string;
}

export interface NativeSearchConformanceReport {
  textOnlyBeforeVector: NativeSearchRow[];
  fusedBeforeVector: NativeSearchRow[];
  fusedAfterVector: NativeSearchRow[];
  fusedAfterVectorExact: NativeSearchRow[];
  fusedDuringMove: NativeSearchRow[];
  fusedDuringMoveExact: NativeSearchRow[];
  fusedAfterMove: NativeSearchRow[];
  oldSourceAfterMove: NativeSearchRow[];
  deniedSource: NativeSearchRow[];
}

export interface NativeSearchRow {
  retrieval: string;
  source?: string;
}

interface SearchConformanceFixture {
  workspace: string;
  oldSource: string;
  movedSource: string;
  decoySource: string;
  deniedSource: string;
  stableSourceKey: string;
  stablePointKey: string;
  decoySourceKey: string;
  deniedSourceKey: string;
  deniedPointKey: string;
  content: string;
  decoyContent: string;
  deniedContent: string;
  graphPredicate: ReturnType<typeof namedNode>;
  graphObject: ReturnType<typeof namedNode>;
}

export function createLocalNativeSearchEngine(runtimeCommand: string, databasePath: string): SolidRdfEngine {
  return new SolidRdfEngine({
    index: { path: databasePath },
    textIndex: { path: databasePath },
    vectorIndex: { path: databasePath },
    nativeSparqlClient: new LocalQleverNativeSparqlClient({
      command: runtimeCommand,
      args: ['--sqlite-path', databasePath],
    }),
  });
}

export function createPostgresSearchEngine(
  connectionString: string,
  nativeSparqlEnabled: boolean,
): PostgresRdfEngine {
  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString,
    nativeSparqlEnabled,
    rdfAccelerationProfile: 'pg-hot-operators',
    maintenanceIntervalMs: 0,
    textIndex: { driver: 'pg', connectionString },
    vectorIndex: { driver: 'pg', connectionString },
  });
}

export async function runPostgresNativeSearchFusionAcceptance(
  connectionString: string,
): Promise<NativeSearchConformanceReport> {
  const schema = `xpod_search_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    return await runNativeSearchFusionAcceptance(
      createPostgresSearchEngine(connectionStringWithSearchPath(connectionString, schema), true),
    );
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

export async function runPostgresPublicSearchFusionAcceptance(
  connectionString: string,
): Promise<NativeSearchConformanceReport> {
  const schema = `xpod_search_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    return await runPublicSearchFusionAcceptance(
      createPostgresSearchEngine(connectionStringWithSearchPath(connectionString, schema), false),
    );
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

export async function runNativeSearchFusionAcceptance(
  engine: RdfEngineLike,
  options: NativeSearchConformanceOptions = {},
): Promise<NativeSearchConformanceReport> {
  const fixture = searchConformanceFixture(options);
  const {
    workspace,
    oldSource,
    movedSource,
    deniedSource,
    stableSourceKey,
    stablePointKey,
    content,
  } = fixture;

  await engine.open();
  try {
    await seedSearchConformanceBase(engine, fixture);

    const textOnlyBeforeVector = await nativeBindings(engine, nativeTextOnlyQuery(), {
      basePath: workspace,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace),
    });
    const fusedBeforeVector = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace),
      vectorQuery: vectorQuery(),
    });

    await requireIndexVector(engine, {
      ...sourceInput(oldSource, workspace, 'old-card.md'),
      sourceKey: stableSourceKey,
    }, content, stablePointKey);
    const fusedAfterVector = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace, [deniedSource]),
      vectorQuery: vectorQuery(),
    });
    const fusedAfterVectorExact = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      sourceUri: oldSource,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace, [deniedSource]),
      vectorQuery: vectorQuery(),
    });

    if (!engine.moveSource || !engine.moveTextSource || !engine.moveVectorSource) {
      throw new Error('QLever search conformance requires source, FTS, and VEC move operations');
    }
    await engine.moveSource(oldSource, sourceInput(movedSource, workspace, 'moved-card.md'));
    await engine.moveTextSource(oldSource, sourceInput(movedSource, workspace, 'moved-card.md'));
    const fusedDuringMove = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace, [deniedSource]),
      vectorQuery: vectorQuery(),
    });
    const fusedDuringMoveExact = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      sourceUri: movedSource,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace, [deniedSource]),
      vectorQuery: vectorQuery(),
    });
    await engine.moveVectorSource(oldSource, sourceInput(movedSource, workspace, 'moved-card.md'));

    const oldSourceAfterMove = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      sourceUri: oldSource,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace),
      vectorQuery: vectorQuery(),
    });
    const fusedAfterMove = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      sourceUri: movedSource,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: resolvedReadScope(workspace),
      vectorQuery: vectorQuery(),
    });
    await seedDeniedSearchConformanceSource(engine, fixture);
    const denied = resolvedReadScope(workspace, [deniedSource]);
    const deniedSourceResult = await nativeBindings(engine, nativeFusedQuery(), {
      basePath: workspace,
      sourceUri: deniedSource,
      operation: 'queryBindings',
      acceptMediaType: 'application/sparql-results+json',
      accessScope: denied,
      vectorQuery: vectorQuery(),
    });

    const report = {
      textOnlyBeforeVector,
      fusedBeforeVector,
      fusedAfterVector,
      fusedAfterVectorExact,
      fusedDuringMove,
      fusedDuringMoveExact,
      fusedAfterMove,
      oldSourceAfterMove,
      deniedSource: deniedSourceResult,
    };
    assertNativeSearchInvariants(report, { content, oldSource, movedSource });
    return report;
  } finally {
    await engine.close();
  }
}

export async function runPublicSearchFusionAcceptance(
  engine: RdfEngineLike,
  options: NativeSearchConformanceOptions = {},
): Promise<NativeSearchConformanceReport> {
  const fixture = searchConformanceFixture(options);
  const {
    workspace,
    oldSource,
    movedSource,
    deniedSource,
    stableSourceKey,
    stablePointKey,
    content,
  } = fixture;

  await engine.open();
  try {
    await seedSearchConformanceBase(engine, fixture);

    const textOnlyBeforeVector = await publicBindings(engine, publicTextOnlyQuery(workspace));
    const fusedBeforeVector = await publicBindings(engine, publicFusedQuery(workspace));

    await requireIndexVector(engine, {
      ...sourceInput(oldSource, workspace, 'old-card.md'),
      sourceKey: stableSourceKey,
    }, content, stablePointKey);
    const fusedAfterVector = await publicBindings(engine, publicFusedQuery(workspace, {
      deniedSources: [deniedSource],
    }));
    const fusedAfterVectorExact = await publicBindings(engine, publicFusedQuery(workspace, {
      sourceUri: oldSource,
      deniedSources: [deniedSource],
    }));

    if (!engine.moveSource || !engine.moveTextSource || !engine.moveVectorSource) {
      throw new Error('Public search conformance requires source, FTS, and VEC move operations');
    }
    await engine.moveSource(oldSource, sourceInput(movedSource, workspace, 'moved-card.md'));
    await engine.moveTextSource(oldSource, sourceInput(movedSource, workspace, 'moved-card.md'));
    const fusedDuringMove = await publicBindings(engine, publicFusedQuery(workspace, {
      deniedSources: [deniedSource],
    }));
    const fusedDuringMoveExact = await publicBindings(engine, publicFusedQuery(workspace, {
      sourceUri: movedSource,
      deniedSources: [deniedSource],
    }));
    await engine.moveVectorSource(oldSource, sourceInput(movedSource, workspace, 'moved-card.md'));

    const oldSourceAfterMove = await publicBindings(engine, publicFusedQuery(workspace, {
      sourceUri: oldSource,
    }));
    const fusedAfterMove = await publicBindings(engine, publicFusedQuery(workspace, {
      sourceUri: movedSource,
    }));
    await seedDeniedSearchConformanceSource(engine, fixture);
    const deniedSourceResult = await publicBindings(engine, publicFusedQuery(workspace, {
      sourceUri: deniedSource,
      deniedSources: [deniedSource],
    }));

    const report = {
      textOnlyBeforeVector,
      fusedBeforeVector,
      fusedAfterVector,
      fusedAfterVectorExact,
      fusedDuringMove,
      fusedDuringMoveExact,
      fusedAfterMove,
      oldSourceAfterMove,
      deniedSource: deniedSourceResult,
    };
    assertNativeSearchInvariants(report, { content, oldSource, movedSource });
    return report;
  } finally {
    await engine.close();
  }
}

function searchConformanceFixture(options: NativeSearchConformanceOptions = {}): SearchConformanceFixture {
  const workspace = options.workspace ?? 'https://pod.example/alice/projects/native/';
  return {
    workspace,
    oldSource: `${workspace}old-card.md`,
    movedSource: `${workspace}moved-card.md`,
    decoySource: `${workspace}decoy-card.md`,
    deniedSource: `${workspace}private-card.md`,
    stableSourceKey: 'entity:card:fusion-stable',
    stablePointKey: 'point:intro',
    decoySourceKey: 'entity:card:fusion-decoy',
    deniedSourceKey: 'entity:card:denied',
    deniedPointKey: 'point:denied',
    content: 'alpha late vector canonical card',
    decoyContent: 'beta same-point different-source decoy card',
    deniedContent: 'alpha late vector denied private card',
    graphPredicate: namedNode('urn:xpod:qlever:search:predicate'),
    graphObject: namedNode('urn:xpod:qlever:search:object'),
  };
}

async function seedSearchConformanceBase(engine: RdfEngineLike, fixture: SearchConformanceFixture): Promise<void> {
  await engine.put(quad(namedNode(fixture.oldSource), fixture.graphPredicate, fixture.graphObject, namedNode(fixture.oldSource)), {
    source: sourceInput(fixture.oldSource, fixture.workspace, 'old-card.md'),
  });
  await engine.put(quad(namedNode(fixture.decoySource), fixture.graphPredicate, fixture.graphObject, namedNode(fixture.decoySource)), {
    source: sourceInput(fixture.decoySource, fixture.workspace, 'decoy-card.md'),
  });
  await requireIndexText(engine, {
    ...sourceInput(fixture.oldSource, fixture.workspace, 'old-card.md'),
    sourceKey: fixture.stableSourceKey,
  }, fixture.content, fixture.stablePointKey);
  await requireIndexText(engine, {
    ...sourceInput(fixture.decoySource, fixture.workspace, 'decoy-card.md'),
    sourceKey: fixture.decoySourceKey,
  }, fixture.decoyContent, fixture.stablePointKey);
  await requireIndexVector(engine, {
    ...sourceInput(fixture.decoySource, fixture.workspace, 'decoy-card.md'),
    sourceKey: fixture.decoySourceKey,
  }, fixture.decoyContent, fixture.stablePointKey);
}

async function seedDeniedSearchConformanceSource(engine: RdfEngineLike, fixture: SearchConformanceFixture): Promise<void> {
  await engine.put(quad(namedNode(fixture.deniedSource), fixture.graphPredicate, fixture.graphObject, namedNode(fixture.deniedSource)), {
    source: sourceInput(fixture.deniedSource, fixture.workspace, 'private-card.md'),
  });
  await requireIndexText(engine, {
    ...sourceInput(fixture.deniedSource, fixture.workspace, 'private-card.md'),
    sourceKey: fixture.deniedSourceKey,
  }, fixture.deniedContent, fixture.deniedPointKey);
  await requireIndexVector(engine, {
    ...sourceInput(fixture.deniedSource, fixture.workspace, 'private-card.md'),
    sourceKey: fixture.deniedSourceKey,
  }, fixture.deniedContent, fixture.deniedPointKey);
}

function sourceInput(source: string, workspace: string, localPath: string) {
  return {
    source,
    workspace,
    localPath,
    contentType: 'text/markdown',
    sourceHash: 'sha256:stable-card',
  };
}

function textChunk(content: string, retrievalPointKey: string) {
  return {
    chunkKey: retrievalPointKey,
    retrievalPointKey,
    retrievalKind: 'file-chunk' as const,
    ordinal: 0,
    level: 1,
    content,
    startOffset: 0,
    endOffset: content.length,
  };
}

async function requireIndexText(
  engine: RdfEngineLike,
  source: Parameters<NonNullable<RdfEngineLike['indexTextSource']>>[0],
  content: string,
  retrievalPointKey: string,
): Promise<void> {
  if (!engine.indexTextSource) throw new Error('Search conformance requires FTS indexing');
  await engine.indexTextSource(source, content, [textChunk(content, retrievalPointKey)]);
}

async function requireIndexVector(
  engine: RdfEngineLike,
  source: Parameters<NonNullable<RdfEngineLike['indexVectorSource']>>[0],
  content: string,
  retrievalPointKey: string,
): Promise<void> {
  if (!engine.indexVectorSource) throw new Error('Search conformance requires VEC indexing');
  await engine.indexVectorSource(source, [{
    chunkKey: retrievalPointKey,
    ordinal: 0,
    level: 1,
    content,
    startOffset: 0,
    endOffset: content.length,
    embedding: [1, 0],
    provider: 'xpod',
    model: 'acceptance-embed',
    modelVersion: '2026-08-13',
    inputKind: 'entity-card',
    inputHash: 'sha256:stable-card',
    projectionPolicyVersion: 'policy-v1',
  }]);
}

function nativeTextOnlyQuery(): string {
  return [
    'SELECT ?retrieval WHERE {',
    '  ?retrieval ql:contains-word "alpha" .',
    '} ORDER BY ?retrieval',
  ].join('\n');
}

function nativeFusedQuery(): string {
  return [
    'SELECT ?retrieval ?source WHERE {',
    '  ?retrieval ql:contains-word "alpha" .',
    '} ORDER BY ?source ?retrieval',
  ].join('\n');
}

function vectorQuery(): NonNullable<RdfNativeSparqlQueryOptions['vectorQuery']> {
  return {
    embedding: [1, 0],
    metric: 'cosine',
    provider: 'xpod',
    model: 'acceptance-embed',
    modelVersion: '2026-08-13',
    inputKind: 'entity-card',
    projectionPolicyVersion: 'policy-v1',
    limit: 10,
    retrievalPointVariable: '?retrieval',
    resourceVariable: '?source',
  };
}

function publicTextOnlyQuery(workspace: string): RdfQuery {
  return {
    patterns: [],
    textSearch: [{
      query: 'alpha',
      scope: { workspace },
      content: 'retrieval',
      sourceKey: 'sourceKey',
      retrievalPoint: 'retrievalPointKey',
    }],
    select: ['retrieval'],
    orderBy: [{ variable: 'retrieval' }],
  };
}

function publicFusedQuery(
  workspace: string,
  options: {
    sourceUri?: string;
    deniedSources?: string[];
  } = {},
): RdfQuery {
  const textScope = {
    workspace,
    ...(options.sourceUri ? { allowedSources: [options.sourceUri] } : {}),
    ...(options.deniedSources ? { deniedSources: options.deniedSources } : {}),
  };
  const vectorScope = {
    workspace,
    ...(options.deniedSources ? { deniedSources: options.deniedSources } : {}),
  };
  return {
    patterns: [],
    textSearch: [{
      query: 'alpha',
      scope: textScope,
      source: 'source',
      sourceKey: 'sourceKey',
      retrievalPoint: 'retrievalPointKey',
      content: 'retrieval',
    }],
    vectorSearch: [{
      embedding: [1, 0],
      metric: 'cosine',
      vectorProvider: 'xpod',
      vectorModel: 'acceptance-embed',
      vectorModelVersion: '2026-08-13',
      vectorInputKind: 'entity-card',
      vectorProjectionPolicyVersion: 'policy-v1',
      scope: vectorScope,
      source: 'vectorSource',
      sourceKey: 'sourceKey',
      retrievalPoint: 'retrievalPointKey',
      content: 'vectorRetrieval',
    }],
    select: ['retrieval', 'source'],
    orderBy: [
      { variable: 'source' },
      { variable: 'retrieval' },
    ],
  };
}

function resolvedReadScope(basePath: string, deniedSourceUrls: string[] = []) {
  return {
    basePath,
    mode: 'read' as const,
    resolved: true,
    principal: 'urn:xpod:qlever-search-reader',
    version: 'qlever-search-v1',
    deniedSourceUrls,
  };
}

async function nativeBindings(
  engine: RdfEngineLike,
  sparql: string,
  options: RdfNativeSparqlQueryOptions,
): Promise<NativeSearchRow[]> {
  if (!engine.sparqlQuery) throw new Error('QLever search conformance requires native SPARQL');
  const result = await engine.sparqlQuery(sparql, options);
  validateNativeResult(result);
  const parsed = JSON.parse(result.body) as {
    results?: { bindings?: Record<string, { value?: string }>[] };
  };
  return (parsed.results?.bindings ?? [])
    .map((binding) => ({
      retrieval: binding.retrieval?.value ?? '',
      source: binding.source?.value,
    }))
    .filter((row) => row.retrieval)
    .sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
}

async function publicBindings(engine: RdfEngineLike, query: RdfQuery): Promise<NativeSearchRow[]> {
  const result = await engine.query(query);
  return result.bindings
    .map(publicRow)
    .filter((row) => row.retrieval)
    .sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
}

function publicRow(binding: RdfBindingRow): NativeSearchRow {
  return {
    retrieval: binding.retrieval?.value ?? '',
    source: binding.source?.value,
  };
}

function validateNativeResult(result: RdfNativeSparqlResult): void {
  if (result.status !== 'ok' || result.mediaType !== 'application/sparql-results+json') {
    throw new Error(`QLever search query failed: ${JSON.stringify(result)}`);
  }
}

function assertNativeSearchInvariants(
  report: NativeSearchConformanceReport,
  expected: { content: string; oldSource: string; movedSource: string },
): void {
  if (
    report.textOnlyBeforeVector.length !== 1 ||
    report.textOnlyBeforeVector[0].retrieval !== expected.content ||
    report.textOnlyBeforeVector[0].source !== undefined
  ) {
    throw new Error(`FTS must remain available before any matching vector row exists: ${JSON.stringify(report.textOnlyBeforeVector)}`);
  }
  if (report.fusedBeforeVector.length !== 0) {
    throw new Error(`FTS/VEC fusion must stay empty before the matching late vector; same-point decoys are not enough: ${JSON.stringify(report.fusedBeforeVector)}`);
  }
  assertExactStableRows(report.fusedAfterVector, expected.content, expected.oldSource, 'Late vector fusion mismatch');
  assertExactStableRows(report.fusedAfterVectorExact, expected.content, expected.oldSource, 'Late vector exact-source fusion mismatch');
  assertExactStableRows(report.fusedDuringMove, expected.content, expected.movedSource, 'Stable-key fusion failed while FTS/VEC locators differed');
  assertExactStableRows(report.fusedDuringMoveExact, expected.content, expected.movedSource, 'Moved exact-source scope failed while the vector locator was stale');
  assertExactStableRows(report.fusedAfterMove, expected.content, expected.movedSource, 'Move-stable fusion mismatch');
  if (report.oldSourceAfterMove.length !== 0) {
    throw new Error(`Old source returned after move: ${JSON.stringify(report.oldSourceAfterMove)}`);
  }
  if (report.deniedSource.length !== 0) {
    throw new Error(`Denied source leaked from native search: ${JSON.stringify(report.deniedSource)}`);
  }
}

function assertExactStableRows(
  rows: NativeSearchRow[],
  content: string,
  source: string,
  message: string,
): void {
  const expected: NativeSearchRow = {
    retrieval: content,
    source,
  };
  if (
    rows.length !== 1 ||
    rows[0].retrieval !== expected.retrieval ||
    rows[0].source !== expected.source
  ) {
    throw new Error(`${message}: ${JSON.stringify(rows)}`);
  }
}

function rowKey(row: NativeSearchRow): string {
  return [row.source ?? '', row.retrieval].join('\u001f');
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
