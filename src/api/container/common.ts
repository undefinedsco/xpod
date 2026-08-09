/**
 * 共享服务注册
 *
 * cloud 和 local 模式都需要的服务
 */

import { asFunction, type AwilixContainer } from 'awilix';
import { randomBytes } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiContainerCradle } from './types';

import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { UsageRepository } from '../../storage/quota/UsageRepository';
import { AccountRoleRepository } from '../../identity/drizzle/AccountRoleRepository';
import { ServiceTokenRepository } from '../../identity/drizzle/ServiceTokenRepository';
import { LocalSetupServiceTokenRepository } from '../../setup/LocalSetupServiceTokenRepository';
import { SolidTokenAuthenticator } from '../auth/SolidTokenAuthenticator';
import { ClientCredentialsAuthenticator } from '../auth/ClientCredentialsAuthenticator';
import { NodeTokenAuthenticator } from '../auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../auth/ServiceTokenAuthenticator';
import { MultiAuthenticator } from '../auth/MultiAuthenticator';
import { GatewayApiKeyAuthenticator } from '../ai-gateway/auth/GatewayApiKeyAuthenticator';
import { PodGatewayAccessKeyRepository } from '../ai-gateway/auth/PodGatewayAccessKeyRepository';
import { AesGatewayKeyLocatorCodec } from '../ai-gateway/auth/GatewayKeyLocatorCodec';
import { ClientCredentialsInternalPodAccessTokenProvider } from '../ai-gateway/auth/ClientCredentialsInternalPodAccessTokenProvider';
import { AiConnectionsInvocationKeyIssuer } from '../ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../ai-gateway/auth/InvocationTokenCodec';
import { AiGatewayService } from '../ai-gateway/AiGatewayService';
import { PlaintextCredentialVault } from '../ai-gateway/credentials/PlaintextCredentialVault';
import type { CredentialVault } from '../ai-gateway/credentials/CredentialVault';
import {
  BrowserAssistedApiKeyConnectAdapter,
  InMemoryConnectAttemptStore,
  KimiDeviceCodeConnectAdapter,
  OAuthIntegrationRegistry,
  PodConnectedCredentialRepository,
  ProviderConnectService,
} from '../ai-gateway/connect';
import { createDefaultProviderRegistry as createDefaultGatewayProviderRegistry } from '../ai-gateway/providers/ProviderRegistry';
import { syncProviderRegistryFromModelsDev } from '../ai-gateway/providers/ModelsDevCatalog';
import { ProviderRuntimeRegistry } from '../ai-gateway/providers/ProviderRuntimeRegistry';
import { ModelRouter } from '../ai-gateway/routing/ModelRouter';
import { InMemorySessionAffinityStore } from '../ai-gateway/routing/InMemorySessionAffinityStore';
import { RedisSessionAffinityStore } from '../ai-gateway/routing/RedisSessionAffinityStore';
import {
  AnthropicQuotaAdapter,
  BailianQuotaAdapter,
  ClaudeSubscriptionQuotaAdapter,
  CodexSubscriptionQuotaAdapter,
  DeepSeekQuotaAdapter,
  KimiQuotaAdapter,
  KimiCodeSubscriptionQuotaAdapter,
  OpenAiQuotaAdapter,
  PodQuotaSnapshotRepository,
  ProviderQuotaService,
  UnsupportedQuotaAdapter,
} from '../ai-gateway/quota';
import {
  AnthropicModelsAdapter,
  OpenAiCompatibleModelsAdapter,
  ProviderCustomModelsService,
  ProviderModelsService,
} from '../ai-gateway/models';
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

