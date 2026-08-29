import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';
import {
  createApiRdfEngine,
  createApiRdfSearchIndexingService,
  createApiRdfSearchPodEmbeddingConfigResolver,
  createApiRunContextRetriever,
} from '../../../src/api/container/rdf';
import { RdfRunContextRetriever } from '../../../src/api/runs/RdfRunContextRetriever';
import { RdfSearchIndexingService } from '../../../src/api/service/RdfSearchIndexingService';
import { RdfSearchReconciliationWorker } from '../../../src/api/service/RdfSearchReconciliationWorker';
import { RdfSearchPodEmbeddingConfigResolver } from '../../../src/search/RdfSearchPodEmbeddingConfigResolver';
import { RdfSearchReconciliationRepository } from '../../../src/search/RdfSearchReconciliationRepository';
import type { RunContextRetrievalInput } from '../../../src/api/runs/RunExecutionBackend';
import {
  LocalQleverNativeSparqlClient,
  PostgresRdfEngine,
  SolidRdfEngine,
  type RdfEngineLike,
  type RdfQuery,
  type RdfQueryResult,
} from '../../../src/storage/rdf';

const { literal, namedNode } = DataFactory;

function baseConfig(overrides: Partial<ApiContainerConfig> = {}): ApiContainerConfig {
  return {
    edition: 'cloud',
    port: 3001,
    host: '127.0.0.1',
    authMode: 'acp',
    databaseUrl: 'sqlite::memory:',
    corsOrigins: ['*'],
    cssTokenEndpoint: 'http://localhost/.oidc/token',
    ...overrides,
  };
}

function withoutLocalQleverRuntimeOverride<T>(run: () => T): T {
  const previous = process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
  delete process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND;
    } else {
      process.env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND = previous;
    }
  }
}

