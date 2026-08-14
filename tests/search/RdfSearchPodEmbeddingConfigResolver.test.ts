import { describe, expect, it, vi } from 'vitest';
import { DataFactory } from 'n3';
import { RdfSearchPodEmbeddingConfigResolver } from '../../src/search/RdfSearchPodEmbeddingConfigResolver';
import { SolidRdfEngine } from '../../src/storage/rdf/SolidRdfEngine';
import type {
  RdfEngineLike,
  RdfNativeSparqlQueryOptions,
  RdfNativeSparqlResult,
} from '../../src/storage/rdf';

const { namedNode, literal, quad } = DataFactory;

const POD_ROOT = 'https://pod.example/alice/';
const AI_CONFIG_GRAPH = `${POD_ROOT}settings/ai/config.ttl`;
const CREDENTIALS_GRAPH = `${POD_ROOT}settings/credentials.ttl`;
const PROVIDER_GRAPH = `${POD_ROOT}settings/providers/cloudflare.ttl`;
const PROVIDER = PROVIDER_GRAPH;
const MODEL = `${PROVIDER_GRAPH}#bge-small`;
const UDFS = 'https://undefineds.co/ns#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

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

  it('reads embedding config through exact public Cloud RDF query graphs', async () => {
    const rdfEngine = new SolidRdfEngine({ index: { path: ':memory:' } });
    await rdfEngine.open();
    seedPublicEmbeddingConfig(rdfEngine);
    const resolver = new RdfSearchPodEmbeddingConfigResolver({ rdfEngine: publicFactsView(rdfEngine) });

    try {
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
    } finally {
      await rdfEngine.close();
    }
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

function seedPublicEmbeddingConfig(rdfEngine: SolidRdfEngine): void {
  const config = namedNode(`${AI_CONFIG_GRAPH}#config`);
  rdfEngine.replaceSource([
    quad(config, namedNode(RDF_TYPE), namedNode(`${UDFS}AIConfig`), namedNode(AI_CONFIG_GRAPH)),
    quad(config, namedNode(`${UDFS}embeddingModel`), namedNode(MODEL), namedNode(AI_CONFIG_GRAPH)),
  ], { source: AI_CONFIG_GRAPH, workspace: POD_ROOT });

  const provider = namedNode(PROVIDER);
  const model = namedNode(MODEL);
  rdfEngine.replaceSource([
    quad(model, namedNode(RDF_TYPE), namedNode(`${UDFS}Model`), namedNode(PROVIDER_GRAPH)),
    quad(model, namedNode(`${UDFS}isProvidedBy`), provider, namedNode(PROVIDER_GRAPH)),
    quad(model, namedNode(`${UDFS}modelType`), literal('embedding'), namedNode(PROVIDER_GRAPH)),
    quad(model, namedNode(`${UDFS}updatedAt`), literal('2026-08-13T08:00:00.000Z'), namedNode(PROVIDER_GRAPH)),
    quad(provider, namedNode(RDF_TYPE), namedNode(`${UDFS}Provider`), namedNode(PROVIDER_GRAPH)),
    quad(provider, namedNode(`${UDFS}baseUrl`), literal('https://api.cloudflare.com/client/v4/accounts/acct/ai/v1'), namedNode(PROVIDER_GRAPH)),
    quad(provider, namedNode(`${UDFS}proxyUrl`), literal('http://127.0.0.1:7890'), namedNode(PROVIDER_GRAPH)),
    quad(provider, namedNode(`${UDFS}defaultModel`), namedNode(`${PROVIDER_GRAPH}#gpt-4o-mini`), namedNode(PROVIDER_GRAPH)),
  ], { source: PROVIDER_GRAPH, workspace: POD_ROOT });

  const secondary = namedNode(`${CREDENTIALS_GRAPH}#secondary`);
  const primary = namedNode(`${CREDENTIALS_GRAPH}#primary`);
  rdfEngine.replaceSource([
    ...credentialQuads(secondary, 'sk-secondary', false, '2026-05-17T00:00:00.000Z', 0),
    ...credentialQuads(primary, 'sk-primary', true, '2026-05-18T00:00:00.000Z', 9),
    quad(primary, namedNode(`${UDFS}baseUrl`), literal('https://credential.example/v1'), namedNode(CREDENTIALS_GRAPH)),
  ], { source: CREDENTIALS_GRAPH, workspace: POD_ROOT });
}

function publicFactsView(rdfEngine: SolidRdfEngine): RdfEngineLike {
  return new Proxy(rdfEngine, {
    get(target, property, receiver) {
      if (property === 'sparqlQuery') {
        return undefined;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RdfEngineLike;
}

function credentialQuads(
  credential: ReturnType<typeof namedNode>,
  apiKey: string,
  isDefault: boolean,
  lastUsedAt: string,
  failCount: number,
) {
  const graph = namedNode(CREDENTIALS_GRAPH);
  return [
    quad(credential, namedNode(RDF_TYPE), namedNode(`${UDFS}Credential`), graph),
    quad(credential, namedNode(`${UDFS}service`), literal('ai'), graph),
    quad(credential, namedNode(`${UDFS}status`), literal('active'), graph),
    quad(credential, namedNode(`${UDFS}provider`), namedNode(PROVIDER), graph),
    quad(credential, namedNode(`${UDFS}apiKey`), literal(apiKey), graph),
    quad(credential, namedNode(`${UDFS}isDefault`), literal(String(isDefault)), graph),
    quad(credential, namedNode(`${UDFS}lastUsedAt`), literal(lastUsedAt), graph),
    quad(credential, namedNode(`${UDFS}failCount`), literal(String(failCount)), graph),
  ];
}
