/**
 * API Container 依赖类型定义
 *
 * 定义容器中注册的所有服务接口
 */

import type { ApiServer } from '../ApiServer';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { Authenticator } from '../auth/Authenticator';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';
import type { VercelChatService } from '../service/VercelChatService';
import type { SubdomainService } from '../../subdomain/SubdomainService';
import type { SubdomainClient } from '../../subdomain/SubdomainClient';
import type { DnsProvider } from '../../dns/DnsProvider';
import type { TunnelProvider } from '../../tunnel/TunnelProvider';
import type { IdentityDatabase } from '../../identity/drizzle/db';
import type { WebIdProfileRepository } from '../../identity/drizzle/WebIdProfileRepository';
import type { DdnsRepository } from '../../identity/drizzle/DdnsRepository';
import type { ChatKitService, AiProvider } from '../chatkit';
import type { StoreContext } from '../chatkit/store';
import type { PodChatKitStore } from '../chatkit/pod-store';

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

  /** 数据库连接 URL */
  databaseUrl: string;

  /** CORS 允许的源 */
  corsOrigins: string[];

  /** 加密密钥 */
  encryptionKey: string;

  /** CSS Token 端点 */
  cssTokenEndpoint: string;

  /** 子域名功能配置 (cloud 模式) */
  subdomain?: {
    enabled: boolean;
    baseDomain?: string;
    /** DDNS 服务使用的域名 (如 undefineds.xyz) */
    ddnsDomain?: string;
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

  /** OIDC Issuer URL (local 托管式，使用 Cloud IdP) */
  oidcIssuer?: string;

  /** Cloudflare Tunnel Token (local 托管式/自管式，启动 cloudflared) */
  cloudflareTunnelToken?: string;

  /** SakuraFRP Token (local 托管式/自管式，启动 frpc) */
  sakuraToken?: string;

  /** 是否接受 Edge 节点注册 (cloud 模式) */
  edgeNodesEnabled?: boolean;
}

import { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
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
  apiKeyStore: DrizzleClientCredentialsStore;

  // 业务服务
  chatService: VercelChatService;

  // ChatKit 服务 (OpenAI ChatKit 协议)
  chatKitStore: PodChatKitStore;
  chatKitAiProvider: AiProvider;
  chatKitService: ChatKitService<StoreContext>;

  // Cloud 模式: 身份服务
  webIdProfileRepo?: WebIdProfileRepository;
  ddnsRepo?: DdnsRepository;

  // 子域名相关 (可选，按 edition 注册)
  // Cloud 模式 或 Local 自管模式
  dnsProvider?: DnsProvider;
  dnsCoordinator?: EdgeNodeDnsCoordinator;
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
