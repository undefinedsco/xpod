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
