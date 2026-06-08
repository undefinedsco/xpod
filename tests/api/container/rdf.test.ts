import { describe, expect, it } from 'vitest';
import { createApiContainer, type ApiContainerConfig } from '../../../src/api/container';
import { RdfRunContextRetriever } from '../../../src/api/runs/RdfRunContextRetriever';

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
      expect(retriever).toBeInstanceOf(RdfRunContextRetriever);

      const backend = container.resolve('runExecutionBackend') as any;
      const chatKitService = container.resolve('chatKitService') as any;
      const taskService = container.resolve('taskService') as any;

      expect(backend.managedRunWorker.contextRetriever).toBe(retriever);
      expect(chatKitService.runStateCenter.contextRetriever).toBe(retriever);
      expect(taskService.materializer.contextRetriever).toBe(retriever);
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
    expect(sqliteContainer.resolve('rdfEngine')).toBeUndefined();
    expect(sqliteContainer.resolve('runContextRetriever')).toBeUndefined();
  });
});