function resolveAiConnectionsBaseUrl(config: ApiContainerCradle['config']): string {
  const origin = config.publicUrl
    ?? process.env.XPOD_PUBLIC_URL
    ?? process.env.CSS_BASE_URL
    ?? `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  return new URL('/v1', origin.endsWith('/') ? origin : `${origin}/`).toString().replace(/\/$/u, '');
}

function credentialVaultForConfig(config: ApiContainerCradle['config']): CredentialVault {
  return new PlaintextCredentialVault({
    legacyVault: config.secretCellCredentialVaultFactory?.(),
  });
}

function resolveAiConnectionsAudience(config: ApiContainerCradle['config']): string {
  return new URL(resolveAiConnectionsBaseUrl(config)).origin;
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

    gatewayInternalPodAccess: asFunction(({ config }: ApiContainerCradle) => {
      if (!config.gatewayInternalClientId || !config.gatewayInternalClientSecret) {
        return undefined;
      }
      return new ClientCredentialsInternalPodAccessTokenProvider({
        tokenEndpoint: config.cssTokenEndpoint,
        clientId: config.gatewayInternalClientId,
        clientSecret: config.gatewayInternalClientSecret,
      });
    }).singleton(),

    gatewayAccessKeyRepository: asFunction(({ config, gatewayInternalPodAccess }: ApiContainerCradle) => {
      if (!config.gatewayLocatorSecret) {
        return undefined;
      }
      return new PodGatewayAccessKeyRepository({
        locatorCodec: new AesGatewayKeyLocatorCodec({
          active: {
            kid: config.gatewayLocatorKeyId ?? 'active',
            secret: config.gatewayLocatorSecret,
          },
          previous: config.gatewayPreviousLocatorSecrets,
        }),
        internalPodAccess: gatewayInternalPodAccess,
      });
    }).singleton(),

    invocationTokenCodec: asFunction(({ config }: ApiContainerCradle) => {
      // Invocation tokens are short-lived and process-local by default. A
      // configured secret makes them portable across replicas, but local Xpod
      // must remain usable without legacy Gateway locator configuration.
      const secret = config.gatewayLocatorSecret ?? randomBytes(32).toString('hex');
      return new AesInvocationTokenCodec({
        active: {
          kid: config.gatewayLocatorKeyId ?? 'active',
          secret,
        },
        previous: config.gatewayLocatorSecret ? config.gatewayPreviousLocatorSecrets : undefined,
      });
    }).singleton(),

    aiConnectionInvocationKeyIssuer: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      return new AiConnectionsInvocationKeyIssuer({
        codec: cradle.invocationTokenCodec!,
        deployment: config.edition,
        baseUrl: resolveAiConnectionsBaseUrl(config),
        audience: resolveAiConnectionsAudience(config),
      });
    }).singleton(),

    providerConnectService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      const internalPodAccess = cradle.gatewayInternalPodAccess;
      const credentialRepository = new PodConnectedCredentialRepository({ internalPodAccess });
      const vault = credentialVaultForConfig(config);
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
          credentialRepository,
          vault,
        });
      }
      const signingSecret = config.aiGatewayConnectSigningSecret ?? config.gatewayLocatorSecret;
      if (!signingSecret) {
        throw new Error('AI Gateway Connect requires XPOD_AI_GATEWAY_CONNECT_SIGNING_SECRET or XPOD_GATEWAY_LOCATOR_SECRET');
      }
      const attempts = new InMemoryConnectAttemptStore();
      const oauthIntegrations = createKimiOAuthIntegrations(config);
      const adapters = [
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'openai',
          consoleUrl: 'https://platform.openai.com/api-keys',
          attempts,
          credentialRepository,
          vault,
          deployment: config.edition,
          signingSecret,
        }),
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'anthropic',
          consoleUrl: 'https://console.anthropic.com/settings/keys',
          attempts,
          credentialRepository,
          vault,
          deployment: config.edition,
          signingSecret,
        }),
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'bailian',
          consoleUrl: 'https://bailian.console.aliyun.com/',
          attempts,
          credentialRepository,
          vault,
          deployment: config.edition,
          signingSecret,
        }),
      ];
      const kimiOAuth = oauthIntegrations?.require('kimi');
      if (kimiOAuth) {
        adapters.push(new KimiDeviceCodeConnectAdapter({
          attempts,
          credentialRepository,
          vault,
          deployment: config.edition,
          signingSecret,
          oauthIntegration: kimiOAuth,
        }));
      }
      return new ProviderConnectService({
        registry: createDefaultGatewayProviderRegistry({
          connect: {
            kimi: kimiOAuth
              ? { configured: true }
              : { configured: false, notes: ['auth_not_available'] },
          },
        }),
        adapters,
        credentialRepository,
        vault,
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
      void syncProviderRegistryFromModelsDev(registry, { url: config.aiGatewayModelsDevUrl })
        .catch((error: unknown) => {
          getLoggerFor('GatewayProviderRegistry').warn(`models.dev sync failed: ${(error as Error).message}`);
        });
      return registry;
    }).singleton(),

    gatewayCredentialStore: asFunction(({ gatewayInternalPodAccess }: ApiContainerCradle) => {
      return new PodConnectedCredentialRepository({
        internalPodAccess: gatewayInternalPodAccess,
      });
    }).singleton(),

    gatewayRuntimeRegistry: asFunction(({ gatewayProviderRegistry }: ApiContainerCradle) => {
      return new ProviderRuntimeRegistry({ registry: gatewayProviderRegistry });
    }).singleton(),

    gatewaySessionAffinityStore: asFunction(({ config }: ApiContainerCradle) => {
      // Public /v1 routes must not disappear merely because the optional
      // legacy opaque Gateway Key locator is disabled. Without an explicit
      // deployment secret affinity becomes process-local (safe, but it will
      // not survive restarts or coordinate across replicas).
      const secret = config.gatewayLocatorSecret ?? randomBytes(32).toString('hex');
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
      const usageRepository = new UsageRepository(cradle.db);
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
        vault: credentialVaultForConfig(config),
        usageRecorder: async ({ webId, totalTokens }) => {
          const pod = await cradle.podLookupRepo?.findByWebId(webId);
          if (!pod) {
            return;
          }
          await usageRepository.incrementTokenUsage(pod.accountId, pod.podId, totalTokens);
        },
      });
    }).singleton(),

    providerQuotaService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      const internalPodAccess = cradle.gatewayInternalPodAccess;
      return new ProviderQuotaService({
        repository: new PodQuotaSnapshotRepository({ internalPodAccess }),
        credentialRepository: new PodConnectedCredentialRepository({ internalPodAccess }),
        vault: credentialVaultForConfig(config),
        providerRegistry: cradle.gatewayProviderRegistry,
        adapters: [
          new UnsupportedQuotaAdapter(),
          new CodexSubscriptionQuotaAdapter(),
          new OpenAiQuotaAdapter(),
          new ClaudeSubscriptionQuotaAdapter(),
          new AnthropicQuotaAdapter(),
          new KimiCodeSubscriptionQuotaAdapter(),
          new KimiQuotaAdapter(),
          new BailianQuotaAdapter(),
          new DeepSeekQuotaAdapter(),
        ],
      });
    }).singleton(),

    providerModelsService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      const internalPodAccess = cradle.gatewayInternalPodAccess;
      const registry = cradle.gatewayProviderRegistry;
      const safeBaseUrls = (provider: string): string[] => [
        ...registry.requireProvider(provider).safeBaseUrls,
        ...(registry.getProduct(provider)?.offerings.flatMap((offering) =>
          offering.endpoints.map((endpoint) => endpoint.baseUrl)) ?? []),
      ];
      return new ProviderModelsService({
        credentialRepository: new PodConnectedCredentialRepository({ internalPodAccess }),
        vault: credentialVaultForConfig(config),
        providerRegistry: registry,
        adapters: [
          new OpenAiCompatibleModelsAdapter({
            protocol: 'openai-models',
            registry,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'openai',
            defaultBaseUrl: 'https://api.openai.com/v1',
            safeBaseUrls: safeBaseUrls('openai'),
            product: registry.requireProduct('openai'),
          }),
          new AnthropicModelsAdapter({
            safeBaseUrls: safeBaseUrls('anthropic'),
            product: registry.requireProduct('anthropic'),
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'kimi',
            defaultBaseUrl: 'https://api.moonshot.ai/v1',
            safeBaseUrls: safeBaseUrls('kimi'),
            product: registry.requireProduct('kimi'),
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'bailian',
            defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            safeBaseUrls: safeBaseUrls('bailian'),
            product: registry.requireProduct('bailian'),
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'deepseek',
            defaultBaseUrl: 'https://api.deepseek.com/v1',
            safeBaseUrls: safeBaseUrls('deepseek'),
            product: registry.requireProduct('deepseek'),
          }),
        ],
      });
    }).singleton(),

    providerCustomModelsService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      if (!config.aiGatewayConnectEnabled) {
        return undefined;
      }
      return new ProviderCustomModelsService({
        credentialRepository: new PodConnectedCredentialRepository({
          internalPodAccess: cradle.gatewayInternalPodAccess,
        }),
      });
    }).singleton(),

    authenticator: asFunction(({ nodeRepo, serviceTokenRepo, gatewayAccessKeyRepository, invocationTokenCodec, config }: ApiContainerCradle) => {
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

      const gatewayApiKeyAuthenticator = gatewayAccessKeyRepository || invocationTokenCodec
        ? new GatewayApiKeyAuthenticator({
          repository: gatewayAccessKeyRepository,
          invocationTokenCodec,
          deployment: config.edition,
          invocationTokenAudience: resolveAiConnectionsAudience(config),
        })
        : undefined;

      return new MultiAuthenticator({
        // Order: Solid DPoP → Service Token → Node Token → Gateway Key → Client Credentials.
        // Agent execution is scoped by ChatKit thread/workspace and Run state, not standalone Agent JWTs.
        authenticators: [
          solidAuthenticator,
          serviceTokenAuthenticator,
          nodeTokenAuthenticator,
          ...(gatewayApiKeyAuthenticator ? [gatewayApiKeyAuthenticator] : []),
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
        requireAiConnectionsInvocationKeyIssuer: true,
      });
    }).singleton(),

    taskService: asFunction(({ chatKitStore, runExecutionBackend, runContextRetriever, aiConnectionInvocationKeyIssuer }: ApiContainerCradle) => {
      return new TaskService({
        store: chatKitStore,
        executionBackend: runExecutionBackend,
        contextRetriever: runContextRetriever,
        aiConnectionInvocationKeyIssuer,
        requireAiConnectionsInvocationKeyIssuer: true,
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

function createKimiOAuthIntegrations(config: ApiContainerCradle['config']): OAuthIntegrationRegistry | undefined {
  try {
    return OAuthIntegrationRegistry.fromServerConfig({
      kimi: {
        integrationId: config.aiGatewayKimiOAuthIntegrationId,
        issuedBy: 'xpod',
        clientId: config.aiGatewayKimiOAuthClientId,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'auth_not_available') {
      return undefined;
    }
    throw error;
  }
}
