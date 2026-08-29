import { UDFS, normalizeAIConfigModelId, normalizeAIConfigProviderId, selectAIConfigCredential } from '@undefineds.co/models';
import type { RdfSearchAiConfig } from '../api/service/RdfSearchIndexingService';
import { QleverSparqlEngine } from '../storage/rdf/QleverSparqlEngine';
import { RdfAccessMode, type RdfAccessScope } from '../storage/rdf/RdfAccessScope';
import { RdfQuerySparqlEngine } from '../storage/rdf/RdfQuerySparqlEngine';
import { serializeSparqlIri } from '../storage/rdf/RdfSparqlSerialization';
import type { RdfEngineLike } from '../storage/rdf/types';
import type { SparqlEngine } from '../storage/sparql/SubgraphQueryEngine';

interface RdfSearchPodEmbeddingConfigResolverOptions {
  rdfEngine: RdfEngineLike;
}

interface ConfigCandidate {
  embeddingModel?: string;
}

interface ProviderModelCandidate {
  provider: string;
  model: string;
  modelType?: string;
  baseUrl?: string;
  proxyUrl?: string;
  defaultModel?: string;
  modelUpdatedAt?: string;
}

interface CredentialCandidate {
  [key: string]: unknown;
  id: string;
  provider: string;
  service: 'ai';
  status: 'active';
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
  isDefault?: boolean;
  lastUsedAt?: Date;
  failCount?: number;
}

/**
 * Reads embedding provider configuration as the Pod storage authority.
 *
 * This intentionally uses the active product SPARQL authority: Local and the
 * private Cloud overlay expose native QLever, while public Cloud uses Comunica
 * over the PostgreSQL RDF facts authority.
 * It does not keep raw API keys beyond the returned in-memory config object.
 */
export class RdfSearchPodEmbeddingConfigResolver {
  private readonly sparqlEngine: SparqlEngine;

  public constructor(options: RdfSearchPodEmbeddingConfigResolverOptions) {
    this.sparqlEngine = typeof options.rdfEngine.sparqlQuery === 'function'
      ? new QleverSparqlEngine(options.rdfEngine)
      : new RdfQuerySparqlEngine(options.rdfEngine);
  }

  public async getAiConfig(podRoot: string): Promise<RdfSearchAiConfig | undefined> {
    const normalizedPodRoot = normalizePodRoot(podRoot);
    const configGraph = `${normalizedPodRoot}settings/ai/config.ttl`;
    const credentialsGraph = `${normalizedPodRoot}settings/credentials.ttl`;
    const config = await this.readConfig(normalizedPodRoot, configGraph);
    if (!config?.embeddingModel || !belongsToPod(config.embeddingModel, normalizedPodRoot)) {
      return undefined;
    }

    const modelGraph = graphFromPodSettingsProviderSubject(config.embeddingModel, normalizedPodRoot);
    if (!modelGraph) {
      return undefined;
    }

    const providerModel = await this.readProviderModel(normalizedPodRoot, modelGraph, config.embeddingModel);
    if (!providerModel || !belongsToPod(providerModel.provider, normalizedPodRoot)) {
      return undefined;
    }
    if (providerModel.modelType !== 'embedding') {
      return undefined;
    }

    const providerGraph = graphFromPodSettingsProviderSubject(providerModel.provider, normalizedPodRoot);
    if (!providerGraph || providerGraph !== modelGraph) {
      return undefined;
    }

    const credentialRows = (await this.readCredentials(normalizedPodRoot, credentialsGraph, providerModel.provider))
      .filter((credential) => belongsToPod(credential.id, normalizedPodRoot));
    const providerId = normalizeAIConfigProviderId(providerModel.provider);
    const selectedCredential = selectAIConfigCredential(providerId, credentialRows, [ {
      id: providerModel.provider,
      baseUrl: providerModel.baseUrl,
      proxyUrl: providerModel.proxyUrl,
    } ]);
    if (!selectedCredential) {
      return undefined;
    }

    const baseUrl = selectedCredential.baseUrl;
    if (!providerId || !baseUrl) {
      return undefined;
    }

    return {
      providerId,
      baseUrl,
      ...(selectedCredential.proxyUrl ? { proxyUrl: selectedCredential.proxyUrl } : {}),
      ...(providerModel.defaultModel ? { defaultModel: normalizeAIConfigModelId(providerModel.defaultModel, providerId) || providerModel.defaultModel } : {}),
      embeddingModel: normalizeAIConfigModelId(providerModel.model, providerId) || providerModel.model,
      ...(providerModel.modelUpdatedAt ? { embeddingModelVersion: providerModel.modelUpdatedAt } : {}),
      apiKey: selectedCredential.apiKey,
      credentialId: String(selectedCredential.credential.id ?? selectedCredential.credentialId ?? ''),
    };
  }

