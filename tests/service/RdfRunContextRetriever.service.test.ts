import { DataFactory } from 'n3';
import { describe, expect, it, vi } from 'vitest';
import { RdfRunContextRetriever } from '../../src/api/runs/RdfRunContextRetriever';
import type { RunContextRetrievalInput } from '../../src/api/runs/RunExecutionBackend';
import type { RdfEngineLike, RdfQuery, RdfQueryResult } from '../../src/storage/rdf';

const { literal, namedNode } = DataFactory;

const input: RunContextRetrievalInput = {
  runId: 'chat/default/2026/06/09/runs.ttl#run_context',
  threadId: 'chat/default/index.ttl#thread_context',
  prompt: 'runtime approvals',
  conversation: [],
  config: {
    workspace: 'file://localhost/workspace',
    runner: { type: 'codex', protocol: 'acp' },
  },
  context: { userId: 'alice' },
};

function queryResult(bindings: RdfQueryResult['bindings'], plan: string[] = ['TextSearch(query:runtime approvals)']): RdfQueryResult {
  return {
    bindings,
    metrics: {
      engine: 'solid-rdf',
      plan,
      scannedRows: bindings.length,
      joinedRows: bindings.length,
      returnedRows: bindings.length,
      durationMs: 1,
      indexChoices: ['text-chunk'],
      filtersApplied: 0,
      filtersPushedDown: 0,
      planSize: plan.length,
    } as any,
  };
}

