import type { StoreContext } from '../chatkit/store';
import { RdfRunContextRetriever, type RdfRunContextRetrieverOptions } from '../runs/RdfRunContextRetriever';
import type { RunContextRetriever } from '../runs/RunExecutionBackend';
import { PostgresRdfEngine, type RdfAccessScope, type RdfEngineLike } from '../../storage/rdf';
import type { ApiContainerConfig } from './types';
import type { PodChatKitStore } from '../chatkit';
import type { EmbeddingService } from '../../ai/service';
import { RdfSearchIndexingService } from '../service/RdfSearchIndexingService';

export interface ApiRunContextRetrieverDependencies {
  chatKitStore?: Pick<PodChatKitStore, 'getAiConfig'>;
  embeddingService?: Partial<Pick<EmbeddingService, 'embed' | 'embedBatch'>>;
}

export function createApiRdfEngine(config: ApiContainerConfig): RdfEngineLike | undefined {
  const connectionString = config.sparqlEndpoint;
  if (config.edition !== 'cloud' || !connectionString || !isPostgresConnectionString(connectionString)) {
    return undefined;
  }

  return new PostgresRdfEngine({
    driver: 'pg',
    connectionString,
    rdfAccelerationProfile: 'pg-hot-operators',
    deferPgCustomIndexInitialization: true,
    maintenanceIntervalMs: 0,
    textIndex: {
      driver: 'pg',
      connectionString,
    },
    vectorIndex: {
      driver: 'pg',
      connectionString,
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

function createRunContextEmbeddingProvider(
  dependencies: ApiRunContextRetrieverDependencies,
): RdfRunContextRetrieverOptions<StoreContext>['embedding'] | undefined {
  const { chatKitStore, embeddingService } = dependencies;
  const embed = embeddingService?.embed;
  if (!chatKitStore || !embed) {
    return undefined;
  }

  return async (input) => {
    const config = await chatKitStore.getAiConfig(input.context);
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
      model: config.embeddingModel,
    };
  };
}

export function isPostgresConnectionString(value: string): boolean {
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
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
