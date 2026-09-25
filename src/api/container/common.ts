/**
 * 共享服务注册
 *
 * cloud 和 local 模式都需要的服务
 */

import { asFunction, type AwilixContainer } from 'awilix';
import { randomBytes } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiContainerCradle } from './types';
import { resolvePersistentGatewayLocatorSecret } from '../../runtime/gateway-locator-secret';

import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { UsageRepository } from '../../storage/quota/UsageRepository';
import { AccountRoleRepository } from '../../identity/drizzle/AccountRoleRepository';
import { ServiceTokenRepository } from '../../identity/drizzle/ServiceTokenRepository';
import { LocalSetupServiceTokenRepository } from '../../setup/LocalSetupServiceTokenRepository';
import { SolidTokenAuthenticator } from '../auth/SolidTokenAuthenticator';
import { SolidSessionFactory } from '../auth/SolidSessionFactory';
import { ClientCredentialsAuthenticator } from '../auth/ClientCredentialsAuthenticator';
import { NodeTokenAuthenticator } from '../auth/NodeTokenAuthenticator';
import { ServiceTokenAuthenticator } from '../auth/ServiceTokenAuthenticator';
import { MultiAuthenticator } from '../auth/MultiAuthenticator';
import { InvocationTokenAuthenticator } from '../ai-gateway/auth/InvocationTokenAuthenticator';
import { AiConnectionsInvocationKeyIssuer } from '../ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import { AesInvocationTokenCodec } from '../ai-gateway/auth/InvocationTokenCodec';
import { GatewayApiKeyAuthenticator } from '../ai-gateway/auth/GatewayApiKeyAuthenticator';
import { AesGatewayKeyLocatorCodec } from '../ai-gateway/auth/GatewayKeyLocatorCodec';
import { PodGatewayAccessKeyRepository } from '../ai-gateway/auth/PodGatewayAccessKeyRepository';
import { OwnerPodAccess } from '../ai-gateway/pod/OwnerPodAccess';
import { resolveHostedPodRoute } from '../ai-gateway/pod/HostedPodRoute';
import { getTaskCredentialDatabase, resolveTaskCredentialDatabaseUrl } from '../tasks/TaskCredentialDatabase';
import { createTaskCredentialSource, TaskCredentialStore } from '../tasks/TaskCredentialStore';
import { PodInterfaceKeyRepository } from '../../identity/drizzle/PodInterfaceKeyRepository';
import { PodInterfaceKeyStore } from '../ai-gateway/pod/PodInterfaceKeyStore';
import { AiGatewayService } from '../ai-gateway/AiGatewayService';
import { PlaintextCredentialVault } from '../ai-gateway/credentials/PlaintextCredentialVault';
import { createAiCredentialSecretDecoder } from '../ai-gateway/credentials/AiCredentialSecretDecoder';
import type { CredentialVault } from '../ai-gateway/credentials/CredentialVault';
import {
  BrowserAssistedApiKeyConnectAdapter,
  InMemoryConnectAttemptStore,
  DeviceCodeConnectAdapter,
  AuthorizationCodeConnectAdapter,
  PodConnectedCredentialRepository,
  ProviderConnectService,
} from '../ai-gateway/connect';
import { LoopbackAuthorizationCallbackReceiver } from '../ai-gateway/connect/LoopbackAuthorizationCallbackReceiver';
import { FileSessionImportAdapter } from '../ai-gateway/connect/FileSessionImportAdapter';
import { OPENAI_CODEX_SESSION_IMPORT_PROFILE, KIMI_CODE_SESSION_IMPORT_PROFILE } from '../ai-gateway/connect/SessionImportProfiles';
import { createProviderOAuthIntegrations, createBrowserOAuthIntegrations } from '../ai-gateway/connect/ProviderAuthorizationProfiles';
import {
  createDefaultProviderRegistry as createDefaultGatewayProviderRegistry,
  providerProductsForDeployment,
} from '../ai-gateway/providers/ProviderRegistry';
import { syncProviderRegistryFromModelsDev } from '../ai-gateway/providers/ModelsDevCatalog';
import { ProviderRuntimeRegistry } from '../ai-gateway/providers/ProviderRuntimeRegistry';
import { createProviderModelDiscoveryAdapters } from '../ai-gateway/models/ProviderModelDiscoveryAdapters';
import { PodModelSelectionRepository } from '../ai-gateway/models/PodModelSelectionRepository';
import { ProviderModelSelectionService } from '../ai-gateway/models/ProviderModelSelectionService';
import { ModelRouter } from '../ai-gateway/routing/ModelRouter';
import {
  CloudGatewayModelsClient,
  resolveCloudModelsGatewayOrigin,
} from '../ai-gateway/CloudGatewayModelsClient';
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
  CodexSubscriptionModelsAdapter,
  createGatewayEmbeddingModelCatalog,
  OpenAiCompatibleModelsAdapter,
  ProviderCustomModelsService,
  ProviderModelsService,
} from '../ai-gateway/models';
import { AuthMiddleware } from '../middleware/AuthMiddleware';
import { VercelChatService } from '../service/VercelChatService';
import { discoverSystemProviderProxy, ProviderHttpTransport } from '../service/provider-http-transport';
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
import { createEmbeddingModelPolicy, EmbeddingServiceImpl, ProviderRegistryImpl } from '../../ai/service';
import { createApiRdfEngine, createApiRdfSearchIndexingService, createApiRunContextRetriever } from './rdf';
import {
  getEdgeNodeCertificateCapabilityBridge,
  resolveEdgeNodeCertificateCapabilityBridgeId,
} from '../../edge/EdgeNodeCertificateCapabilityBridge';