  private async readConfig(podRoot: string, graph: string): Promise<ConfigCandidate | undefined> {
    const rows = await this.select(podRoot, graph, `
      PREFIX ai: <${UDFS.NAMESPACE}>
      SELECT ?config ?embeddingModel WHERE {
        GRAPH ${serializeSparqlIri(graph)} {
          BIND(${serializeSparqlIri(`${graph}#config`)} AS ?config)
          ?config a ai:AIConfig .
          OPTIONAL { ?config ai:embeddingModel ?embeddingModel . }
        }
      } LIMIT 1
    `);
    for (const row of rows) {
      const config = row.config;
      const embeddingModel = row.embeddingModel;
      if (config !== `${graph}#config`) {
        continue;
      }
      return { embeddingModel };
    }
    return undefined;
  }

  private async readProviderModel(podRoot: string, graph: string, model: string): Promise<ProviderModelCandidate | undefined> {
    const rows = await this.select(podRoot, graph, `
      PREFIX ai: <${UDFS.NAMESPACE}>
      SELECT ?provider ?modelType ?modelUpdatedAt ?baseUrl ?proxyUrl ?defaultModel WHERE {
        GRAPH ${serializeSparqlIri(graph)} {
          ${serializeSparqlIri(model)} a ai:Model ;
            ai:isProvidedBy ?provider .
          OPTIONAL { ${serializeSparqlIri(model)} ai:modelType ?modelType . }
          OPTIONAL { ${serializeSparqlIri(model)} ai:updatedAt ?modelUpdatedAt . }
          ?provider a ai:Provider .
          OPTIONAL { ?provider ai:baseUrl ?baseUrl . }
          OPTIONAL { ?provider ai:proxyUrl ?proxyUrl . }
          OPTIONAL { ?provider ai:defaultModel ?defaultModel . }
        }
      } LIMIT 10
    `);
    for (const row of rows) {
      if (!row.provider || !belongsToPod(row.provider, podRoot)) {
        continue;
      }
      if (row.defaultModel && !belongsToPod(row.defaultModel, podRoot)) {
        continue;
      }
      return {
        provider: row.provider,
        model,
        modelType: row.modelType,
        modelUpdatedAt: row.modelUpdatedAt,
        baseUrl: row.baseUrl,
        proxyUrl: row.proxyUrl,
        defaultModel: row.defaultModel,
      };
    }
    return undefined;
  }

  private async readCredentials(podRoot: string, graph: string, provider: string): Promise<CredentialCandidate[]> {
    const rows = await this.select(podRoot, graph, `
      PREFIX cred: <${UDFS.NAMESPACE}>
      SELECT ?credential ?apiKey ?baseUrl ?proxyUrl ?isDefault ?lastUsedAt ?failCount WHERE {
        GRAPH ${serializeSparqlIri(graph)} {
          ?credential a cred:Credential ;
            cred:service "ai" ;
            cred:status "active" ;
            cred:provider ${serializeSparqlIri(provider)} ;
            cred:apiKey ?apiKey .
          OPTIONAL { ?credential cred:baseUrl ?baseUrl . }
          OPTIONAL { ?credential cred:proxyUrl ?proxyUrl . }
          OPTIONAL { ?credential cred:isDefault ?isDefault . }
          OPTIONAL { ?credential cred:lastUsedAt ?lastUsedAt . }
          OPTIONAL { ?credential cred:failCount ?failCount . }
        }
      }
    `);
    return rows
      .filter((row) => row.credential && row.apiKey)
      .map((row) => ({
        id: row.credential!,
        provider,
        service: 'ai',
        status: 'active',
        apiKey: row.apiKey!,
        baseUrl: row.baseUrl,
        proxyUrl: row.proxyUrl,
        isDefault: booleanValue(row.isDefault),
        lastUsedAt: dateValue(row.lastUsedAt),
        failCount: numberValue(row.failCount),
      }));
  }

  private async select(podRoot: string, graph: string, query: string): Promise<Array<Record<string, string | undefined>>> {
    const stream = await this.sparqlEngine.queryBindings(query, podRoot, exactGraphScope(podRoot, graph));
    const variables = (await stream.metadata()).variables.map((variable: { value: string }) => variable.value);
    const rows: Array<Record<string, string | undefined>> = [];
    for await (const binding of stream) {
      const row: Record<string, string | undefined> = {};
      for (const variable of variables) {
        row[variable] = binding.get(variable)?.value;
      }
      rows.push(row);
    }
    return rows;
  }
}

function exactGraphScope(podRoot: string, graph: string): RdfAccessScope {
  return {
    basePath: podRoot,
    mode: RdfAccessMode.READ,
    allowedGraphUrls: [ graph ],
    allowedSourceUrls: [ graph ],
  };
}

function normalizePodRoot(input: string): string {
  const url = new URL(input);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function belongsToPod(value: string, podRoot: string): boolean {
  try {
    return new URL(value).href.startsWith(podRoot);
  } catch {
    return false;
  }
}

function graphFromPodSettingsProviderSubject(value: string, podRoot: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    const graph = url.href;
    return graph.startsWith(`${podRoot}settings/providers/`) && graph.endsWith('.ttl') ? graph : undefined;
  } catch {
    return undefined;
  }
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === 'true' || value === '1';
}

function dateValue(value: string | undefined): Date | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}
