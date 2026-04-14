/**
 * Provision Handler
 *
 * Cloud 端的 SP 注册 API
 *
 * POST /provision/nodes  - SP 注册（公开，无需认证）
 *   返回 nodeId、nodeToken、serviceToken、provisionCode（自包含 JWT）
 *
 * provisionCode 是自包含 token，编码了 SP 的 publicUrl 和 serviceToken。
 * CSS 侧的 ProvisionPodCreator 解码后直接回调 SP，不需要查数据库。
 *
 * GET /provision/status  - Local 端 SP 状态查询（公开）
 *   返回 SP 配置状态，供 Linx 查询
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { DdnsRepository } from '../../identity/drizzle/DdnsRepository';
import type { TunnelProvider, TunnelConfig } from '../../tunnel/TunnelProvider';
import { ProvisionCodeCodec } from '../../provision/ProvisionCodeCodec';

export interface ProvisionHandlerOptions {
  repository: EdgeNodeRepository;
  ddnsRepo?: DdnsRepository;
  tunnelProvider?: TunnelProvider;
  /** Cloud baseUrl，用于派生 provisionCode 签名密钥 */
  baseUrl: string;
  /** 节点域名根域名，如 "undefineds.site" */
  baseStorageDomain?: string;
  /** provisionCode 有效期（秒），默认 24 小时 */
  provisionCodeTtl?: number;
}

/** 默认 24 小时 */
const DEFAULT_TTL = 24 * 60 * 60;

export function registerProvisionRoutes(
  server: ApiServer,
  options: ProvisionHandlerOptions,
): void {
  const logger = getLoggerFor('ProvisionHandler');
  const { repository, baseUrl, baseStorageDomain } = options;
  const ttl = options.provisionCodeTtl ?? DEFAULT_TTL;
  const codec = new ProvisionCodeCodec(baseUrl);

  /**
   * POST /provision/nodes
   *
   * SP 注册端点（公开，SP 启动时调用，此时用户可能还没有 Cloud 账号）
   *
   * Request:
   *   { publicUrl: string, nodeId?: string, displayName?: string, ipv4?: string, serviceToken?: string }
   *
   * Response 201:
   *   { nodeId, nodeToken, serviceToken, provisionCode, spDomain? }
   */
  server.post('/provision/nodes', async (request, response) => {
    let body: {
      publicUrl?: string;
      nodeId?: string;
      displayName?: string;
      ipv4?: string;
      serviceToken?: string;
      localPort?: number;
    };
    try {
      body = await readJsonBody(request) as any ?? {};
    } catch {
      sendJson(response, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body.publicUrl) {
      sendJson(response, 400, { error: 'publicUrl is required' });
      return;
    }

    try {
      new URL(body.publicUrl);
    } catch {
      sendJson(response, 400, { error: 'Invalid publicUrl format' });
      return;
    }

    try {
      const result = await repository.registerSpNode({
        publicUrl: body.publicUrl,
        displayName: body.displayName,
        nodeId: body.nodeId,
        serviceToken: body.serviceToken,
      });

      const subdomainPrefix = baseStorageDomain
        ? result.nodeId.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63) || result.nodeId.split('-')[0]
        : undefined;
      const spDomain = subdomainPrefix
        ? `${subdomainPrefix}.${baseStorageDomain}`
        : undefined;
      const tunnelState = await ensureManagedTunnelState({
        repository,
        nodeId: result.nodeId,
        subdomainPrefix,
        publicUrl: body.publicUrl,
        localPort: body.localPort,
        ipv4: body.ipv4,
        ddnsRepo: options.ddnsRepo,
        tunnelProvider: options.tunnelProvider,
        baseStorageDomain,
      });

      if (body.ipv4 || subdomainPrefix) {
        await repository.updateNodeMode(result.nodeId, {
          accessMode: tunnelState?.mode === 'tunnel' ? 'proxy' : 'direct',
          ipv4: body.ipv4,
          subdomain: subdomainPrefix,
        });
      }

      // 生成自包含 provisionCode（编码了 SP 信息，CSS 解码后直接回调 SP）
      const provisionCode = codec.encode({
        spUrl: body.publicUrl,
        serviceToken: result.serviceToken,
        nodeId: result.nodeId,
        spDomain,
        exp: Math.floor(Date.now() / 1000) + ttl,
      });

      logger.info(`Registered SP node ${result.nodeId} at ${body.publicUrl}${spDomain ? `, spDomain: ${spDomain}` : ''}`);

      const responseBody: Record<string, unknown> = {
        nodeId: result.nodeId,
        nodeToken: result.nodeToken,
        serviceToken: result.serviceToken,
        provisionCode,
      };
      if (spDomain) {
        responseBody.spDomain = spDomain;
      }
      if (tunnelState?.tunnelConfig?.tunnelToken) {
        responseBody.tunnelToken = tunnelState.tunnelConfig.tunnelToken;
      }
      if (tunnelState?.tunnelConfig?.provider) {
        responseBody.tunnelProvider = tunnelState.tunnelConfig.provider;
      }
      if (tunnelState?.tunnelConfig?.endpoint) {
        responseBody.tunnelEndpoint = tunnelState.tunnelConfig.endpoint;
      }

      sendJson(response, 201, responseBody);
    } catch (error) {
      logger.error(`Failed to register SP node: ${error}`);
      sendJson(response, 500, { error: 'Failed to register SP node' });
    }
  }, { public: true });

  logger.info('Provision routes registered');
}