describe('API RDF container services', () => {
  it('wires one PG-backed Run context retriever into Chat, Task, and durable Run workers', async() => {
    const container = createApiContainer(baseConfig({
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));

    try {
      const retriever = container.resolve('runContextRetriever');
      const indexingService = container.resolve('rdfSearchIndexingService');
      const resolver = container.resolve('rdfSearchPodEmbeddingConfigResolver');
      const reconciliationRepository = container.resolve('rdfSearchReconciliationRepository');
      const reconciliationWorker = container.resolve('rdfSearchReconciliationWorker') as any;
      const rdfEngine = container.resolve('rdfEngine');
      expect(retriever).toBeInstanceOf(RdfRunContextRetriever);
      expect(indexingService).toBeInstanceOf(RdfSearchIndexingService);
      expect(resolver).toBeInstanceOf(RdfSearchPodEmbeddingConfigResolver);
      expect(reconciliationRepository).toBeInstanceOf(RdfSearchReconciliationRepository);
      expect(reconciliationWorker).toBeInstanceOf(RdfSearchReconciliationWorker);
      expect(reconciliationWorker.repository).toBe(reconciliationRepository);
      expect(reconciliationWorker.indexingService).toBe(indexingService);
      expect(reconciliationWorker.podConfigResolver).toBe(resolver);
      expect(reconciliationWorker.rdfEngine).toBe(rdfEngine);

      const backend = container.resolve('runExecutionBackend') as any;
      const chatKitService = container.resolve('chatKitService') as any;
      const taskService = container.resolve('taskService') as any;

      expect(backend.managedRunWorker.contextRetriever).toBe(retriever);
      expect(chatKitService.runStateCenter.contextRetriever).toBe(retriever);
      expect(taskService.materializer.contextRetriever).toBe(retriever);
      expect(backend.runtimeDriver.options.rdfSearchIndexingService).toBe(indexingService);
      expect(backend.runtimeDriver.options.rdfSearchReconciliationRepository).toBe(reconciliationRepository);
    } finally {
      await container.resolve('rdfEngine')?.close?.();
    }
  });

  it('uses Local SQLite regardless of a stale PostgreSQL endpoint and keeps Cloud on PostgreSQL', async () => {
    const localContainer = createApiContainer(baseConfig({
      edition: 'local',
      rdfIndexPath: ':memory:',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));
    const cloudContainer = createApiContainer(baseConfig({
      edition: 'cloud',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));
    try {
      expect(localContainer.resolve('rdfEngine')).toBeInstanceOf(SolidRdfEngine);
      expect(localContainer.resolve('runContextRetriever')).toBeInstanceOf(RdfRunContextRetriever);
      expect(localContainer.resolve('rdfSearchIndexingService')).toBeInstanceOf(RdfSearchIndexingService);
      expect(cloudContainer.resolve('rdfEngine')).toBeInstanceOf(PostgresRdfEngine);
      expect(cloudContainer.resolve('runContextRetriever')).toBeInstanceOf(RdfRunContextRetriever);
      expect(cloudContainer.resolve('rdfSearchIndexingService')).toBeInstanceOf(RdfSearchIndexingService);
    } finally {
      await localContainer.resolve('rdfEngine')?.close?.();
      await cloudContainer.resolve('rdfEngine')?.close?.();
    }
  });

  it('configures local SQLite RDF facts, FTS, VEC, and QLever from the canonical RDF index path', () => {
    const engine = withoutLocalQleverRuntimeOverride(() => createApiRdfEngine(baseConfig({
      edition: 'local',
      rdfIndexPath: ':memory:',
      sparqlEndpoint: 'sqlite:/must-not-be-used.sqlite',
    })));

    expect(engine).toBeInstanceOf(SolidRdfEngine);
    expect(engine?.sparqlQuery).toBeInstanceOf(Function);
    expect((engine as SolidRdfEngine).index).toBeDefined();
    expect((engine as SolidRdfEngine).textIndex).toBeDefined();
    expect((engine as SolidRdfEngine).vectorIndex).toBeDefined();

    const nativeClient = (engine as any).nativeSparqlClient;
    expect(nativeClient).toBeInstanceOf(LocalQleverNativeSparqlClient);
    expect((nativeClient as any).options).toEqual({
      command: '/opt/xpod/qlever/bin/xpod_qlever_local_runtime',
      args: [
        '--sqlite-path',
        ':memory:',
      ],
    });
  });

  it('does not expose the platform local QLever runtime command through API config', async () => {
    const engine = withoutLocalQleverRuntimeOverride(() => createApiRdfEngine(baseConfig({
      edition: 'local',
      rdfIndexPath: ':memory:',
    }))) as SolidRdfEngine;
    try {
      expect(((engine as any).nativeSparqlClient as any).options.command)
        .toBe('/opt/xpod/qlever/bin/xpod_qlever_local_runtime');
    } finally {
      await engine.close();
    }
  });

  it('uses the public PostgreSQL RDF engine for Cloud without native QLever', () => {
    const engine = createApiRdfEngine(baseConfig({
      edition: 'cloud',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));

    expect(engine).toBeInstanceOf(PostgresRdfEngine);
    expect(engine?.sparqlQuery).toBeUndefined();
    expect((engine as any).pgOptions.rdfAccelerationProfile).toBe('pg-hot-operators');
    expect((engine as any).pgOptions.nativeSparqlEnabled).toBeUndefined();
  });

  it('does not expose a native QLever feature toggle in the API config', async () => {
    const cloudEngine = createApiRdfEngine(baseConfig({
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    } as Partial<ApiContainerConfig> & { rdfNativeSparqlEnabled: false }));

    try {
      expect(cloudEngine?.sparqlQuery).toBeUndefined();
      expect((cloudEngine as any).pgOptions).not.toHaveProperty('nativeSparqlEnabled');
      expect((cloudEngine as any).pgOptions).not.toHaveProperty('nativeSparqlRequired');
    } finally {
      await cloudEngine?.close?.();
    }
  });

  it('creates the RDF vector indexing service at the same product boundary as Run retrieval', () => {
    const indexVectorSource = vi.fn();
    const service = createApiRdfSearchIndexingService(
      { indexVectorSource } as unknown as RdfEngineLike,
      {
        chatKitStore: { getAiConfig: vi.fn() },
        embeddingService: { embedBatch: vi.fn() },
      },
    );

    expect(service).toBeInstanceOf(RdfSearchIndexingService);
  });

  it('creates the Pod embedding config resolver from the same product RDF engine', () => {
    const rdfEngine = { sparqlQuery: vi.fn() } as unknown as RdfEngineLike;
    const resolver = createApiRdfSearchPodEmbeddingConfigResolver(rdfEngine);

    expect(resolver).toBeInstanceOf(RdfSearchPodEmbeddingConfigResolver);
    expect((resolver as any).sparqlEngine.rdfEngine).toBe(rdfEngine);
    expect(createApiRdfSearchPodEmbeddingConfigResolver(undefined)).toBeUndefined();
  });

  it('creates the Pod embedding config resolver for public Cloud engines without native QLever', () => {
    const rdfEngine = { query: vi.fn(), close: vi.fn() } as unknown as RdfEngineLike;
    const resolver = createApiRdfSearchPodEmbeddingConfigResolver(rdfEngine);

    expect(resolver).toBeInstanceOf(RdfSearchPodEmbeddingConfigResolver);
    expect((resolver as any).sparqlEngine.rdfEngine).toBe(rdfEngine);
  });

  it('adds vector retrieval to the product Run context path when Pod embedding config exists', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([
      {
        source: namedNode('file://localhost/workspace/notes.md'),
        textContent: literal('Runtime approvals'),
        textScore: literal('0.8'),
        vectorContent: literal('Runtime approval vector match'),
        vectorScore: literal('0.9'),
        fusionScore: literal('0.845'),
      },
    ]));
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const getAiConfig = vi.fn(async () => ({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      credentialId: 'cred-1',
      embeddingModel: 'text-embedding-3-small',
      embeddingModelVersion: '2026-08-13T08:00:00.000Z',
    }));
    const retriever = createApiRunContextRetriever(
      { query: queryMock } as unknown as RdfEngineLike,
      { chatKitStore: { getAiConfig }, embeddingService: { embed } },
    );

    const result = await retriever?.retrieve(runContextInput());
    const query = queryMock.mock.calls[0][0];

    expect(getAiConfig).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith('runtime approvals', {
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: undefined,
    }, 'text-embedding-3-small');
    expect(query.vectorSearch).toEqual([expect.objectContaining({
      embedding: [0.1, 0.2, 0.3],
      vectorProvider: 'openai',
      vectorModel: 'text-embedding-3-small',
      vectorModelVersion: '2026-08-13T08:00:00.000Z',
      vectorInputKind: 'semantic',
      vectorProjectionPolicyVersion: 'rdf-vector-projection-v1',
    })]);
    expect(result?.items[0]).toMatchObject({
      source: 'file://localhost/workspace/notes.md',
      score: 0.845,
      metadata: {
        textScore: 0.8,
        vectorScore: 0.9,
      },
    });
  });

  it('keeps the product Run context path text-only when Pod embedding config is absent', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([
      {
        source: namedNode('file://localhost/workspace/notes.md'),
        textContent: literal('Runtime approvals'),
        textScore: literal('0.8'),
      },
    ]));
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const getAiConfig = vi.fn(async () => ({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      credentialId: 'cred-1',
    }));
    const retriever = createApiRunContextRetriever(
      { query: queryMock } as unknown as RdfEngineLike,
      { chatKitStore: { getAiConfig }, embeddingService: { embed } },
    );

    await retriever?.retrieve(runContextInput());
    const query = queryMock.mock.calls[0][0];

    expect(getAiConfig).toHaveBeenCalledTimes(1);
    expect(embed).not.toHaveBeenCalled();
    expect(query.textSearch).toHaveLength(1);
    expect(query.vectorSearch).toBeUndefined();
  });

  it('uses a stable vector profile when the Pod model has no explicit version', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([]));
    const retriever = createApiRunContextRetriever(
      { query: queryMock } as unknown as RdfEngineLike,
      {
        chatKitStore: {
          getAiConfig: vi.fn(async () => ({
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test',
            credentialId: 'cred-1',
            embeddingModel: 'text-embedding-3-small',
          })),
        },
        embeddingService: { embed: vi.fn(async () => [0.1, 0.2]) },
      },
    );

    await retriever?.retrieve(runContextInput());

    expect(queryMock.mock.calls[0][0].vectorSearch).toEqual([
      expect.objectContaining({ vectorModelVersion: 'unversioned' }),
    ]);
  });

  it('passes request RDF access scope into product Run context retrieval', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([]));
    const retriever = createApiRunContextRetriever(
      { query: queryMock } as unknown as RdfEngineLike,
    );

    await retriever?.retrieve(runContextInput({
      workspace: 'https://pod.example/alice/.data/',
      rdfAccessScope: {
        basePath: 'https://pod.example/alice/.data/',
        mode: 'read',
        principal: 'https://id.example/alice/profile/card#me',
        allowedGraphUrls: ['https://pod.example/alice/.data/public/notes.md'],
        deniedGraphUrls: ['https://pod.example/alice/.data/private/secret.md'],
        version: 'acr-v4',
      },
    }));
    const query = queryMock.mock.calls[0][0];

    expect(query.textSearch?.[0].scope).toEqual(expect.objectContaining({
      workspace: 'https://pod.example/alice/.data/',
      sourcePrefix: 'https://pod.example/alice/.data/',
      allowedSources: ['https://pod.example/alice/.data/public/notes.md'],
      deniedSources: ['https://pod.example/alice/.data/private/secret.md'],
    }));
    expect(query.cache?.scope).toEqual(expect.objectContaining({
      principal: 'https://id.example/alice/profile/card#me',
      permissionVersion: 'acr-v4',
    }));
  });
});

function runContextInput(options: {
  workspace?: string;
  rdfAccessScope?: Record<string, unknown>;
} = {}): RunContextRetrievalInput {
  return {
    runId: 'chat/default/2026/06/09/runs.ttl#run_product_context',
    threadId: 'chat/default/index.ttl#thread_product_context',
    prompt: 'runtime approvals',
    conversation: [],
    config: {
      workspace: options.workspace ?? 'file://localhost/workspace',
      runner: { type: 'codex', protocol: 'acp' },
    },
    context: {
      userId: 'alice',
      ...(options.rdfAccessScope ? { rdfAccessScope: options.rdfAccessScope } : {}),
    },
  };
}

function queryResult(bindings: RdfQueryResult['bindings']): RdfQueryResult {
  return {
    bindings,
    metrics: {
      engine: 'postgres-rdf',
      plan: ['PostgresFactsScan', 'TextSearch(query:runtime approvals)'],
      scannedRows: bindings.length,
      joinedRows: bindings.length,
      returnedRows: bindings.length,
      durationMs: 1,
      indexChoices: [],
      filtersApplied: 0,
      filtersPushedDown: 0,
      planSize: 2,
    } as any,
  };
}
