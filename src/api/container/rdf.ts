import type { StoreContext } from '../chatkit/store';
import { RdfRunContextRetriever, type RdfRunContextRetrieverOptions } from '../runs/RdfRunContextRetriever';
import type { RunContextRetriever } from '../runs/RunExecutionBackend';
import {
  LocalQleverNativeSparqlClient,
  PostgresRdfEngine,
  SolidRdfEngine,
  type RdfAccessScope,
  type RdfEngineLike,
} from '../../storage/rdf';
import type { ApiContainerConfig } from './types';
import type { PodChatKitStore } from '../chatkit';
import type { RdfSearchAiConfig } from '../service/RdfSearchIndexingService';
import type { EmbeddingService } from '../../ai/service';
import {
  DEFAULT_RDF_VECTOR_PROJECTION_POLICY_VERSION,
  normalizeRdfVectorModelVersion,
  RdfSearchIndexingService,
} from '../service/RdfSearchIndexingService';
import { RdfSearchPodEmbeddingConfigResolver } from '../../search/RdfSearchPodEmbeddingConfigResolver';

export interface ApiRunContextRetrieverDependencies {
  chatKitStore?: Pick<PodChatKitStore, 'getAiConfig'>;
  embeddingService?: Partial<Pick<EmbeddingService, 'embed' | 'embedBatch'>>;
}

export function createApiRdfEngine(config: ApiContainerConfig): RdfEngineLike | undefined {
  const connectionString = config.edition === 'local' && config.rdfIndexPath
    ? `sqlite:${config.rdfIndexPath}`
    : config.sparqlEndpoint;
  if (!connectionString) return undefined;

  if (isSqliteConnectionString(connectionString)) {
    const path = sqlitePathFromConnectionString(connectionString);
    return new SolidRdfEngine({
      index: { path },
      textIndex: { path },
      vectorIndex: { path },
      nativeSparqlClient: new LocalQleverNativeSparqlClient({
        args: [
          '--sqlite-path',
          path,
        ],
      }),
    });
  }

  if (!isPostgresConnectionString(connectionString)) {
    return undefined;
  }

  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString,
    rdfAccelerationProfile: 'pg-hot-operators',
    maintenanceIntervalMs: 0,
    textIndex: {
      driver: 'pg',
      connectionString,
      textSearchBackend: 'pg-native-fts',
    },
    vectorIndex: {
      driver: 'pg',
      connectionString,
      backend: 'component',
    },
  });
}

export function createApiRunContextRetriever(
  rdfEngine: RdfEngineLike | undefined,
  dependencies: ApiRunContextRetrieverDependencies = {},
): RunContextRetriever<StoreContext> | undefined {
  if (!rdfEngine) {
    return undefined;
  }

  return new RdfRunContextRetriever({
    rdfEngine,
    embedding: createRunContextEmbeddingProvider(dependencies),
    accessScope: (input) => contextRdfAccessScope(input.context),
  });
}

export function createApiRdfSearchIndexingService(
  rdfEngine: RdfEngineLike | undefined,
  dependencies: ApiRunContextRetrieverDependencies = {},
): RdfSearchIndexingService | undefined {
  const { chatKitStore, embeddingService } = dependencies;
  const embedBatch = embeddingService?.embedBatch;
  if (!rdfEngine || !chatKitStore || !embedBatch) {
    return undefined;
  }

  return new RdfSearchIndexingService({
    rdfEngine,
    store: chatKitStore,
    embeddingService: { embedBatch },
  });
}

export function createApiRdfSearchPodEmbeddingConfigResolver(
  rdfEngine: RdfEngineLike | undefined,
): RdfSearchPodEmbeddingConfigResolver | undefined {
  return rdfEngine
    ? new RdfSearchPodEmbeddingConfigResolver({ rdfEngine })
    : undefined;
}

function createRunContextEmbeddingProvider(
  dependencies: ApiRunContextRetrieverDependencies,
): RdfRunContextRetrieverOptions<StoreContext>['embedding'] | undefined {
  const { chatKitStore, embeddingService } = dependencies;
  const embed = embeddingService?.embed;
  if (!chatKitStore || !embed) {
    return undefined;
  }

  return async (input) => {
    const config = await chatKitStore.getAiConfig(input.context) as RdfSearchAiConfig | undefined;
    if (!config?.embeddingModel || !config.apiKey) {
      return undefined;
    }

    return {
      embedding: await embed(input.prompt, {
        provider: config.providerId,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        proxyUrl: config.proxyUrl,
      }, config.embeddingModel),
      provider: config.providerId,
      model: config.embeddingModel,
      modelVersion: normalizeRdfVectorModelVersion(config.embeddingModelVersion),
      inputKind: 'semantic',
      projectionPolicyVersion: DEFAULT_RDF_VECTOR_PROJECTION_POLICY_VERSION,
    };
  };
}

export function isPostgresConnectionString(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}

export function isSqliteConnectionString(value: string): boolean {
  return value.startsWith('sqlite:');
}

function sqlitePathFromConnectionString(value: string): string {
  return value.slice('sqlite:'.length);
}

function contextRdfAccessScope(context: StoreContext): RdfAccessScope | undefined {
  const candidate = context.rdfAccessScope;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }
  const scope = candidate as Partial<RdfAccessScope>;
  if (typeof scope.basePath !== 'string' || !scope.basePath || typeof scope.mode !== 'string') {
    return undefined;
  }
  return scope as RdfAccessScope;
}