interface ManagedTunnelState {
  mode: 'direct' | 'tunnel';
  tunnelConfig?: TunnelConfig;
}

async function ensureManagedTunnelState(options: {
  repository: EdgeNodeRepository;
  ddnsRepo?: DdnsRepository;
  tunnelProvider?: TunnelProvider;
  nodeId: string;
  subdomainPrefix?: string;
  baseStorageDomain?: string;
  publicUrl: string;
  localPort?: number;
  ipv4?: string;
}): Promise<ManagedTunnelState | undefined> {
  const {
    repository,
    ddnsRepo,
    tunnelProvider,
    nodeId,
    subdomainPrefix,
    baseStorageDomain,
    publicUrl,
    localPort,
    ipv4,
  } = options;

  if (!subdomainPrefix || !baseStorageDomain) {
    return undefined;
  }

  const mode: 'direct' | 'tunnel' = ipv4 ? 'direct' : 'tunnel';

  if (ddnsRepo) {
    const existing = await ddnsRepo.getRecord(subdomainPrefix);
    if (!existing) {
      await ddnsRepo.allocateSubdomain({
        subdomain: subdomainPrefix,
        domain: baseStorageDomain,
        nodeId,
        ipAddress: ipv4,
      });
    }
  }

  if (mode === 'direct' || !tunnelProvider || !localPort || localPort <= 0) {
    return { mode };
  }

  const metadataRecord = await repository.getNodeMetadata(nodeId);
  const metadata = metadataRecord?.metadata as Record<string, unknown> | null;
  const existingTunnel = readManagedTunnelConfig(metadata);
  if (existingTunnel && existingTunnel.subdomain === subdomainPrefix && existingTunnel.localPort === localPort) {
    return {
      mode,
      tunnelConfig: existingTunnel.config,
    };
  }

  const tunnelConfig = await tunnelProvider.setup({
    subdomain: subdomainPrefix,
    localPort,
  });

  await repository.mergeNodeMetadata(nodeId, {
    managedTunnel: {
      provider: tunnelConfig.provider,
      tunnelId: tunnelConfig.tunnelId,
      tunnelToken: tunnelConfig.tunnelToken,
      endpoint: tunnelConfig.endpoint,
      subdomain: subdomainPrefix,
      localPort,
      configuredAt: new Date().toISOString(),
    },
    publicAddress: tunnelConfig.endpoint || publicUrl,
  });

  return {
    mode,
    tunnelConfig,
  };
}

function readManagedTunnelConfig(metadata: Record<string, unknown> | null): { subdomain?: string; localPort?: number; config: TunnelConfig } | undefined {
  const raw = metadata?.managedTunnel;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  const provider = value.provider;
  const endpoint = value.endpoint;
  const tunnelToken = value.tunnelToken;
  const tunnelId = value.tunnelId;
  const subdomain = typeof value.subdomain === 'string' ? value.subdomain : undefined;
  const localPort = typeof value.localPort === 'number' ? value.localPort : undefined;

  if (
    (provider !== 'cloudflare' && provider !== 'frp' && provider !== 'sakura-frp')
    || typeof endpoint !== 'string'
  ) {
    return undefined;
  }

  return {
    subdomain,
    localPort,
    config: {
      provider,
      subdomain: subdomain ?? 'local',
      endpoint,
      tunnelId: typeof tunnelId === 'string' ? tunnelId : undefined,
      tunnelToken: typeof tunnelToken === 'string' ? tunnelToken : undefined,
    },
  };
}

/**
 * Local 端 SP 状态查询路由
 */
export interface ProvisionStatusOptions {
  /** Cloud API 端点 */
  cloudUrl?: string;
  /** 节点 ID */
  nodeId?: string;
  /** SP 子域名 */
  spDomain?: string;
  /** Cloud baseUrl，用于拼 provisionUrl */
  cloudBaseUrl?: string;
  /** provisionCode（可选，由环境变量传入） */
  provisionCode?: string;
}

export function registerProvisionStatusRoute(
  server: ApiServer,
  options: ProvisionStatusOptions,
): void {
  const logger = getLoggerFor('ProvisionStatusHandler');

  server.get('/provision/status', async (_request, response) => {
    const registered = Boolean(options.nodeId && options.cloudUrl);

    const body: Record<string, unknown> = {
      registered,
    };

    if (registered) {
      body.cloudUrl = options.cloudUrl;
      body.nodeId = options.nodeId;
      if (options.spDomain) {
        body.spDomain = options.spDomain;
      }
      if (options.cloudBaseUrl) {
        const provisionUrl = options.provisionCode
          ? `${options.cloudBaseUrl.replace(/\/$/, '')}/.account/?provisionCode=${encodeURIComponent(options.provisionCode)}`
          : `${options.cloudBaseUrl.replace(/\/$/, '')}/.account/`;
        body.provisionUrl = provisionUrl;
      }
    }

    sendJson(response, 200, body);
  }, { public: true });

  logger.info('Provision status route registered');
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