function resolveCssServiceBaseUrl(): string {
  return `http://127.0.0.1:${process.env.CSS_PORT ?? '3000'}/`;
}

function resolveHostedPodCssBaseUrl(): string {
  return `http://127.0.0.1:${process.env.XPOD_MAIN_PORT ?? '3000'}/`;
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

function resolveGatewayLocatorSecret(config: ApiContainerCradle['config']): string {
  if (config.gatewayLocatorSecret?.trim()) {
    return config.gatewayLocatorSecret;
  }
  return resolvePersistentGatewayLocatorSecret({
    databaseUrl: config.databaseUrl,
    edition: config.edition,
  });
}

function podBaseUrlResolver(cradle: ApiContainerCradle) {
  return async (webId: string): Promise<string | undefined> => {
    const pod = await cradle.podLookupRepo?.findByWebId(webId);
    return pod?.storageUrl ?? pod?.baseUrl;
  };
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

    taskCredentialStore: asFunction(({ config }: ApiContainerCradle) => {
      // No root key means no encrypted store: a credential that cannot be sealed is not kept.
      const vault = config.secretCellVaultFactory?.();
      if (!vault) {
        return undefined;
      }
      const url = resolveTaskCredentialDatabaseUrl({
        identityDatabaseUrl: config.databaseUrl,
        configuredUrl: config.taskDatabaseUrl,
      });
      return new TaskCredentialStore({ database: getTaskCredentialDatabase(url), vault });
    }).singleton(),

    solidSessions: asFunction(({ config }: ApiContainerCradle) => {
      return new SolidSessionFactory({
        tokenEndpoint: config.cssTokenEndpoint,
        publicBaseUrl: config.solidBaseUrl,
      });
    }).singleton(),

    ownerPodAccess: asFunction(({ config, db, solidSessions, taskCredentialStore }: ApiContainerCradle) => {
      // Task-layer grants are what background work uses; the stored key stays the fallback for
      // entries that have not migrated yet.
      const issuer = config.solidBaseUrl ?? config.publicUrl;
      return new OwnerPodAccess({
        keys: new PodInterfaceKeyStore({
          repository: new PodInterfaceKeyRepository(db),
          vault: credentialVaultForConfig(config),
        }),
        sessions: solidSessions,
        ...(taskCredentialStore && issuer
          ? { taskCredentials: createTaskCredentialSource({ store: taskCredentialStore, issuer }) }
          : {}),
        route: resolveHostedPodRoute({
          canonicalBaseUrl: config.solidBaseUrl,
          // API_HOST is the address the runtime bound its services to; XPOD_MAIN_PORT is the
          // Gateway's. Both are read here, while the runtime still has its environment applied.
          gatewayHost: process.env.API_HOST,
          gatewayPort: process.env.XPOD_MAIN_PORT,
        }),
      });
    }).singleton(),

    invocationTokenCodec: asFunction(() => {
      // Invocation tokens are short-lived and process-local: a fresh random
      // secret per process is sufficient for browser-session invocation.
      return new AesInvocationTokenCodec({
        active: {
          kid: 'active',
          secret: randomBytes(32).toString('hex'),
        },
      });
    }).singleton(),

    gatewayAccessKeyRepository: asFunction((cradle: ApiContainerCradle) => {
      const { config, ownerPodAccess } = cradle;
      return new PodGatewayAccessKeyRepository({
        locatorCodec: new AesGatewayKeyLocatorCodec({
          active: {
            kid: config.gatewayLocatorKeyId ?? 'active',
            secret: resolveGatewayLocatorSecret(config),
          },
          previous: config.gatewayPreviousLocatorSecrets,
        }),
        podAccess: ownerPodAccess,
        podBaseUrlResolver: podBaseUrlResolver(cradle),
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
      const credentialRepository = new PodConnectedCredentialRepository({
        podAccess: cradle.ownerPodAccess,
        podBaseUrlResolver: podBaseUrlResolver(cradle),
      });
      const vault = credentialVaultForConfig(config);
      // AI Gateway Connect has no on/off switch: installing ai-connections
      // means Connect is available. Connect attempts are short-lived in-memory
      // state, so a process-random signing secret is sufficient by default.
      const signingSecret = config.aiGatewayConnectSigningSecret ?? randomBytes(32).toString('hex');
      const attempts = new InMemoryConnectAttemptStore();
      const registry = createDefaultGatewayProviderRegistry({
        products: providerProductsForDeployment(config.edition),
      });
      const adapterOptions = {
        attempts, credentialRepository, vault, deployment: config.edition, signingSecret,
      };
      const callbackReceiver = new LoopbackAuthorizationCallbackReceiver();
      const adapters = [
        ...registry.listProviders()
          .filter((provider) => provider.connect?.mode === 'browserAssistedApiKey')
          .map((provider) => new BrowserAssistedApiKeyConnectAdapter({
            ...adapterOptions,
            provider: provider.id,
            consoleUrl: registry.requireProduct(provider.id).offerings
              .find((offering) => offering.kind === 'api-platform')?.consoleUrl
              ?? registry.requireProduct(provider.id).offerings[0].consoleUrl,
          })),
        ...(config.edition === 'local' ? createBrowserOAuthIntegrations().map((integration) => new AuthorizationCodeConnectAdapter({
          ...adapterOptions, integration, callbackReceiver,
        })) : []),
        ...createProviderOAuthIntegrations().map((integration) => new DeviceCodeConnectAdapter({
          ...adapterOptions,
          integration,
        })),
      ];
      return new ProviderConnectService({
        registry,
        adapters,
        localSessionImporters: config.edition === 'local'
          ? [OPENAI_CODEX_SESSION_IMPORT_PROFILE, KIMI_CODE_SESSION_IMPORT_PROFILE]
            .map((profile) => new FileSessionImportAdapter({ profile }))
          : [],
        credentialRepository,
        vault,
      });
    }).singleton(),

    gatewayProviderRegistry: asFunction(({ config }: ApiContainerCradle) => {
      const registry = createDefaultGatewayProviderRegistry({
        products: providerProductsForDeployment(config.edition),
      });
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

    providerHttpTransport: asFunction(({ config }: ApiContainerCradle) => new ProviderHttpTransport({
      // The hermetic acceptance stack may allow only its own exact loopback origin.
      allowedPrivateOrigins: process.env.XPOD_ACCEPTANCE_PROVIDER_ORIGIN
        ? [process.env.XPOD_ACCEPTANCE_PROVIDER_ORIGIN]
        : [],
      systemProxy: config.edition === 'local' ? discoverSystemProviderProxy() : undefined,
    })).singleton(),

    gatewayCredentialStore: asFunction((cradle: ApiContainerCradle) => {
      const { ownerPodAccess } = cradle;
      return new PodConnectedCredentialRepository({
        podAccess: ownerPodAccess,
        podBaseUrlResolver: podBaseUrlResolver(cradle),
      });
    }).singleton(),

    podModelSelectionRepository: asFunction((cradle: ApiContainerCradle) => {
      const { ownerPodAccess } = cradle;
      return new PodModelSelectionRepository({
        podAccess: ownerPodAccess,
        podBaseUrlResolver: podBaseUrlResolver(cradle),
      });
    }).singleton(),

    providerModelSelectionService: asFunction((cradle: ApiContainerCradle) => {
      const {
      config,
      gatewayProviderRegistry,
      ownerPodAccess,
      podModelSelectionRepository,
      providerModelsService,
      } = cradle;
      return new ProviderModelSelectionService({
        credentialRepository: new PodConnectedCredentialRepository({
          podAccess: ownerPodAccess,
          podBaseUrlResolver: podBaseUrlResolver(cradle),
        }),
        selectionRepository: podModelSelectionRepository,
        providerRegistry: gatewayProviderRegistry,
        discoveryRegistry: createProviderModelDiscoveryAdapters({ registry: gatewayProviderRegistry }),
        modelsService: providerModelsService,
        credentialVault: credentialVaultForConfig(config),
        embeddingModelPolicy: cradle.embeddingModelPolicy,
      });
    }).singleton(),

    gatewayRuntimeRegistry: asFunction(({ config, gatewayProviderRegistry, providerHttpTransport }: ApiContainerCradle) => {
      return new ProviderRuntimeRegistry({
        registry: gatewayProviderRegistry,
        transport: providerHttpTransport,
        // A user-owned endpoint is a Local capability; Cloud uses the catalog's.
        allowCredentialBaseUrl: config.edition === 'local',
      });
    }).singleton(),

    gatewaySessionAffinityStore: asFunction(({ config }: ApiContainerCradle) => {
      // Session affinity secrets are process-local by default: a fresh random
      // secret per process is safe, it just does not survive restarts or
      // coordinate across replicas.
      const secret = randomBytes(32).toString('hex');
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
        embeddingModelPolicy: cradle.embeddingModelPolicy,
      });
      const cloudGatewayOrigin = resolveCloudModelsGatewayOrigin({
        edition: config.edition,
        oidcIssuer: config.oidcIssuer,
        solidBaseUrl: config.solidBaseUrl,
        publicUrl: config.publicUrl,
      });
      return new AiGatewayService({
        deployment: config.edition,
        registry: gatewayProviderRegistry,
        router,
        credentials: gatewayCredentialStore,
        runtimes: gatewayRuntimeRegistry,
        vault: credentialVaultForConfig(config),
        cloudModels: cloudGatewayOrigin
          ? new CloudGatewayModelsClient({ cloudGatewayOrigin })
          : undefined,
        usageRecorder: async ({ webId, apiKeyId, totalTokens }) => {
          const pod = await cradle.podLookupRepo?.findByWebId(webId);
          if (!pod) {
            return;
          }
          if (apiKeyId) {
            await usageRepository.incrementApiKeyTokenUsage(pod.accountId, pod.podId, apiKeyId, totalTokens);
            return;
          }
          await usageRepository.incrementTokenUsage(pod.accountId, pod.podId, totalTokens);
        },
      });
    }).singleton(),

    providerQuotaService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      const podAccess = cradle.ownerPodAccess;
      return new ProviderQuotaService({
        repository: new PodQuotaSnapshotRepository({
          podAccess,
          podBaseUrlResolver: podBaseUrlResolver(cradle),
        }),
        credentialRepository: new PodConnectedCredentialRepository({
          podAccess,
          podBaseUrlResolver: podBaseUrlResolver(cradle),
        }),
        vault: credentialVaultForConfig(config),
        providerRegistry: cradle.gatewayProviderRegistry,
        adapters: [
          new UnsupportedQuotaAdapter(),
          new CodexSubscriptionQuotaAdapter({ transport: cradle.providerHttpTransport }),
          new OpenAiQuotaAdapter(),
          new ClaudeSubscriptionQuotaAdapter({ transport: cradle.providerHttpTransport }),
          new AnthropicQuotaAdapter(),
          new KimiCodeSubscriptionQuotaAdapter({ transport: cradle.providerHttpTransport }),
          new KimiQuotaAdapter({ transport: cradle.providerHttpTransport }),
          new BailianQuotaAdapter(),
          new DeepSeekQuotaAdapter({ transport: cradle.providerHttpTransport }),
        ],
      });
    }).singleton(),

    providerModelsService: asFunction((cradle: ApiContainerCradle) => {
      const { config } = cradle;
      const podAccess = cradle.ownerPodAccess;
      const registry = cradle.gatewayProviderRegistry;
      const safeBaseUrls = (provider: string): string[] => [
        ...registry.requireProvider(provider).safeBaseUrls,
        ...(registry.getProduct(provider)?.offerings.flatMap((offering) =>
          offering.endpoints.map((endpoint) => endpoint.baseUrl)) ?? []),
      ];
      return new ProviderModelsService({
        credentialRepository: new PodConnectedCredentialRepository({
          podAccess,
          podBaseUrlResolver: podBaseUrlResolver(cradle),
        }),
        vault: credentialVaultForConfig(config),
        providerRegistry: registry,
        adapters: [
          new CodexSubscriptionModelsAdapter({ transport: cradle.providerHttpTransport }),
          new OpenAiCompatibleModelsAdapter({
            protocol: 'openai-models',
            registry,
            transport: cradle.providerHttpTransport,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'openai',
            defaultBaseUrl: 'https://api.openai.com/v1',
            safeBaseUrls: safeBaseUrls('openai'),
            product: registry.requireProduct('openai'),
            transport: cradle.providerHttpTransport,
          }),
          new AnthropicModelsAdapter({
            safeBaseUrls: safeBaseUrls('anthropic'),
            product: registry.requireProduct('anthropic'),
            transport: cradle.providerHttpTransport,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'kimi',
            defaultBaseUrl: 'https://api.moonshot.ai/v1',
            safeBaseUrls: safeBaseUrls('kimi'),
            product: registry.requireProduct('kimi'),
            transport: cradle.providerHttpTransport,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'bailian',
            defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            safeBaseUrls: safeBaseUrls('bailian'),
            product: registry.requireProduct('bailian'),
            transport: cradle.providerHttpTransport,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'deepseek',
            defaultBaseUrl: 'https://api.deepseek.com/v1',
            safeBaseUrls: safeBaseUrls('deepseek'),
            product: registry.requireProduct('deepseek'),
            transport: cradle.providerHttpTransport,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'zhipu',
            defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
            safeBaseUrls: safeBaseUrls('zhipu'),
            product: registry.requireProduct('zhipu'),
            transport: cradle.providerHttpTransport,
          }),
          new OpenAiCompatibleModelsAdapter({
            provider: 'ollama',
            defaultBaseUrl: 'http://localhost:11434/v1',
            safeBaseUrls: safeBaseUrls('ollama'),
            product: registry.requireProduct('ollama'),
            transport: cradle.providerHttpTransport,
          }),
        ],
      });
    }).singleton(),

    providerCustomModelsService: asFunction((cradle: ApiContainerCradle) => {
      return new ProviderCustomModelsService({
        credentialRepository: new PodConnectedCredentialRepository({
          podAccess: cradle.ownerPodAccess,
          podBaseUrlResolver: podBaseUrlResolver(cradle),
        }),
        embeddingModelPolicy: cradle.embeddingModelPolicy,
        registry: cradle.gatewayProviderRegistry,
      });
    }).singleton(),

    authenticator: asFunction(({
      nodeRepo,
      serviceTokenRepo,
      invocationTokenCodec,
      gatewayAccessKeyRepository,
      solidSessions,
      config,
    }: ApiContainerCradle) => {
      const solidAuthenticator = new SolidTokenAuthenticator({
        resolveAccountId: async (webId) => webId,
        publicBaseUrl: config.solidBaseUrl,
        // Token discovery is a public OIDC concern. WebID/JWKS verification is
        // an internal service call and must not hairpin through public ingress.
        internalBaseUrl: resolveHostedPodCssBaseUrl(),
      });

      const clientCredAuthenticator = new ClientCredentialsAuthenticator({
        sessions: solidSessions,
      });

      const nodeTokenAuthenticator = new NodeTokenAuthenticator({
        repository: nodeRepo,
      });

      const serviceTokenAuthenticator = new ServiceTokenAuthenticator({
        repository: serviceTokenRepo,
      });

      const clientConfigurationInvocationAuthenticator = invocationTokenCodec
        ? new InvocationTokenAuthenticator({
          codec: invocationTokenCodec,
          deployment: config.edition,
          audience: resolveAiConnectionsAudience(config),
        })
        : undefined;

      const gatewayApiKeyAuthenticator = new GatewayApiKeyAuthenticator({
        repository: gatewayAccessKeyRepository,
        deployment: config.edition,
        invocationTokenCodec,
        invocationTokenAudience: resolveAiConnectionsAudience(config),
      });

      return new MultiAuthenticator({
        // Client-configuration invocation tokens share the invocation prefix with
        // inference tokens, so route-scoped authentication must run before the
        // generic client-credentials authenticator claims the bearer.
        // Order: Solid DPoP → Service Token → Node Token →
        // Client Configuration Invocation → Gateway API Key → Client Credentials.
        // Agent execution is scoped by ChatKit thread/workspace and Run state, not standalone Agent JWTs.
        authenticators: [
          solidAuthenticator,
          serviceTokenAuthenticator,
          nodeTokenAuthenticator,
          ...(clientConfigurationInvocationAuthenticator ? [clientConfigurationInvocationAuthenticator] : []),
          gatewayApiKeyAuthenticator,
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
    chatKitStore: asFunction(({ config, ownerPodAccess, serverGroupReconcilerService }: ApiContainerCradle) => {
      return new PodChatKitStore({
        podAccess: ownerPodAccess,
        serverGroupReconcilerService,
        deployment: config.edition,
        credentialSecretDecoder: createAiCredentialSecretDecoder({
          vault: credentialVaultForConfig(config),
        }),
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

    taskAuthBindingService: asFunction(({ chatKitStore, taskCredentialStore, config }: ApiContainerCradle) => {
      const issuer = config.solidBaseUrl ?? config.publicUrl;
      return new TaskAuthBindingService({
        repository: chatKitStore,
        // Unattended runs take their credential from the task layer; the Pod-stored credential
        // stays the fallback until every binding names a grant.
        ...(taskCredentialStore && issuer
          ? { taskCredentials: createTaskCredentialSource({ store: taskCredentialStore, issuer }) }
          : {}),
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
          logger.error(`Failed RDF search ${input.phase} for ${input.sourceUri ?? input.sourceKey ?? 'unknown source'}: ${error}`);
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

    runExecutionBackend: asFunction(({ config, inngestRuntimeConfig, chatKitStore, taskAuthBindingService, runAuthContextRegistry, runContextRetriever, rdfSearchIndexingService, rdfSearchReconciliationRepository, aiConnectionInvocationKeyIssuer }: ApiContainerCradle) => {
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
          rdfSearchReconciliationRepository,
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

    embeddingModelPolicy: asFunction(({ config, gatewayProviderRegistry }: ApiContainerCradle) => {
      return createEmbeddingModelPolicy({
        deployment: config.edition,
        catalog: createGatewayEmbeddingModelCatalog(gatewayProviderRegistry, config.edition),
      });
    }).singleton(),

    embeddingService: asFunction(({ providerRegistry, embeddingModelPolicy }: ApiContainerCradle) => {
      return new EmbeddingServiceImpl(providerRegistry, { policy: embeddingModelPolicy });
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
