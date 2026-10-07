import { SqlMatrixEventJournal } from '../matrix/MatrixEventJournal';
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
import { migratePodInterfaceKeysToTaskCredentials } from '../tasks/PodInterfaceKeyMigration';
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
import { CanonicalRoomSource, parseMembershipAuthorityBinding } from '../matrix/canonicalRoomSource';
import { MembershipAuthorityPublisher } from '../matrix/membershipAuthorityPublication';
import { MembershipAuthorityLocator } from '../matrix/membershipAuthorityLocator';
import { MembershipAuthorityResolver } from '../matrix/membershipAuthorityResolver';
import { matrixPodWriteFor } from '../matrix/podAccess';
import { createParticipantRoutes } from '../matrix/participantRoutes';
import { MatrixServerKeyFetcher } from '../matrix/federation/serverKeys';
import { PodMatrixInboundTransactionStore } from '../matrix/federation/podInboundTransaction';
import { MatrixServerNameResolver } from '../matrix/federation/serverNameResolution';
import { createNodeFederationFetch } from '../matrix/federation/federationFetch';
import { joinRoomOverFederation } from '../matrix/federation/remoteJoin';
import { webIdServerName } from '../matrix/protocol/serverName';
import { createMatrixRoomWatchService, notificationEndpointOf } from '../matrix/notifications/roomWatchService';
import { MatrixRoomChangeTracker } from '../matrix/notifications/roomChangeTracker';
import type { NotificationSocket } from '../matrix/notifications/roomChangeSubscription';
import { matrixSigningIdentityRegistry } from '../matrix/identityRegistry';
import { matrixSigningIdentityForPod } from '../matrix/identityProvisioning';
import { createPodParticipantIdentityProvider } from '../matrix/podParticipantIdentity';
import { createMatrixOutboundDelivery, nodeSrvRecords } from '../matrix/federation/outboundDelivery';
import { PodMatrixOutboundStore } from '../matrix/federation/podOutboundStore';
import { createNamedPublicationControlAuthority, type MatrixControlRecordTarget } from '../matrix/controlRecords';
import type { MatrixFederationActor } from '../matrix/federation/outboundTransaction';
import { createSchedulingOutbox, MatrixOutboxScheduler } from '../matrix/federation/outboxScheduler';
import { MatrixOutbox } from '../matrix/federation/outboundQueue';
import { promises as dns } from 'node:dns';
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
/**
 * The Pod handle an outbound scope's batches are written with.
 *
 * A scope is a Pod root, and the served routes are what say which participant it belongs to: the
 * deployment writes on its own behalf with that participant's task-layer grant, exactly as it does
 * for an inbound transaction. Resolved when a batch is written rather than when the container is
 * built, because the store this needs is the one being assembled.
 */
async function outboundHandleFor(
  cradle: ApiContainerCradle,
  scope: string,
): Promise<MatrixControlRecordTarget | undefined> {
  const routes = cradle.matrixParticipantRoutes;
  if (!routes) return undefined;
  for (const route of (await routes.routes()).served.values()) {
    if (route.podUrl !== scope) continue;
    return await cradle.matrixStore.controlRecordHandleFor({ webId: route.webId, podUrl: route.podUrl, service: {} });
  }
  return undefined;
}

