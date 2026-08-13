import { describe, expect, it, vi } from 'vitest';
import { RdfSearchPodEmbeddingConfigResolver } from '../../src/search/RdfSearchPodEmbeddingConfigResolver';
import type {
  RdfEngineLike,
  RdfNativeSparqlQueryOptions,
  RdfNativeSparqlResult,
} from '../../src/storage/rdf';

const POD_ROOT = 'https://pod.example/alice/';
const AI_CONFIG_GRAPH = `${POD_ROOT}settings/ai/config.ttl`;
const CREDENTIALS_GRAPH = `${POD_ROOT}settings/credentials.ttl`;
const PROVIDER_GRAPH = `${POD_ROOT}settings/providers/cloudflare.ttl`;
const PROVIDER = PROVIDER_GRAPH;
const MODEL = `${PROVIDER_GRAPH}#bge-small`;

function selectResult(bindings: Array<Record<string, { type: 'uri' | 'literal'; value: string }>>): RdfNativeSparqlResult {
  return {
    status: 'ok',
    mediaType: 'application/sparql-results+json',
    body: JSON.stringify({
      head: { vars: Array.from(new Set(bindings.flatMap((row) => Object.keys(row)))) },
      results: { bindings },
    }),
  };
}

function fakeResolver(results: RdfNativeSparqlResult[]): {
  resolver: RdfSearchPodEmbeddingConfigResolver;
  sparqlQuery: ReturnType<typeof vi.fn<[
    query: string,
    options: RdfNativeSparqlQueryOptions,
  ], Promise<RdfNativeSparqlResult>>>;
} {
  const sparqlQuery = vi.fn(async (_query: string, _options: RdfNativeSparqlQueryOptions) => {
    const result = results.shift();
    if (!result) {
      throw new Error('Unexpected SPARQL query');
    }
    return result;
  });
  const rdfEngine = {
    sparqlQuery,
    close: vi.fn(),
  } as unknown as RdfEngineLike;
  return {
    resolver: new RdfSearchPodEmbeddingConfigResolver({ rdfEngine }),
    sparqlQuery,
  };
}

