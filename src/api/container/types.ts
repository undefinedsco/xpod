/**
 * API Container 依赖类型定义
 *
 * 定义容器中注册的所有服务接口
 */

import type { ApiServer } from '../ApiServer';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { Authenticator } from '../auth/Authenticator';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { ServiceTokenRepositoryPort } from '../../identity/drizzle/ServiceTokenRepository';
import type { VercelChatService } from '../service/VercelChatService';
import type { SubdomainService } from '../../subdomain/SubdomainService';
import type { SubdomainClient } from '../../subdomain/SubdomainClient';
import type { DnsProvider } from '../../dns/DnsProvider';
import type { TunnelProvider } from '../../tunnel/TunnelProvider';
import type { ActiveTunnelProvider, TunnelProfile } from '../../tunnel/TunnelProfiles';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import type { DdnsRepository } from '../../identity/drizzle/DdnsRepository';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import type { ChatKitService, AiProvider } from '../chatkit';
import type { StoreContext } from '../chatkit/store';
import type { PodChatKitStore } from '../chatkit/pod-store';
import type { RuntimeHost } from '../../runtime/host/types';
import type { ProviderRegistry, EmbeddingService } from '../../ai/service';
import type { VectorService } from '../service/VectorService';
import type { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import type { EmbeddedInngestRuntimeConfig } from '../runs/EmbeddedInngestService';
import type { RunAuthContextRegistry } from '../runs/RunAuthContextRegistry';
import type { TaskAuthBindingService, TaskService, InngestTaskScheduler } from '../tasks';
import type { PodMatrixStore } from '../matrix';
import type { ClientReconcilerCoordinator, ServerGroupReconcilerService } from '../reconciler';
import type { AuthMode } from '../../authorization/AuthMode';

/**
 * 容器配置
 */
export interface ApiContainerConfig {
  /** 运行模式: cloud 持有密钥, local 调用远程 */
  edition: 'cloud' | 'local';

  /** API Server 端口 */
  port: number;

  /** API Server 主机 */
  host: string;

  /** API Server Unix socket 路径 */
  socketPath?: string;

  /** Runtime host implementation */
  runtimeHost?: RuntimeHost;

  /** Solid authorization mode used by CSS and SP-local Pod provisioning. */
  authMode: AuthMode;

  /** RDF term-id index used by CSS LDP structured reads. */
  rdfIndexPath?: string;

  /** 数据库连接 URL */
  databaseUrl: string;

  /** Redis connection URL, used by embedded infrastructure such as Inngest in cloud mode. */
  redisUrl?: string;

  /** Embedded Inngest runtime configuration. */
  inngest?: {
    enabled: boolean;
    mode?: 'managed' | 'spawn';
    port?: number;
    host?: string;
    baseUrl?: string;
    eventKey?: string;
    signingKey?: string;
    binaryPath?: string;
    sqliteDir?: string;
  };

  /** Resolved runtime config passed from API bootstrap after starting/locating Inngest. */
  inngestRuntimeConfig?: EmbeddedInngestRuntimeConfig;

  /** CORS 允许的源 */
  corsOrigins: string[];

  /** CSS Token 端点 */
  cssTokenEndpoint: string;

  /** 子域名功能配置 (cloud 模式) */
  subdomain?: {
    /** 节点域名根域名 (如 undefineds.site)，有值即启用子域名功能 */
    baseStorageDomain?: string;
    cloudflareAccountId?: string;
    cloudflareApiToken?: string;
    tencentDnsSecretId?: string;
    tencentDnsSecretKey?: string;
  };

  /** Cloud API 端点 (local 托管式，调用 cloud 的子域名 API) */
  cloudApiEndpoint?: string;

  /** 节点 ID (local 托管式) */
  nodeId?: string;

  /** 节点 Token (local 托管式，调用 Cloud API 的认证) */
  nodeToken?: string;

  /** Local SP service token（Cloud 回调 Local、Local 服务级 API 的唯一服务凭据） */
  serviceToken?: string;

  /** 已签发的 provisionCode（Local 首次注册/刷新后持久化恢复） */
  provisionCode?: string;

  /** Local canonical public URL（通常来自 CSS_BASE_URL，也可从 setup 恢复） */
  publicUrl?: string;

  /** Cloud 分配或用户指定的 SP 域名 */
  spDomain?: string;

  /** Local setup/provision 状态文件路径 */
  localSetupPath?: string;

  /** Local setup/provision 状态文件中的 provider key */
  localSetupProviderId?: string;

  /** OIDC Issuer URL (local 托管式，使用 Cloud IdP) */
  oidcIssuer?: string;

  /** Active tunnel provider after resolving profile selection. */
  tunnelProvider?: ActiveTunnelProvider;

  /** Recorded tunnel profiles. Only tunnelActiveProfileId/activeTunnelProfile takes effect at runtime. */
  tunnelProfiles?: TunnelProfile[];

  /** Selected tunnel profile id. */
  tunnelActiveProfileId?: string;

  /** Selected tunnel profile. */
  activeTunnelProfile?: TunnelProfile;

  /** Cloudflare Tunnel Token (local 托管式/自管式，启动 cloudflared) */
  cloudflareTunnelToken?: string;

  /** SakuraFRP Tunnel Token (SAKURA_TUNNEL_TOKEN；local 托管式/自管式，启动 frpc) */
  sakuraTunnelToken?: string;

  /** ngrok authtoken (local only; not sent to Cloud). */
  ngrokAuthToken?: string;

  /** Fixed ngrok endpoint/custom domain, e.g. https://example.ngrok-free.dev. */
  ngrokUrl?: string;

  /** ngrok executable path. */
  ngrokPath?: string;

  /** 是否接受 Edge 节点注册 (cloud 模式) */
  edgeNodesEnabled?: boolean;
}

import { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import { EdgeNodeHealthProbeService } from '../../edge/EdgeNodeHealthProbeService';
import { EdgeNodeCapabilityDetector } from '../../edge/EdgeNodeCapabilityDetector';
import { LocalNetworkManager } from '../../edge/LocalNetworkManager';
import { DdnsManager } from '../../edge/DdnsManager';

/**
 * 容器中注册的所有服务
 */
export interface ApiContainerCradle {
  // 配置
  config: ApiContainerConfig;

  // 核心服务
  db: IdentityDatabase;
  apiServer: ApiServer;
  authMiddleware: AuthMiddleware;
  authenticator: Authenticator;

  // 仓库
  nodeRepo: EdgeNodeRepository;
  serviceTokenRepo: ServiceTokenRepositoryPort;

  // 业务服务
  chatService: VercelChatService;

  // ChatKit 服务 (OpenAI ChatKit 协议)
  chatKitStore: PodChatKitStore;
  chatKitAiProvider: AiProvider;
  inngestRuntimeConfig: EmbeddedInngestRuntimeConfig | undefined;
  runAuthContextRegistry: RunAuthContextRegistry;
  runExecutionBackend: InngestRunExecutionBackend;
  taskAuthBindingService: TaskAuthBindingService<StoreContext>;
  taskService: TaskService<StoreContext>;
  inngestTaskScheduler: InngestTaskScheduler<StoreContext>;
  chatKitService: ChatKitService<StoreContext>;
  matrixStore: PodMatrixStore;
  clientReconcilerCoordinator: ClientReconcilerCoordinator;
  serverGroupReconcilerService: ServerGroupReconcilerService;
  providerRegistry: ProviderRegistry;
  embeddingService: EmbeddingService;
  vectorService: VectorService;

  // Cloud 模式: 身份服务
  ddnsRepo?: DdnsRepository;
  podLookupRepo?: PodLookupRepository;

  // 子域名相关 (可选，按 edition 注册)
  // Cloud 模式 或 Local 自管模式
  dnsProvider?: DnsProvider;
  dnsCoordinator?: EdgeNodeDnsCoordinator;
  healthProbeService?: EdgeNodeHealthProbeService;
  capabilityDetector?: EdgeNodeCapabilityDetector;
  localNetworkManager?: LocalNetworkManager;

  tunnelProvider?: TunnelProvider;
  subdomainService?: SubdomainService;
  // Local 托管式
  subdomainClient?: SubdomainClient;
  // Local 托管式 DDNS 管理
  ddnsManager?: DdnsManager;
  // Local 托管式/自管式 (启动 cloudflared)
  localTunnelProvider?: TunnelProvider;
}