/** Explicit publication authority; shared by physical delivery and conditional carrier mutation. */
async function publicationTaskAuthority(cradle: ApiContainerCradle, actor: MatrixFederationActor) {
  const binding = parseMembershipAuthorityBinding(actor.taskCredential);
  const issuer = cradle.config.solidBaseUrl ?? cradle.config.publicUrl;
  if (!binding || !cradle.taskCredentialStore || binding.issuer !== issuer || !actor.podUrl) {
    throw new Error('A configured named publication authority is required');
  }
  const beforeRequest = async(): Promise<void> => {
    const lease = await cradle.taskCredentialStore!.lease({ credentialRef: binding.credentialRef,
      ownerWebId: actor.webId, version: binding.version, recordUsage: false });
    if (lease.credentialRef !== binding.credentialRef || lease.ownerWebId !== actor.webId
      || lease.version !== binding.version || lease.issuer !== issuer) throw new Error('Current publication authority differs');
  };
  await beforeRequest();
  return { binding, beforeRequest };
}

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

    legacyPodKeyMigration: asFunction(({ config, db, taskCredentialStore }: ApiContainerCradle) => {
      const issuer = config.solidBaseUrl ?? config.publicUrl;
      if (!taskCredentialStore || !issuer) {
        return undefined;
      }
      return async() => await migratePodInterfaceKeysToTaskCredentials({
        keys: new PodInterfaceKeyStore({
          repository: new PodInterfaceKeyRepository(db),
          vault: credentialVaultForConfig(config),
        }),
        taskCredentials: taskCredentialStore,
        issuer,
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

    ownerPodAccess: asFunction(({ config, solidSessions, taskCredentialStore }: ApiContainerCradle) => {
      // Background work uses the owner's task-layer grant; a request uses the credential its
      // caller brought. Nothing is read from a deployment-held key any more.
      const issuer = config.solidBaseUrl ?? config.publicUrl;
      return new OwnerPodAccess({
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

    matrixServiceIdentity: asFunction(({ config }: ApiContainerCradle) => config.matrixServiceIdentity).singleton(),

    matrixSigningIdentities: asFunction(({ config }: ApiContainerCradle) => {
      return matrixSigningIdentityRegistry({
        ...(config.matrixServiceIdentity ? { identity: config.matrixServiceIdentity } : {}),
      });
    }).singleton(),

    // Participants become their own Matrix server by having this deployment mint their key
    // into their own Pod. It needs a root key to seal with and the Pod registry to find
    // that Pod; without either, everybody keeps writing under the deployment identity.
    matrixParticipantIdentity: asFunction((cradle: ApiContainerCradle) => {
      const vault = cradle.config.secretCellVaultFactory?.();
      const pods = cradle.podLookupRepo;
      if (!vault || !pods) return undefined;
      return createPodParticipantIdentityProvider({
        registry: cradle.matrixSigningIdentities,
        pods,
        provision: async ({ serverName, ownerWebId, podUrl, context }) => matrixSigningIdentityForPod({
          serverName,
          ownerWebId,
          podUrl,
          vault,
          podAccess: cradle.ownerPodAccess,
          context: {
            ...(context.auth ? { auth: context.auth } : {}),
            ...(context.podUrl ? { podBaseUrl: context.podUrl } : {}),
          },
        }),
      });
    }).singleton(),

    // Inbound routing needs the reverse of "which Pod does this WebID write to": a request names
    // a server, and the answer has to come from the registrations the deployment already keeps —
    // a participant's server name is derived from their WebID, so there is no binding to record.
    matrixParticipantRoutes: asFunction((cradle: ApiContainerCradle) => {
      const pods = cradle.podLookupRepo;
      if (!pods) return undefined;
      return createParticipantRoutes({ pods });
    }).singleton(),

    // Where a server name is reached: `.well-known` is preferred, SRV is the fallback the
    // specification still allows, and answers are cached. One resolver for the deployment, so
    // delivery and key fetching cannot disagree — or ask twice.
    // Delegated endpoints are reached by address but must prove the server name; `fetch` can set
    // neither SNI nor `Host`, so every federation request in production goes through this.
    matrixFederationFetch: asFunction((_cradle: ApiContainerCradle) => createNodeFederationFetch()).singleton(),

    matrixServerNameResolver: asFunction((_cradle: ApiContainerCradle) => new MatrixServerNameResolver({
      fetch: globalThis.fetch,
      resolveSrv: async name => nodeSrvRecords(await dns.resolveSrv(name)),
    })).singleton(),

    // Verifying what peers send us: their published keys, fetched from a key endpoint that may
    // itself be delegated.
    matrixServerKeyFetcher: asFunction(({ matrixServerNameResolver, matrixFederationFetch }: ApiContainerCradle) => new MatrixServerKeyFetcher({
      fetch: globalThis.fetch,
      fetchTarget: matrixFederationFetch,
      resolveKeyEndpoint: async serverName => {
        const target = await matrixServerNameResolver.resolve(serverName);
        return `${target?.baseUrl ?? `https://${serverName}`}/_matrix/key/v2/server`;
      },
    })).singleton(),

    // A peer's retry must be answered, not processed twice: the record of what a transaction id
    // already produced. The record lives in the Pod the transaction is written to (models
    // `taskResource`, one document per key), so it survives a restart and is the deployment's own
    // fact rather than a process's. The handle it writes through is resolved per request by the
    // store, which is the one place that decides who a Matrix write is done as.
    matrixInboundTransactions: asFunction((_cradle: ApiContainerCradle) =>
      new PodMatrixInboundTransactionStore()).singleton(),

    // Bounded sync in production: every Pod this deployment serves has its rooms watched, so a
    // sync with nothing to catch up on reads nothing. The room list comes from the store, resolved
    // lazily — the store is built *with* this source, and the cycle is broken by asking for the
    // store only when a watcher starts, which happens after the container is built.
    matrixRoomWatchService: asFunction((cradle: ApiContainerCradle) => {
      const routes = cradle.matrixParticipantRoutes;
      if (!routes || !cradle.config.matrixServiceIdentity) return undefined;
      const logger = getLoggerFor('MatrixRoomWatch');
      return createMatrixRoomWatchService({
        routes: async () => [ ...(await routes.routes()).served.values() ],
        rooms: async route => await cradle.matrixStore.listJoinedRooms({
          webId: route.webId, podUrl: route.podUrl, service: {},
        }),
        watch: async ({ route, rooms }) => {
          // Resolve current participant authority on every request, including reconnects.
          const participantFetch: typeof fetch = async(input, init) => {
            const authenticated = await cradle.ownerPodAccess.getPodFetch(route.webId, {
              taskCredential: {}, podBaseUrl: route.podUrl,
            });
            if (!authenticated) throw new Error(`No current Pod grant for ${route.webId}`);
            return await authenticated(input, init);
          };
          const endpoint = await notificationEndpointOf(route.podUrl, participantFetch);
          const tracker = new MatrixRoomChangeTracker({
            scope: route.podUrl,
            endpoint,
            fetch: participantFetch,
            openSocket: url => new WebSocket(url) as unknown as NotificationSocket,
            rooms,
            onError: error => { logger.warn(`Watching ${route.podUrl} failed: ${error.message}`); },
          });
          await tracker.start();
          return tracker;
        },
        onError: error => { logger.warn(`Room watch reconciliation failed: ${error.message}`); },
      });
    }).singleton(),

    // The outbound path: where a server name is reached, which identity signs as the origin,
    // and what is still owed. Absent without an identity of our own: a queue whose every
    // batch would be abandoned is worse than no queue.
    matrixOutboundDelivery: asFunction((cradle: ApiContainerCradle) => {
      const { config, matrixSigningIdentities, matrixServerNameResolver, matrixFederationFetch, ownerPodAccess, taskCredentialStore } = cradle;
      if (!config.matrixServiceIdentity) return undefined;
      return createMatrixOutboundDelivery({
        identities: matrixSigningIdentities,
        fetch: globalThis.fetch,
        fetchTarget: matrixFederationFetch,
        // O1: the actual outbound request is authenticated as the participant whose event is
        // travelling, using the participant's own current grant through the existing
        // OwnerPodAccess/SolidSessionFactory. The grant is re-resolved on every attempt, so a
        // revoked or missing one refuses rather than falling back to a deployment identity. Only
        // the actor reference is carried here; no bearer/session is read from it.
        actorFetch: async(actor) => {
          const publication = actor.taskCredential?.purpose !== undefined || actor.taskCredential?.issuer !== undefined;
          const named = publication ? await publicationTaskAuthority(cradle, actor) : undefined;
          const beforeRequest = named?.beforeRequest;
          return await ownerPodAccess.getPodFetch(actor.webId, {
            ...(actor.taskCredential === undefined ? { taskCredential: { ownerGrant: true } } : { taskCredential: actor.taskCredential }),
            ...(actor.podUrl === undefined ? {} : { podBaseUrl: actor.podUrl }),
            ...(beforeRequest ? { beforeRequest } : {}),
          });
        },
        resolver: matrixServerNameResolver,
        // The queue lives in the Pods this deployment serves, so what is owed survives a restart.
        // Both halves resolve lazily: the routes are what a scope means, and the store is the
        // authority to write it — asking for either *now* would close a cycle with the store this
        // delivery is being built for.
        store: new PodMatrixOutboundStore({
          handleFor: async(scope: string) => await outboundHandleFor(cradle, scope),
          publicationHandleFor: async(scope, batch) => {
            const actor = batch.actor;
            if (!actor || actor.podUrl !== scope) throw new Error('Publication batch scope differs from its actor');
            const routes = cradle.matrixParticipantRoutes;
            const served = routes ? [ ...(await routes.routes()).served.values() ] : [];
            if (!served.some(route => route.webId === actor.webId && route.podUrl === scope)) {
              throw new Error('Publication actor is not the exact served participant');
            }
            const named = await publicationTaskAuthority(cradle, actor);
            const authority = await createNamedPublicationControlAuthority({ kind: 'named-publication',
              webId: actor.webId, podUrl: scope, binding: named.binding, beforeRequest: named.beforeRequest });
            const authenticated = await ownerPodAccess.getPodFetch(actor.webId, {
              podBaseUrl: scope, taskCredential: named.binding, beforeRequest: named.beforeRequest,
            });
            if (!authenticated) throw new Error('Publication named task transport is unavailable');
            const context = { webId: actor.webId, podUrl: scope, service: { taskCredential: named.binding } };
            const write = await matrixPodWriteFor(context, { getPodFetch: async() => authenticated });
            return { target: { scope, write }, authority };
          },
          scopes: async () => {
            const routes = cradle.matrixParticipantRoutes;
            if (!routes) return [];
            return [ ...(await routes.routes()).served.values() ].map(route => route.podUrl);
          },
        }),
      });
    }).singleton(),

    // What actually drives delivery: a signal (a write, later a notification) plus a periodic
    // pass, serialized so two writers cannot drain the same queue at once.
    matrixOutboxScheduler: asFunction(({ matrixOutboundDelivery }: ApiContainerCradle) => {
      if (!matrixOutboundDelivery) return undefined;
      const logger = getLoggerFor('MatrixOutbox');
      return new MatrixOutboxScheduler({
        outbox: matrixOutboundDelivery.outbox,
        onPass: pass => {
          if (pass.delivered + pass.deferred + pass.rejected + pass.abandoned + pass.failed > 0) {
            logger.info(`Federation delivery pass: ${JSON.stringify(pass)}`);
          }
        },
        onError: error => { logger.warn(`Federation delivery failed: ${error.message}`); },
      });
    }).singleton(),

    matrixCanonicalRoomSource: asFunction(({ podLookupRepo, ownerPodAccess }: ApiContainerCradle) => {
      return podLookupRepo ? new CanonicalRoomSource({
        pods: podLookupRepo,
        callerFetchFor: async(context, beforeRequest) => {
          if (!beforeRequest) return (await matrixPodWriteFor(context, ownerPodAccess, {})).fetch;
          const callerFetch = await ownerPodAccess.getPodFetch(context.webId, { auth: context.auth,
            podBaseUrl: context.podUrl, beforeRequest });
          if (!callerFetch) throw new Error('Caller Pod access is unavailable');
          return callerFetch;
        },
      }) : undefined;
    }).singleton(),
    matrixMembershipAuthorityLocator: asFunction(({ db }: ApiContainerCradle) => new MembershipAuthorityLocator(db)).singleton(),
    matrixMembershipAuthorityResolver: asFunction(({ matrixCanonicalRoomSource, matrixMembershipAuthorityLocator,
      taskCredentialStore, ownerPodAccess, config }: ApiContainerCradle) => {
      const issuer = config.solidBaseUrl ?? config.publicUrl;
      return matrixCanonicalRoomSource && taskCredentialStore && issuer ? new MembershipAuthorityResolver({
        canonicalSource: matrixCanonicalRoomSource, locator: matrixMembershipAuthorityLocator,
        credentials: taskCredentialStore, podAccess: ownerPodAccess, issuer,
      }) : undefined;
    }).singleton(),

    matrixStore: asFunction(({ config, db, ownerPodAccess, matrixCanonicalRoomSource, taskCredentialStore, serverGroupReconcilerService, matrixSigningIdentities, matrixParticipantIdentity, matrixOutboundDelivery, matrixOutboxScheduler, matrixRoomWatchService }: ApiContainerCradle) => {
      const canonicalSource = matrixCanonicalRoomSource;
      const issuer = config.solidBaseUrl ?? config.publicUrl;
      return new PodMatrixStore({
        serverGroupReconcilerService,
        podAccess: ownerPodAccess,
        // Creation qualifies ownership against the deployment's own Pod registry, with the caller's
        // own authenticated fetch. A missing registry leaves the port absent, so creation fails
        // closed instead of writing under an owner nobody registered.
        ...(canonicalSource ? { canonicalSource } : {}),
        ...(canonicalSource && taskCredentialStore && issuer ? {
          membershipAuthorityPublisher: new MembershipAuthorityPublisher({
            canonicalSource, credentials: taskCredentialStore, podAccess: ownerPodAccess, issuer,
          }),
        } : {}),
        ...(matrixOutboundDelivery && matrixOutboxScheduler ? {
          publicationOutboxFor: (write: import('../matrix/podAccess').MatrixPodWrite, context: import('../matrix/types').MatrixStoreContext) =>
            createSchedulingOutbox({
              outbox: new MatrixOutbox({
                store: new PodMatrixOutboundStore({ publicationCaller: context, handleFor: async(scope) =>
                  scope === context.podUrl ? { scope, write } : undefined }),
                send: async(input) => await matrixOutboundDelivery.sender.send(input),
              }),
              schedule: () => { matrixOutboxScheduler.schedule(); },
            }),
        } : {}),
        // O1: queue each outbound batch under the participant whose event it carries, so delivery
        // authenticates as that participant's current grant instead of a deployment signature.
        deliverAsActor: true,
        // Registering participants only makes sense while the deployment itself can sign:
        // an unserved participant falls back to the deployment name, and a registry
        // without that identity would refuse their writes instead of signing nothing.
        identities: config.matrixServiceIdentity ? matrixSigningIdentities : undefined,
        participantIdentity: config.matrixServiceIdentity ? matrixParticipantIdentity : undefined,
        // A write is the first signal: delivery starts as soon as something is queued, without
        // the write waiting for it. The scheduler serializes and coalesces, so a burst of writes
        // costs one pass.
        outbound: matrixOutboundDelivery && matrixOutboxScheduler
          ? createSchedulingOutbox({ outbox: matrixOutboundDelivery.outbox, schedule: () => { matrixOutboxScheduler.schedule(); } })
          : undefined,
        // What tells a sync which rooms changed, so an idle caller reads nothing. Absent means
        // every sync reads every room, which is the behaviour without a watch service.
        ...(matrixRoomWatchService ? { roomChanges: matrixRoomWatchService } : {}),
        // Joining a room another deployment hosts: the specification's handshake, signed as the
        // participant whose Pod is being written. Without a delivery there is no client to ask with,
        // and the join falls back to the local event plus delivery.
        ...(matrixOutboundDelivery ? {
          directoryQuery: async ({ roomAlias, destination, context }) => {
            const serverName = webIdServerName(context.webId);
            const client = serverName ? await matrixOutboundDelivery.sender.clientFor(serverName) : undefined;
            if (!client) return undefined;
            const answer = await client.queryDirectory({ destination, roomAlias });
            return answer.status === 'ok' ? answer.roomId : undefined;
          },
          remoteJoin: async ({ roomId, userId, destination, context, pending }) => {
            const serverName = webIdServerName(context.webId);
            if (!serverName) return undefined;
            const client = await matrixOutboundDelivery.sender.clientFor(serverName);
            const identity = client ? await matrixSigningIdentities.identityFor(serverName).catch(() => undefined) : undefined;
            if (!client || !identity) return undefined;
            return await joinRoomOverFederation({
              client,
              roomId,
              userId,
              destination,
              serverName,
              sign: event => identity.signEvent(event),
              ...(pending === undefined ? {} : { pending }),
            });
          },
        } : {}),
        journal: new SqlMatrixEventJournal(db),
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
