/**
 * 共享服务注册
 *
 * cloud 和 local 模式都需要的服务
 */

import { randomBytes } from 'node:crypto';
import { asFunction, type AwilixContainer } from 'awilix';
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
import { InvocationTokenAuthenticator } from '../ai-gateway/auth/InvocationTokenAuthenticator';
import { AiConnectionInvocationKeyIssuer } from '../ai-gateway/auth/AiConnectionInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../ai-gateway/auth/InvocationTokenCodec';
import { HostedPodDataAccess } from '../ai-gateway/pod/HostedPodDataAccess';
import { AiGatewayService } from '../ai-gateway/AiGatewayService';
import {
  BrowserAssistedApiKeyConnectAdapter,
  InMemoryConnectAttemptStore,
  KimiDeviceCodeConnectAdapter,
  PodConnectedCredentialRepository,
  ProviderConnectService,
} from '../ai-gateway/connect';
import { createDefaultProviderRegistry as createDefaultGatewayProviderRegistry } from '../ai-gateway/providers/ProviderRegistry';
import { ProviderRuntimeRegistry } from '../ai-gateway/providers/ProviderRuntimeRegistry';
import { createProviderModelDiscoveryAdapters } from '../ai-gateway/models/ProviderModelDiscoveryAdapters';
import { PodModelSelectionRepository } from '../ai-gateway/models/PodModelSelectionRepository';
import { ProviderModelSelectionService } from '../ai-gateway/models/ProviderModelSelectionService';
import { ModelRouter } from '../ai-gateway/routing/ModelRouter';
import { InMemorySessionAffinityStore } from '../ai-gateway/routing/InMemorySessionAffinityStore';
import { RedisSessionAffinityStore } from '../ai-gateway/routing/RedisSessionAffinityStore';
import {
  AnthropicQuotaAdapter,
  BailianQuotaAdapter,
  DeepSeekQuotaAdapter,
  KimiQuotaAdapter,
  OpenAiQuotaAdapter,
  PodQuotaSnapshotRepository,
  ProviderQuotaService,
} from '../ai-gateway/quota';
import { AuthMiddleware } from '../middleware/AuthMiddleware';
import { VercelChatService } from '../service/VercelChatService';
import { VectorService } from '../service/VectorService';
import { RdfStorageStatsService } from '../service/RdfStorageStatsService';
import { ApiServer } from '../ApiServer';
import { ChatKitService, PodChatKitStore, VercelAiProvider } from '../chatkit';
import { PodMatrixStore } from '../matrix';
import { ClientReconcilerCoordinator, ServerGroupReconcilerService } from '../reconciler';
import { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import { PiAgentRuntimeDriver } from '../runs/PiAgentRuntimeDriver';
import { RunAuthContextRegistry } from '../runs/RunAuthContextRegistry';
import { InngestTaskScheduler, TaskAuthBindingService, TaskService } from '../tasks';
import { EmbeddingServiceImpl, ProviderRegistryImpl } from '../../ai/service';
import { createApiRdfEngine, createApiRdfSearchIndexingService, createApiRunContextRetriever } from './rdf';
import {
  getEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../edge/EdgeNodeCertificateCapabilityBridge';

function resolveCssServiceBaseUrl(): string {
  if (process.env.CSS_INTERNAL_URL) {
    return process.env.CSS_INTERNAL_URL;
  }

  if (process.env.CSS_BASE_URL) {
    return process.env.CSS_BASE_URL;
  }

  return 'http://localhost:3000/';
}

function resolveHostedPodCssBaseUrl(): string {
  return `http://127.0.0.1:${process.env.XPOD_MAIN_PORT ?? '3000'}/`;
}

function resolveAiConnectionBaseUrl(config: ApiContainerCradle['config']): string {
  const origin = config.publicUrl
    ?? process.env.XPOD_PUBLIC_URL
    ?? process.env.CSS_BASE_URL
    ?? `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  return new URL('/v1', origin.endsWith('/') ? origin : `${origin}/`).toString().replace(/\/$/u, '');
}

function resolveAiConnectionAudience(config: ApiContainerCradle['config']): string {
  return new URL(resolveAiConnectionBaseUrl(config)).origin;
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url');
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

    hostedPodDataAccess: asFunction(({ config }: ApiContainerCradle) => {
      return new HostedPodDataAccess({
        cssBaseUrl: resolveHostedPodCssBaseUrl(),
        gatewayAdminProxyAuthSecret: config.gatewayAdminProxyAuthSecret,
      });
    }).singleton(),

    invocationTokenCodec: asFunction(({ config }: ApiContainerCradle) => {
      return new AesInvocationTokenCodec({
        active: {
          kid: config.aiConnectionInvocationKeyId ?? 'ephemeral',
          secret: config.aiConnectionInvocationSecret ?? randomSecret(),
        },
        previous: config.aiConnectionPreviousInvocationSecrets,
      });
    }).singleton(),

    aiConnectionInvocationKeyIssuer: asFunction(({ config, invocationTokenCodec }: ApiContainerCradle) => {
      return new AiConnectionInvocationKeyIssuer({
        codec: invocationTokenCodec,
        deployment: config.edition,
        baseUrl: resolveAiConnectionBaseUrl(config),
        audience: resolveAiConnectionAudience(config),
      });
    }).singleton(),

    providerConnectService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      if (!config.aiGatewayConnectEnabled) {
        return new ProviderConnectService({
          registry: createDefaultGatewayProviderRegistry({
            connect: {
              openai: { configured: false, notes: ['AI Gateway provider Connect is disabled in this Xpod deployment.'] },
              anthropic: { configured: false, notes: ['AI Gateway provider Connect is disabled in this Xpod deployment.'] },
              kimi: { configured: false, notes: ['AI Gateway provider Connect is disabled in this Xpod deployment.'] },
              bailian: { configured: false, notes: ['AI Gateway provider Connect is disabled in this Xpod deployment.'] },
              deepseek: { configured: false },
            },
          }),
          adapters: [],
        });
      }
      const signingSecret = config.aiGatewayConnectSigningSecret ?? randomSecret();
      const internalPodAccess = cradle.hostedPodDataAccess;
      const credentialRepository = new PodConnectedCredentialRepository({ internalPodAccess });
      const attempts = new InMemoryConnectAttemptStore();
      const adapters = [
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'openai',
          consoleUrl: 'https://platform.openai.com/api-keys',
          attempts,
          credentialRepository,
          deployment: config.edition,
          signingSecret,
        }),
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'anthropic',
          consoleUrl: 'https://console.anthropic.com/settings/keys',
          attempts,
          credentialRepository,
          deployment: config.edition,
          signingSecret,
        }),
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'bailian',
          consoleUrl: 'https://bailian.console.aliyun.com/',
          attempts,
          credentialRepository,
          deployment: config.edition,
          signingSecret,
        }),
      ];
      if (config.aiGatewayKimiClientId) {
        adapters.push(new KimiDeviceCodeConnectAdapter({
          attempts,
          credentialRepository,
          deployment: config.edition,
          signingSecret,
          clientId: config.aiGatewayKimiClientId,
        }));
      }
      return new ProviderConnectService({
        registry: createDefaultGatewayProviderRegistry({
          connect: {
            kimi: config.aiGatewayKimiClientId
              ? { configured: true }
              : { configured: false, notes: ['not_configured: XPOD_AI_GATEWAY_KIMI_CLIENT_ID is not configured.'] },
          },
        }),
        adapters,
        credentialRepository,
      });
    }).singleton(),

    gatewayProviderRegistry: asFunction(({ config }: ApiContainerCradle) => {
      const registry = createDefaultGatewayProviderRegistry();
      const openAiBaseUrl = config.aiGatewayProviderBaseUrls?.openai;
      if (openAiBaseUrl) {
        registry.register({
          ...registry.requireProvider('openai'),
          defaultBaseUrl: openAiBaseUrl,
          safeBaseUrls: [openAiBaseUrl],
        });
      }
      return registry;
    }).singleton(),

    gatewayCredentialStore: asFunction(({ hostedPodDataAccess }: ApiContainerCradle) => {
      return new PodConnectedCredentialRepository({
        internalPodAccess: hostedPodDataAccess,
      });
    }).singleton(),

    podModelSelectionRepository: asFunction(({ hostedPodDataAccess }: ApiContainerCradle) => {
      return new PodModelSelectionRepository({
        internalPodAccess: hostedPodDataAccess,
      });
    }).singleton(),

    providerModelSelectionService: asFunction(({
      gatewayCredentialStore,
      gatewayProviderRegistry,
      podModelSelectionRepository,
    }: ApiContainerCradle) => {
      return new ProviderModelSelectionService({
        credentialRepository: gatewayCredentialStore,
        selectionRepository: podModelSelectionRepository,
        providerRegistry: gatewayProviderRegistry,
        discoveryRegistry: createProviderModelDiscoveryAdapters({ registry: gatewayProviderRegistry }),
      });
    }).singleton(),

    gatewayRuntimeRegistry: asFunction(({ gatewayProviderRegistry }: ApiContainerCradle) => {
      return new ProviderRuntimeRegistry({ registry: gatewayProviderRegistry });
    }).singleton(),

    gatewaySessionAffinityStore: asFunction(({ config }: ApiContainerCradle) => {
      const secret = config.aiGatewaySessionAffinitySecret ?? randomSecret();
      if (config.redisUrl) {
        return new RedisSessionAffinityStore({
          client: config.redisUrl,
          secret,
        });
      }
      return new InMemorySessionAffinityStore({ secret });
    }).singleton(),

    aiGatewayService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      const gatewayProviderRegistry = cradle.gatewayProviderRegistry;
      const gatewayCredentialStore = cradle.gatewayCredentialStore;
      const gatewayRuntimeRegistry = cradle.gatewayRuntimeRegistry;
      const gatewaySessionAffinityStore = cradle.gatewaySessionAffinityStore;
      const router = new ModelRouter({
        registry: gatewayProviderRegistry,
        affinityStore: gatewaySessionAffinityStore,
        credentials: gatewayCredentialStore.listCredentials.bind(gatewayCredentialStore),
      });
      return new AiGatewayService({
        deployment: config.edition,
        registry: gatewayProviderRegistry,
        router,
        credentials: gatewayCredentialStore,
        runtimes: gatewayRuntimeRegistry,
      });
    }).singleton(),

    providerQuotaService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      if (!config.aiGatewayConnectEnabled) {
        return undefined;
      }
      const internalPodAccess = cradle.hostedPodDataAccess;
      return new ProviderQuotaService({
        repository: new PodQuotaSnapshotRepository({ internalPodAccess }),
        credentialRepository: new PodConnectedCredentialRepository({ internalPodAccess }),
        adapters: [
          new OpenAiQuotaAdapter(),
          new AnthropicQuotaAdapter(),
          new KimiQuotaAdapter(),
          new BailianQuotaAdapter(),
          new DeepSeekQuotaAdapter(),
        ],
      });
    }).singleton(),

    authenticator: asFunction(({ nodeRepo, serviceTokenRepo, invocationTokenCodec, config }: ApiContainerCradle) => {
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

      const invocationTokenAuthenticator = new InvocationTokenAuthenticator({
        codec: invocationTokenCodec,
        deployment: config.edition,
        audience: resolveAiConnectionAudience(config),
      });

      return new MultiAuthenticator({
        // Order: Solid DPoP → Service Token → Node Token → short-lived invocation → Client Credentials.
        // Agent execution is scoped by ChatKit thread/workspace and Run state, not standalone Agent JWTs.
        authenticators: [solidAuthenticator, serviceTokenAuthenticator, nodeTokenAuthenticator, invocationTokenAuthenticator, clientCredAuthenticator],
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

    chatKitAiProvider: asFunction(({ chatKitStore, aiGatewayService }: ApiContainerCradle) => {
      return new VercelAiProvider({ store: chatKitStore, aiGatewayService });
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

    rdfStorageStatsService: asFunction(({ config, rdfEngine }: ApiContainerCradle) => {
      return new RdfStorageStatsService({
        edition: config.edition,
        sparqlEndpoint: config.sparqlEndpoint,
        rdfEngine,
      });
    }).singleton(),

    runExecutionBackend: asFunction(({ config, inngestRuntimeConfig, chatKitStore, taskAuthBindingService, runAuthContextRegistry, runContextRetriever, rdfSearchIndexingService, aiConnectionInvocationKeyIssuer }: ApiContainerCradle) => {
      return new InngestRunExecutionBackend({
        baseUrl: inngestRuntimeConfig?.baseUrl,
        eventKey: inngestRuntimeConfig?.eventKey,
        signingKey: inngestRuntimeConfig?.signingKey,
        isDev: inngestRuntimeConfig?.enabled ? !inngestRuntimeConfig.durableDelivery : true,
        durableDelivery: inngestRuntimeConfig?.durableDelivery ?? false,
        store: chatKitStore,
        contextRetriever: runContextRetriever,
        aiConnectionInvocationKeyIssuer,
        contextRecorder: (context) => runAuthContextRegistry.remember(context),
        contextResolver: async (data) => {
          const fallback = runAuthContextRegistry.resolve({ webId: data.webId });
          if (data.authBindingId && fallback) {
            return await taskAuthBindingService.resolveRunContext(data.authBindingId, fallback) ?? fallback;
          }
          return fallback;
        },
        runtimeDriver: new PiAgentRuntimeDriver({
          agentLoopIsolation: config.edition === 'cloud' ? 'sandboxed-process' : 'in-process',
          requireSandbox: config.edition === 'cloud',
          rdfSearchIndexingService,
        }),
      });
    }).singleton(),

    chatKitService: asFunction(({ chatKitStore, chatKitAiProvider, runExecutionBackend, runContextRetriever, aiConnectionInvocationKeyIssuer }: ApiContainerCradle) => {
      return new ChatKitService({
        store: chatKitStore,
        aiProvider: chatKitAiProvider,
        enableAgentRuntime: true,
        runExecutionBackend,
        contextRetriever: runContextRetriever,
        aiConnectionInvocationKeyIssuer,
        requireAiConnectionInvocationKeyIssuer: true,
      });
    }).singleton(),

    taskService: asFunction(({ chatKitStore, runExecutionBackend, runContextRetriever, aiConnectionInvocationKeyIssuer }: ApiContainerCradle) => {
      return new TaskService({
        store: chatKitStore,
        executionBackend: runExecutionBackend,
        contextRetriever: runContextRetriever,
        aiConnectionInvocationKeyIssuer,
        requireAiConnectionInvocationKeyIssuer: true,
      });
    }).singleton(),

    inngestTaskScheduler: asFunction(({ runExecutionBackend, taskService, taskAuthBindingService, inngestRuntimeConfig, runAuthContextRegistry }: ApiContainerCradle) => {
      return new InngestTaskScheduler({
        backend: runExecutionBackend,
        taskService,
        getContexts: () => runAuthContextRegistry.list(),
        recordContext: (context) => runAuthContextRegistry.remember(context),
        resolveContext: async (data) => {
          const fallback = runAuthContextRegistry.resolve({ webId: data.webId });
          if (data.authBindingId && fallback) {
            return await taskAuthBindingService.resolveRunContext(data.authBindingId, fallback) ?? fallback;
          }
          return fallback;
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
    chatService: asFunction(({ chatKitStore, aiGatewayService }: ApiContainerCradle) => {
      return new VercelChatService(chatKitStore, { aiGatewayService });
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