describe('RdfRunContextRetriever', () => {
  it('builds a workspace-scoped text query and maps bindings into Run context', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([
      {
        source: namedNode('file://localhost/workspace/notes.md'),
        workspace: namedNode('file://localhost/workspace'),
        localPath: literal('notes.md'),
        contentType: literal('text/markdown'),
        textChunk: namedNode('file://localhost/workspace/notes.md#chunk-1'),
        textContent: literal('Approve the runtime deployment before release.'),
        textHeading: literal('Release'),
        textScore: literal('0.92'),
      },
    ]));
    const retriever = new RdfRunContextRetriever({
      rdfEngine: { query: queryMock } as unknown as RdfEngineLike,
      limit: 5,
      sourcePrefix: 'file://localhost/workspace/',
      cacheScope: (current) => ({ principal: current.context.userId, basePath: current.config.workspace }),
    });

    const result = await retriever.retrieve(input);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const query = queryMock.mock.calls[0][0];
    expect(query.patterns).toEqual([]);
    expect(query.textSearch).toEqual([expect.objectContaining({
      query: 'runtime approvals',
      scope: {
        workspace: 'file://localhost/workspace',
        sourcePrefix: 'file://localhost/workspace/',
      },
      source: 'source',
      content: 'textContent',
      score: 'textScore',
    })]);
    expect(query.cache?.scope).toEqual({
      principal: 'alice',
      basePath: 'file://localhost/workspace',
    });
    expect(result).toMatchObject({
      query: 'runtime approvals',
      items: [
        {
          kind: 'text_chunk',
          source: 'file://localhost/workspace/notes.md',
          workspace: 'file://localhost/workspace',
          localPath: 'notes.md',
          heading: 'Release',
          score: 0.92,
          text: 'Approve the runtime deployment before release.',
        },
      ],
      plan: ['TextSearch(query:runtime approvals)'],
    });
  });

  it('projects text-search provenance into untrusted Agent context metadata', async () => {
    const provenance = [{
      entity: 'https://pod.example/alice/.data/tasks/default.ttl#task_1',
      predicate: 'https://schema.org/description',
      value: 'Approve the runtime deployment before release.',
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
      policyRole: 'searchableText',
      occurrences: 1,
    }];
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([
      {
        source: namedNode('https://pod.example/alice/.data/tasks/default.ttl'),
        workspace: namedNode('https://pod.example/alice/.data/'),
        localPath: literal('tasks/default.ttl'),
        contentType: literal('text/turtle'),
        textChunk: namedNode('https://pod.example/alice/.data/tasks/default.ttl#chunk-task_1'),
        textContent: literal('Approve the runtime deployment before release.'),
        textHeading: literal('Release task'),
        textScore: literal('0.92'),
        sourceKey: literal('source-node:tasks/default'),
        retrievalPointKey: literal('entity-card:https://pod.example/alice/.data/tasks/default.ttl#task_1'),
        retrievalKind: literal('entity-card'),
        entityProvenance: literal(JSON.stringify(provenance)),
      },
    ]));
    const retriever = new RdfRunContextRetriever({
      rdfEngine: { query: queryMock } as unknown as RdfEngineLike,
      limit: 5,
      sourcePrefix: 'https://pod.example/alice/.data/',
      accessScope: {
        basePath: 'https://pod.example/alice/.data/',
        mode: 'read',
        principal: 'https://id.example/alice/profile/card#me',
        version: 'acl-v2',
      },
    });

    const result = await retriever.retrieve({
      ...input,
      config: {
        ...input.config,
        workspace: 'https://pod.example/alice/.data/',
      },
    });

    const query = queryMock.mock.calls[0][0];
    expect(query.textSearch?.[0]).toEqual(expect.objectContaining({
      sourceKey: 'sourceKey',
      retrievalPoint: 'retrievalPointKey',
      retrievalKind: 'retrievalKind',
      entityProvenance: 'entityProvenance',
    }));
    expect(query.select).toEqual(expect.arrayContaining([
      'sourceKey',
      'retrievalPointKey',
      'retrievalKind',
      'entityProvenance',
    ]));
    expect(result?.items[0]).toMatchObject({
      kind: 'text_chunk',
      source: 'https://pod.example/alice/.data/tasks/default.ttl',
      text: 'Approve the runtime deployment before release.',
      metadata: {
        untrustedContext: true,
        sourceKey: 'source-node:tasks/default',
        retrievalPointKey: 'entity-card:https://pod.example/alice/.data/tasks/default.ttl#task_1',
        retrievalKind: 'entity-card',
        entityProvenance: provenance,
      },
    });
  });

  it('adds vector search and fusion scoring when an embedding is available', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([
      {
        source: namedNode('file://localhost/workspace/notes.md'),
        textContent: literal('Runtime approval note'),
        textScore: literal('0.9'),
        vectorContent: literal('Runtime approval vector note'),
        vectorScore: literal('0.8'),
        vectorDistance: literal('0.2'),
        vectorModel: literal('embed-test'),
        fusionScore: literal('0.855'),
      },
    ], [
      'TextSearch(query:runtime approvals)',
      'VectorSearch(model:embed-test)',
      'Bind(?fusionScore:=((NUM(?textScore)*0.55)+(NUM(?vectorScore)*0.45)))',
      'Sort(desc:fusionScore,asc:source)',
    ]));
    const retriever = new RdfRunContextRetriever({
      rdfEngine: { query: queryMock } as unknown as RdfEngineLike,
      embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: 'embed-test' }),
    });

    const result = await retriever.retrieve(input);
    const query = queryMock.mock.calls[0][0];

    expect(query.vectorSearch).toEqual([expect.objectContaining({
      embedding: [0.1, 0.2, 0.3],
      vectorModel: 'embed-test',
      source: 'source',
      score: 'vectorScore',
    })]);
    expect(query.binds?.[0].variable).toBe('fusionScore');
    expect(query.orderBy).toEqual([
      { variable: 'fusionScore', direction: 'desc' },
      { variable: 'source' },
    ]);
    expect(result?.items[0]).toMatchObject({
      source: 'file://localhost/workspace/notes.md',
      score: 0.855,
      metadata: {
        textScore: 0.9,
        vectorScore: 0.8,
        vectorDistance: 0.2,
        vectorModel: 'embed-test',
      },
    });
  });

  it('fails closed for remote Pod Run context search without an RDF access scope', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([]));
    const retriever = new RdfRunContextRetriever({
      rdfEngine: { query: queryMock } as unknown as RdfEngineLike,
    });

    await expect(retriever.retrieve({
      ...input,
      config: {
        ...input.config,
        workspace: 'https://pod.example/alice/.data/',
      },
    })).rejects.toThrow('RDF Run context retrieval requires an access scope for remote Pod workspaces');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('applies RDF access scope to product Run context search candidates', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([]));
    const publicSource = 'https://pod.example/alice/.data/public/notes.md';
    const accessScope = {
      basePath: 'https://pod.example/alice/.data/',
      mode: 'read' as const,
      principal: 'https://id.example/alice/profile/card#me',
      allowedGraphUrls: [publicSource],
      deniedGraphPrefixes: ['https://pod.example/alice/.data/private/'],
      version: 'acl-v2',
    };
    const retriever = new RdfRunContextRetriever({
      rdfEngine: { query: queryMock } as unknown as RdfEngineLike,
      sourcePrefix: 'https://pod.example/alice/.data/',
      accessScope,
    });

    await expect(retriever.retrieve({
      ...input,
      config: {
        ...input.config,
        workspace: 'https://pod.example/alice/.data/',
      },
    })).resolves.toBeUndefined();

    const query = queryMock.mock.calls[0][0];
    expect(query.textSearch?.[0].scope).toEqual(expect.objectContaining({
      workspace: 'https://pod.example/alice/.data/',
      sourcePrefix: 'https://pod.example/alice/.data/',
      allowedSources: [publicSource],
      deniedSourcePrefixes: ['https://pod.example/alice/.data/private/'],
    }));
    expect(query.cache?.scope).toEqual(expect.objectContaining({
      mode: 'read',
      principal: 'https://id.example/alice/profile/card#me',
      basePath: 'https://pod.example/alice/.data/',
      permissionVersion: 'acl-v2',
      allowedGraphUrls: [publicSource],
      deniedGraphPrefixes: ['https://pod.example/alice/.data/private/'],
    }));
  });

  it('fails closed for remote Pod Run context search when access scope lacks principal or permission version', async () => {
    const queryMock = vi.fn(async (_query: RdfQuery) => queryResult([]));
    const remoteInput = {
      ...input,
      config: {
        ...input.config,
        workspace: 'https://pod.example/alice/.data/',
      },
    };
    const retriever = new RdfRunContextRetriever({
      rdfEngine: { query: queryMock } as unknown as RdfEngineLike,
      accessScope: {
        basePath: 'https://pod.example/alice/.data/',
        mode: 'read',
      },
    });

    await expect(retriever.retrieve(remoteInput)).rejects.toThrow(
      'RDF Run context retrieval requires principal and permission version for remote Pod workspaces',
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('fails closed by default when the RDF context query is unavailable', async () => {
    const retriever = new RdfRunContextRetriever({
      rdfEngine: {
        query: vi.fn(async () => {
          throw new Error('RdfQuery textSearch requires a configured RdfTextIndex');
        }),
      } as unknown as RdfEngineLike,
    });

    await expect(retriever.retrieve(input)).rejects.toThrow('RdfQuery textSearch requires a configured RdfTextIndex');
  });

  it('can be configured to fail open for optional retrieval paths', async () => {
    const retriever = new RdfRunContextRetriever({
      rdfEngine: {
        query: vi.fn(async () => {
          throw new Error('optional context unavailable');
        }),
      } as unknown as RdfEngineLike,
      failOpen: true,
    });

    await expect(retriever.retrieve(input)).resolves.toBeUndefined();
  });
});