describe('RdfSearchPodEmbeddingConfigResolver', () => {
  it('reads embedding config through exact QLever-scoped Pod graphs', async () => {
    const { resolver, sparqlQuery } = fakeResolver([
      selectResult([ {
        config: { type: 'uri', value: `${AI_CONFIG_GRAPH}#config` },
        embeddingModel: { type: 'uri', value: MODEL },
      } ]),
      selectResult([ {
        provider: { type: 'uri', value: PROVIDER },
        modelType: { type: 'literal', value: 'embedding' },
        modelUpdatedAt: { type: 'literal', value: '2026-08-13T08:00:00.000Z' },
        baseUrl: { type: 'literal', value: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1' },
        proxyUrl: { type: 'literal', value: 'http://127.0.0.1:7890' },
        defaultModel: { type: 'uri', value: `${PROVIDER_GRAPH}#gpt-4o-mini` },
      } ]),
      selectResult([ {
        credential: { type: 'uri', value: `${CREDENTIALS_GRAPH}#secondary` },
        apiKey: { type: 'literal', value: 'sk-secondary' },
        isDefault: { type: 'literal', value: 'false' },
        lastUsedAt: { type: 'literal', value: '2026-05-17T00:00:00.000Z' },
        failCount: { type: 'literal', value: '0' },
      }, {
        credential: { type: 'uri', value: `${CREDENTIALS_GRAPH}#primary` },
        apiKey: { type: 'literal', value: 'sk-primary' },
        baseUrl: { type: 'literal', value: 'https://credential.example/v1' },
        isDefault: { type: 'literal', value: 'true' },
        lastUsedAt: { type: 'literal', value: '2026-05-18T00:00:00.000Z' },
        failCount: { type: 'literal', value: '9' },
      } ]),
    ]);

    await expect(resolver.getAiConfig(POD_ROOT)).resolves.toEqual({
      providerId: 'cloudflare',
      baseUrl: 'https://credential.example/v1',
      proxyUrl: 'http://127.0.0.1:7890',
      defaultModel: 'gpt-4o-mini',
      embeddingModel: 'bge-small',
      embeddingModelVersion: '2026-08-13T08:00:00.000Z',
      apiKey: 'sk-primary',
      credentialId: `${CREDENTIALS_GRAPH}#primary`,
    });

    expect(sparqlQuery).toHaveBeenCalledTimes(3);
    expect(sparqlQuery.mock.calls.map(([, options]) => options.accessScope)).toEqual([
      {
        basePath: POD_ROOT,
        mode: 'read',
        allowedGraphUrls: [ AI_CONFIG_GRAPH ],
        allowedSourceUrls: [ AI_CONFIG_GRAPH ],
      },
      {
        basePath: POD_ROOT,
        mode: 'read',
        allowedGraphUrls: [ PROVIDER_GRAPH ],
        allowedSourceUrls: [ PROVIDER_GRAPH ],
      },
      {
        basePath: POD_ROOT,
        mode: 'read',
        allowedGraphUrls: [ CREDENTIALS_GRAPH ],
        allowedSourceUrls: [ CREDENTIALS_GRAPH ],
      },
    ]);
    for (const [ query ] of sparqlQuery.mock.calls) {
      expect(query).not.toContain('sk-primary');
      expect(query).not.toContain('sk-secondary');
    }
    expect(sparqlQuery.mock.calls[0][0]).toContain(`<${AI_CONFIG_GRAPH}#config>`);
  });

  it('ignores a non-singleton AIConfig subject even inside the exact config graph', async () => {
    const { resolver, sparqlQuery } = fakeResolver([
      selectResult([ {
        config: { type: 'uri', value: `${AI_CONFIG_GRAPH}#other` },
        embeddingModel: { type: 'uri', value: MODEL },
      } ]),
    ]);

    await expect(resolver.getAiConfig(POD_ROOT)).resolves.toBeUndefined();
    expect(sparqlQuery).toHaveBeenCalledTimes(1);
    expect(sparqlQuery.mock.calls[0][0]).toContain(`BIND(<${AI_CONFIG_GRAPH}#config> AS ?config)`);
  });

  it('ignores cross-Pod provider and credential subjects', async () => {
    const { resolver, sparqlQuery } = fakeResolver([
      selectResult([ {
        config: { type: 'uri', value: `${AI_CONFIG_GRAPH}#config` },
        embeddingModel: { type: 'uri', value: 'https://evil.example/settings/providers/cloudflare.ttl#bge-small' },
      } ]),
    ]);

    await expect(resolver.getAiConfig(POD_ROOT)).resolves.toBeUndefined();
    expect(sparqlQuery).toHaveBeenCalledTimes(1);
  });

  it('requires an embedding model and exact provider graph ownership', async () => {
    const { resolver } = fakeResolver([
      selectResult([ {
        config: { type: 'uri', value: `${AI_CONFIG_GRAPH}#config` },
        embeddingModel: { type: 'uri', value: MODEL },
      } ]),
      selectResult([ {
        provider: { type: 'uri', value: `${POD_ROOT}settings/other/cloudflare.ttl#cloudflare` },
        modelType: { type: 'literal', value: 'chat' },
      } ]),
    ]);

    await expect(resolver.getAiConfig(POD_ROOT)).resolves.toBeUndefined();
  });

  it('uses deterministic credential ordering when no candidate is default', async () => {
    const { resolver } = fakeResolver([
      selectResult([ {
        config: { type: 'uri', value: `${AI_CONFIG_GRAPH}#config` },
        embeddingModel: { type: 'uri', value: MODEL },
      } ]),
      selectResult([ {
        provider: { type: 'uri', value: PROVIDER },
        modelType: { type: 'literal', value: 'embedding' },
        baseUrl: { type: 'literal', value: 'https://provider.example/v1' },
      } ]),
      selectResult([ {
        credential: { type: 'uri', value: `${CREDENTIALS_GRAPH}#later` },
        apiKey: { type: 'literal', value: 'sk-later' },
        isDefault: { type: 'literal', value: 'false' },
        lastUsedAt: { type: 'literal', value: '2026-05-18T00:00:00.000Z' },
        failCount: { type: 'literal', value: '0' },
      }, {
        credential: { type: 'uri', value: `${CREDENTIALS_GRAPH}#earlier` },
        apiKey: { type: 'literal', value: 'sk-earlier' },
        isDefault: { type: 'literal', value: 'false' },
        lastUsedAt: { type: 'literal', value: '2026-05-17T00:00:00.000Z' },
        failCount: { type: 'literal', value: '99' },
      } ]),
    ]);

    await expect(resolver.getAiConfig(POD_ROOT)).resolves.toMatchObject({
      apiKey: 'sk-earlier',
      credentialId: `${CREDENTIALS_GRAPH}#earlier`,
    });
  });

  it('uses shared credential selection semantics for default credentials', async () => {
    const { resolver } = fakeResolver([
      selectResult([ {
        config: { type: 'uri', value: `${AI_CONFIG_GRAPH}#config` },
        embeddingModel: { type: 'uri', value: MODEL },
      } ]),
      selectResult([ {
        provider: { type: 'uri', value: PROVIDER },
        modelType: { type: 'literal', value: 'embedding' },
        baseUrl: { type: 'literal', value: 'https://provider.example/v1' },
      } ]),
      selectResult([ {
        credential: { type: 'uri', value: `${CREDENTIALS_GRAPH}#newer-default` },
        apiKey: { type: 'literal', value: 'sk-newer-default' },
        isDefault: { type: 'literal', value: 'true' },
        lastUsedAt: { type: 'literal', value: '2026-05-18T00:00:00.000Z' },
        failCount: { type: 'literal', value: '0' },
      }, {
        credential: { type: 'uri', value: `${CREDENTIALS_GRAPH}#older-default` },
        apiKey: { type: 'literal', value: 'sk-older-default' },
        isDefault: { type: 'literal', value: 'true' },
        lastUsedAt: { type: 'literal', value: '2026-05-17T00:00:00.000Z' },
        failCount: { type: 'literal', value: '99' },
      } ]),
    ]);

    await expect(resolver.getAiConfig(POD_ROOT)).resolves.toMatchObject({
      apiKey: 'sk-older-default',
      credentialId: `${CREDENTIALS_GRAPH}#older-default`,
    });
  });

  it('propagates QLever errors without fallback', async () => {
    const { resolver } = fakeResolver([ {
      status: 'error',
      mediaType: 'application/json',
      body: '',
      error: 'qlever unavailable',
    } ]);

    await expect(resolver.getAiConfig(POD_ROOT)).rejects.toMatchObject({
      name: 'NativeSparqlExecutionError',
    });
  });
});
