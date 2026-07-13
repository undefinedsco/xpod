import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { createApiContainer, loadConfigFromEnv, type ApiContainerConfig } from '../../../src/api/container';
import { createApiRdfEngine, createApiRdfSearchIndexingService, createApiRunContextRetriever } from '../../../src/api/container/rdf';
import { RdfRunContextRetriever } from '../../../src/api/runs/RdfRunContextRetriever';
import { RdfSearchIndexingService } from '../../../src/api/service/RdfSearchIndexingService';
import type { RunContextRetrievalInput } from '../../../src/api/runs/RunExecutionBackend';
import type { RdfEngineLike, RdfQuery, RdfQueryResult } from '../../../src/storage/rdf';

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

describe('API RDF container services', () => {
  it('wires one PG-backed Run context retriever into Chat, Task, and durable Run workers', async() => {
    const container = createApiContainer(baseConfig({
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));

    try {
      const retriever = container.resolve('runContextRetriever');
      const indexingService = container.resolve('rdfSearchIndexingService');
      expect(retriever).toBeInstanceOf(RdfRunContextRetriever);
      expect(indexingService).toBeInstanceOf(RdfSearchIndexingService);

      const backend = container.resolve('runExecutionBackend') as any;
      const chatKitService = container.resolve('chatKitService') as any;
      const taskService = container.resolve('taskService') as any;

      expect(backend.managedRunWorker.contextRetriever).toBe(retriever);
      expect(chatKitService.runStateCenter.contextRetriever).toBe(retriever);
      expect(taskService.materializer.contextRetriever).toBe(retriever);
      expect(backend.runtimeDriver.options.rdfSearchIndexingService).toBe(indexingService);
    } finally {
      await container.resolve('rdfEngine')?.close?.();
    }
  });

  it('does not enable API RDF retrieval outside cloud PG facts storage', () => {
    const localContainer = createApiContainer(baseConfig({
      edition: 'local',
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));
    const sqliteContainer = createApiContainer(baseConfig({
      sparqlEndpoint: 'sqlite:/tmp/xpod-rdf.sqlite',
    }));

    expect(localContainer.resolve('rdfEngine')).toBeUndefined();
    expect(localContainer.resolve('runContextRetriever')).toBeUndefined();
    expect(localContainer.resolve('rdfSearchIndexingService')).toBeUndefined();
    expect(sqliteContainer.resolve('rdfEngine')).toBeUndefined();
    expect(sqliteContainer.resolve('runContextRetriever')).toBeUndefined();
    expect(sqliteContainer.resolve('rdfSearchIndexingService')).toBeUndefined();
  });

  it('keeps native SPARQL off by default and exposes it only for explicit provider config', async () => {
    const publicCloudEngine = createApiRdfEngine(baseConfig({
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
    }));
    const nativeEngine = createApiRdfEngine(baseConfig({
      sparqlEndpoint: 'postgres://user:pass@localhost:5432/xpod',
      rdfNativeSparqlEnabled: true,
    } as Partial<ApiContainerConfig> & { rdfNativeSparqlEnabled: true }));

    try {
      expect(publicCloudEngine?.sparqlQuery).toBeUndefined();
      expect(nativeEngine?.sparqlQuery).toBeInstanceOf(Function);
      expect((nativeEngine as any).pgOptions.rdfAccelerationProfile).toBe('pg-hot-operators');
    } finally {
      await publicCloudEngine?.close?.();
      await nativeEngine?.close?.();
    }
  });

  it('loads native SPARQL from the derived API child environment', () => {
    const previous = {
      XPOD_EDITION: process.env.XPOD_EDITION,
      CSS_IDENTITY_DB_URL: process.env.CSS_IDENTITY_DB_URL,
      CSS_SPARQL_ENDPOINT: process.env.CSS_SPARQL_ENDPOINT,
      XPOD_RDF_NATIVE_SPARQL_ENABLED: process.env.XPOD_RDF_NATIVE_SPARQL_ENABLED,
    };
    try {
      process.env.XPOD_EDITION = 'cloud';
      process.env.CSS_IDENTITY_DB_URL = 'sqlite::memory:';
      process.env.CSS_SPARQL_ENDPOINT = 'postgres://user:pass@localhost:5432/xpod';
      process.env.XPOD_RDF_NATIVE_SPARQL_ENABLED = 'true';

      expect(loadConfigFromEnv()).toMatchObject({
        edition: 'cloud',
        rdfNativeSparqlEnabled: true,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
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
      vectorModel: 'text-embedding-3-small',
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
