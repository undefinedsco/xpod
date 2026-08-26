/**
 * 共享服务注册
 *
 * cloud 和 local 模式都需要的服务
 */

import { asFunction, type AwilixContainer } from 'awilix';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiContainerCradle } from './types';

import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { AccountRoleRepository } from '../../identity/drizzle/AccountRoleRepository';
import { ServiceTokenRepository } from '../../identity/drizzle/ServiceTokenRepository';
import { LocalSetupServiceTokenRepository } from '../../setup/LocalSetupServiceTokenRepository';
import { SolidTokenAuthenticator } from '../auth/SolidTokenAuthenticator';
import { ClientCredentialsAuthenticator } from '../auth/ClientCredentialsAuthenticator';
import { NodeTokenAuthenticator } from '../auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../auth/ServiceTokenAuthenticator';
import { MultiAuthenticator } from '../auth/MultiAuthenticator';
import { createDefaultProviderRegistry as createDefaultAiConnectionProviderRegistry } from '../ai-connections/providers/ProviderRegistry';
import {
  AnthropicQuotaAdapter,
  BailianQuotaAdapter,
  DeepSeekQuotaAdapter,
  KimiQuotaAdapter,
  OpenAiQuotaAdapter,
} from '../ai-connections/quota';
import {
  AnthropicModelsAdapter,
  OpenAiCompatibleModelsAdapter,
} from '../ai-connections/models';
import { ProviderProbeService } from '../ai-connections/ProviderProbeService';
import { AuthMiddleware } from '../middleware/AuthMiddleware';
import { VercelChatService } from '../service/VercelChatService';
import { VectorService } from '../service/VectorService';
import { RdfStorageStatsService } from '../service/RdfStorageStatsService';
import { RdfSearchReconciliationRepository } from '../../search/RdfSearchReconciliationRepository';
import { RdfSearchReconciliationWorker } from '../service/RdfSearchReconciliationWorker';
import { ApiServer } from '../ApiServer';
import { ChatKitService, PodChatKitStore, VercelAiProvider } from '../chatkit';
import { PodMatrixStore } from '../matrix';
import { ClientReconcilerCoordinator, ServerGroupReconcilerService } from '../reconciler';
import { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import { PiAgentRuntimeDriver } from '../runs/PiAgentRuntimeDriver';
import { RunAuthContextRegistry } from '../runs/RunAuthContextRegistry';
import { InngestTaskScheduler, TaskAuthBindingService, TaskService } from '../tasks';
import { EmbeddingServiceImpl, ProviderRegistryImpl } from '../../ai/service';
import {
  createApiRdfEngine,
  createApiRdfSearchIndexingService,
  createApiRunContextRetriever,
} from './rdf';
import {
  getEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../edge/EdgeNodeCertificateCapabilityBridge';

type RuntimeDriverOptionsWithReconciliation = ConstructorParameters<typeof PiAgentRuntimeDriver>[0] & {
  rdfSearchReconciliationRepository?: Pick<
    RdfSearchReconciliationRepository,
    'upsertRetryable' | 'waitForConfig' | 'upsertApplied' | 'deleteSource'
  >;
};

function resolveCssServiceBaseUrl(): string {
  if (process.env.CSS_INTERNAL_URL) {
    return process.env.CSS_INTERNAL_URL;
  }

  if (process.env.CSS_BASE_URL) {
    return process.env.CSS_BASE_URL;
  }

  return 'http://localhost:3000/';
}

/**
 * 注册共享服务到容器
 */
export function registerCommonServices(
  container: AwilixContainer<ApiContainerCradle>,
): void {
  container.register({
    // 数据库
    db: asFunction(({ config }: ApiContainerCradle) => {
      return getIdentityDatabase(config.databaseUrl);
    }).singleton(),

    edgeNodeCertificateCapabilityBridge: asFunction(({ config }: ApiContainerCradle) => {
      const bridgeId = resolveEdgeNodeCertificateCapabilityBridgeId({
        nodeId: config.nodeId,
        baseUrl: config.solidBaseUrl ?? config.publicUrl,
      });
      return bridgeId ? getEdgeNodeCertificateCapabilityBridge(bridgeId) : undefined;
    }).singleton(),

    // 仓库
    nodeRepo: asFunction(({ db, config }: ApiContainerCradle) => {
      return new EdgeNodeRepository(db, {
        ensureClusterTables: config.edition === 'cloud',
      });
    }).singleton(),

    accountRoleRepo: asFunction(({ db }: ApiContainerCradle) => {
      return new AccountRoleRepository(db);
    }).singleton(),

    // 认证
    serviceTokenRepo: asFunction(({ db, config }: ApiContainerCradle) => {
      if (config.edition === 'cloud') {
        return new ServiceTokenRepository(db);
      }

      return new LocalSetupServiceTokenRepository({
        token: config.serviceToken,
        serviceType: 'local',
        serviceId: config.nodeId ?? 'local-1',
        scopes: ['quota:write', 'usage:read', 'account:manage', 'network:read', 'network:write'],
      });
    }).singleton(),

    aiConnectionProviderRegistry: asFunction(() => createDefaultAiConnectionProviderRegistry()).singleton(),

    providerProbeService: asFunction(({ aiConnectionProviderRegistry, config }: ApiContainerCradle) => {
      return new ProviderProbeService({
        registry: aiConnectionProviderRegistry,
        edition: config.edition,
        quotaAdapters: [
          new OpenAiQuotaAdapter(),
          new AnthropicQuotaAdapter(),
          new KimiQuotaAdapter(),
          new BailianQuotaAdapter(),
          new DeepSeekQuotaAdapter(),
        ],
        modelAdapters: [
          new OpenAiCompatibleModelsAdapter({
            provider: 'openai',
            defaultBaseUrl: 'https://api.openai.com/v1',
          }),
          new AnthropicModelsAdapter(),
          new OpenAiCompatibleModelsAdapter({
            provider: 'kimi',
            defaultBaseUrl: 'https://api.moonshot.ai/v1',
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'bailian',
            defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'deepseek',
            defaultBaseUrl: 'https://api.deepseek.com/v1',
          }),
        ],
      });
    }).singleton(),

    authenticator: asFunction(({ nodeRepo, serviceTokenRepo, config }: ApiContainerCradle) => {
      const solidAuthenticator = new SolidTokenAuthenticator({
        resolveAccountId: async (webId) => webId,
        publicBaseUrl: config.solidBaseUrl,
        internalBaseUrl: config.cssTokenEndpoint,
      });

      const clientCredAuthenticator = new ClientCredentialsAuthenticator({
        tokenEndpoint: config.cssTokenEndpoint,
      });

      const nodeTokenAuthenticator = new NodeTokenAuthenticator({
        repository: nodeRepo,
      });

      const serviceTokenAuthenticator = new ServiceTokenAuthenticator({
        repository: serviceTokenRepo,
      });

      return new MultiAuthenticator({
        // Order: Solid DPoP → Service Token → Node Token → Client Credentials.
        // Agent execution is scoped by ChatKit thread/workspace and Run state, not standalone Agent JWTs.
        authenticators: [
          solidAuthenticator,
          serviceTokenAuthenticator,
          nodeTokenAuthenticator,
          clientCredAuthenticator,
        ],
      });
    }).singleton(),

    authMiddleware: asFunction(({ authenticator }: ApiContainerCradle) => {
      return new AuthMiddleware({ authenticator });
    }).singleton(),

    // Reconciler / Wake 运行态协调
    serverGroupReconcilerService: asFunction(({ config }: ApiContainerCradle) => {
      return new ServerGroupReconcilerService({
        redisUrl: config.redisUrl,
      });
    }).singleton(),

    // ChatKit 存储与服务
    chatKitStore: asFunction(({ config, serverGroupReconcilerService }: ApiContainerCradle) => {
      return new PodChatKitStore({
        tokenEndpoint: config.cssTokenEndpoint,
        serverGroupReconcilerService,
      });
    }).singleton(),

    clientReconcilerCoordinator: asFunction(({ config }: ApiContainerCradle) => {
      return new ClientReconcilerCoordinator({
        redisUrl: config.redisUrl,
      });
    }).singleton(),

    matrixStore: asFunction(({ config, serverGroupReconcilerService }: ApiContainerCradle) => {
      return new PodMatrixStore({
        serverGroupReconcilerService,
        serverName: (() => {
          try {
            return new URL(process.env.CSS_BASE_URL ?? '').host || undefined;
          } catch {
            return undefined;
          }
        })(),
      });
    }).singleton(),

    chatKitAiProvider: asFunction(({ chatKitStore }: ApiContainerCradle) => {
      return new VercelAiProvider({ store: chatKitStore });
    }).singleton(),

    runAuthContextRegistry: asFunction(() => {
      return new RunAuthContextRegistry();
    }).singleton(),

    taskAuthBindingService: asFunction(({ chatKitStore }: ApiContainerCradle) => {
      return new TaskAuthBindingService({
        repository: chatKitStore,
      });
    }).singleton(),

    rdfEngine: asFunction(({ config }: ApiContainerCradle) => {
      return createApiRdfEngine(config);
    }).singleton(),

    runContextRetriever: asFunction(({ rdfEngine, chatKitStore, embeddingService }: ApiContainerCradle) => {
      return createApiRunContextRetriever(rdfEngine, { chatKitStore, embeddingService });
    }).singleton(),

    rdfSearchIndexingService: asFunction(({ rdfEngine, chatKitStore, embeddingService }: ApiContainerCradle) => {
      return createApiRdfSearchIndexingService(rdfEngine, { chatKitStore, embeddingService });
    }).singleton(),

    rdfSearchReconciliationRepository: asFunction(({ db }: ApiContainerCradle) => {
      return new RdfSearchReconciliationRepository(db);
    }).singleton(),

    rdfSearchReconciliationWorker: asFunction(({
      rdfSearchReconciliationRepository,
      rdfSearchIndexingService,
      runAuthContextRegistry,
      chatKitStore,
      rdfEngine,
    }: ApiContainerCradle) => {
      const logger = getLoggerFor('RdfSearchReconciliationWorker');
      return new RdfSearchReconciliationWorker({
        repository: rdfSearchReconciliationRepository,
        indexingService: rdfSearchIndexingService,
        contextRegistry: runAuthContextRegistry,
        store: chatKitStore,
        rdfEngine,
        onError: (error, input) => {
          logger.error(`RDF search reconciliation ${input.phase} error${input.sourceKey ? ` for ${input.sourceKey}` : ''}: ${error instanceof Error ? error.message : String(error)}`);
        },
      });
    }).singleton(),

    rdfStorageStatsService: asFunction(({ config, rdfEngine }: ApiContainerCradle) => {
      return new RdfStorageStatsService({
        edition: config.edition,
        sparqlEndpoint: config.sparqlEndpoint,
        rdfEngine,
      });
    }).singleton(),

    runExecutionBackend: asFunction(({ config, inngestRuntimeConfig, chatKitStore, taskAuthBindingService, runAuthContextRegistry, runContextRetriever, rdfSearchIndexingService, rdfSearchReconciliationRepository }: ApiContainerCradle) => {
      const runtimeDriverOptions: RuntimeDriverOptionsWithReconciliation = {
        agentLoopIsolation: config.edition === 'cloud' ? 'sandboxed-process' : 'in-process',
        requireSandbox: config.edition === 'cloud',
        rdfSearchIndexingService,
        rdfSearchReconciliationRepository,
      };

      return new InngestRunExecutionBackend({
        baseUrl: inngestRuntimeConfig?.baseUrl,
        eventKey: inngestRuntimeConfig?.eventKey,
        signingKey: inngestRuntimeConfig?.signingKey,
        isDev: inngestRuntimeConfig?.enabled ? !inngestRuntimeConfig.durableDelivery : true,
        durableDelivery: inngestRuntimeConfig?.durableDelivery ?? false,
        store: chatKitStore,
        contextRetriever: runContextRetriever,
        contextRecorder: (context) => runAuthContextRegistry.remember(context),
        contextResolver: async (data) => {
          if (!data.authBindingId) {
            return undefined;
          }
          const fallback = runAuthContextRegistry.resolve({ webId: data.webId });
          if (!fallback) {
            return undefined;
          }
          return taskAuthBindingService.resolveRunContext(data.authBindingId, fallback);
        },
        runtimeDriver: new PiAgentRuntimeDriver(runtimeDriverOptions),
      });
    }).singleton(),

    chatKitService: asFunction(({ chatKitStore, chatKitAiProvider, runExecutionBackend, runContextRetriever }: ApiContainerCradle) => {
      return new ChatKitService({
        store: chatKitStore,
        aiProvider: chatKitAiProvider,
        enableAgentRuntime: true,
        runExecutionBackend,
        contextRetriever: runContextRetriever,
      });
    }).singleton(),

    taskService: asFunction(({ chatKitStore, runExecutionBackend, runContextRetriever }: ApiContainerCradle) => {
      return new TaskService({
        store: chatKitStore,
        executionBackend: runExecutionBackend,
        contextRetriever: runContextRetriever,
      });
    }).singleton(),

    inngestTaskScheduler: asFunction(({ runExecutionBackend, taskService, taskAuthBindingService, inngestRuntimeConfig, runAuthContextRegistry }: ApiContainerCradle) => {
      return new InngestTaskScheduler({
        backend: runExecutionBackend,
        taskService,
        getContexts: () => runAuthContextRegistry.list(),
        recordContext: (context) => runAuthContextRegistry.remember(context),
        resolveContext: async (data) => {
          if (!data.authBindingId) {
            return undefined;
          }
          const fallback = runAuthContextRegistry.resolve({ webId: data.webId });
          if (!fallback) {
            return undefined;
          }
          return taskAuthBindingService.resolveRunContext(data.authBindingId, fallback);
        },
        durableDelivery: inngestRuntimeConfig?.durableDelivery ?? false,
        executeInline: true,
      });
    }).singleton(),

    providerRegistry: asFunction(() => {
      return new ProviderRegistryImpl();
    }).singleton(),

    embeddingService: asFunction(({ providerRegistry }: ApiContainerCradle) => {
      return new EmbeddingServiceImpl(providerRegistry);
    }).singleton(),

    vectorService: asFunction(({ chatKitStore, embeddingService }: ApiContainerCradle) => {
      return new VectorService({
        cssBaseUrl: resolveCssServiceBaseUrl(),
        store: chatKitStore,
        embeddingService,
      });
    }).singleton(),

    // 业务服务
    chatService: asFunction(({ chatKitStore }: ApiContainerCradle) => {
      return new VercelChatService(chatKitStore);
    }).singleton(),


    // API Server
    apiServer: asFunction(({ config, authMiddleware }: ApiContainerCradle) => {
      return new ApiServer({
        port: config.port,
        host: config.host,
        socketPath: config.socketPath,
        runtimeHost: config.runtimeHost,
        authMiddleware,
        corsOrigins: config.corsOrigins,
      });
    }).singleton(),
  });
}
