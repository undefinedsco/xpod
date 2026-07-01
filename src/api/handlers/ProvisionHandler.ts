/**
 * Provision Handler
 *
 * Cloud 端的 SP 注册 API
 *
 * POST /provision/nodes  - SP 注册（公开，无需认证）
 *   返回 nodeId、nodeToken、serviceToken、provisionCode（自包含 JWT）
 *
 * provisionCode 是自包含 token，编码了 SP 的 publicUrl 和短期 serviceAccessToken。
 * CSS 侧的 ProvisionPodCreator 解码后直接回调 SP，不需要查数据库。
 *
 * GET /provision/status  - Local 端 SP 状态查询（公开）
 *   返回 SP 配置状态，供 Linx 查询
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { DdnsRepository } from '../../identity/drizzle/DdnsRepository';
import type { DnsProvider } from '../../dns/DnsProvider';
import type { TunnelProvider, TunnelConfig } from '../../tunnel/TunnelProvider';
import { ProvisionCodeCodec } from '../../provision/ProvisionCodeCodec';
import { createServiceAccessToken } from '../../provision/ServiceAccessTokenCodec';
import { resolveLocalSetupPath, resolveLocalSetupProviderId, upsertLocalProvisionState } from '../../provision/LocalProvisionState';

export interface ProvisionHandlerOptions {
  repository: EdgeNodeRepository;
  ddnsRepo?: DdnsRepository;
  dnsProvider?: DnsProvider;
  tunnelProvider?: TunnelProvider;
  /** Cloud baseUrl，用于派生 provisionCode 签名密钥 */
  baseUrl: string;
  /** 节点域名根域名，如 "undefineds.site" */
  baseStorageDomain?: string;
  /** provisionCode 有效期（秒），默认 24 小时 */
  provisionCodeTtl?: number;
  /** Cloud → Local 回调 access token 有效期（秒），默认 15 分钟 */
  serviceAccessTokenTtl?: number;
}

/** 默认 24 小时 */
const DEFAULT_TTL = 24 * 60 * 60;
const DEFAULT_SERVICE_ACCESS_TOKEN_TTL = 15 * 60;
const PROVISION_STATUS_REFRESH_GRACE_SECONDS = 5 * 60;

export function registerProvisionRoutes(
  server: ApiServer,
  options: ProvisionHandlerOptions,
): void {
  const logger = getLoggerFor('ProvisionHandler');
  const { repository, baseUrl, baseStorageDomain } = options;
  const ttl = options.provisionCodeTtl ?? DEFAULT_TTL;
  const serviceAccessTokenTtl = options.serviceAccessTokenTtl ?? DEFAULT_SERVICE_ACCESS_TOKEN_TTL;
  const codec = new ProvisionCodeCodec(baseUrl);

  /**
   * POST /provision/nodes
   *
   * SP 注册端点（公开，SP 启动时调用，此时用户可能还没有 Cloud 账号）
   *
   * Request:
   *   {
   *     publicUrl?: string,
   *     nodeId?: string,
   *     displayName?: string,
   *     ipv4?: string,
   *     serviceToken?: string,
   *     domainMode?: 'managed' | 'self-managed',
   *     spDomain?: string,
   *     localPort?: number,
   *     tunnelToken?: string
   *   }
   *
   * Response 201:
   *   { nodeId, nodeToken, serviceToken, provisionCode, spDomain? }
   */
  server.post('/provision/nodes', async (request, response) => {
    let body: {
      publicUrl?: string;
      nodeId?: string;
      nodeToken?: string;
      displayName?: string;
      ipv4?: string;
      serviceToken?: string;
      localPort?: number;
      tunnelToken?: string;
      tunnelMode?: 'client';
      domainMode?: 'managed' | 'self-managed';
      spDomain?: string;
    };
    try {
      body = await readJsonBody(request) as any ?? {};
    } catch {
      sendJson(response, 400, { error: 'Invalid JSON body' });
      return;
    }

    try {
      const domainMode = body.domainMode === 'self-managed' ? 'self-managed' : 'managed';
      const requestedManagedDomain = normalizeRequestedManagedDomain(body.spDomain, baseStorageDomain);
      const shouldAllocateManagedPublicUrl = !body.publicUrl && domainMode === 'managed' && Boolean(baseStorageDomain);
      const preallocatedNodeId = shouldAllocateManagedPublicUrl
        ? (body.nodeId ?? randomUUID())
        : undefined;
      const preallocatedSubdomainPrefix = preallocatedNodeId
        ? resolveManagedSubdomainPrefix({
            domainMode,
            baseStorageDomain,
            requestedManagedDomain,
            nodeId: preallocatedNodeId,
          })
        : undefined;
      const preallocatedSpDomain = preallocatedSubdomainPrefix
        ? `${preallocatedSubdomainPrefix}.${baseStorageDomain}`
        : undefined;
      const effectivePublicUrl = body.publicUrl ?? derivePublicUrlFromSpDomain(preallocatedSpDomain);

      if (!effectivePublicUrl) {
        sendJson(response, 400, { error: 'publicUrl is required' });
        return;
      }

      if (preallocatedSubdomainPrefix && baseStorageDomain && options.ddnsRepo) {
        const existing = await options.ddnsRepo.getRecord(preallocatedSubdomainPrefix);
        if (existing?.nodeId && existing.nodeId !== preallocatedNodeId) {
          sendJson(response, 409, {
            error: 'spDomain already allocated',
            spDomain: preallocatedSpDomain,
          });
          return;
        }
      }

      try {
        new URL(effectivePublicUrl);
      } catch {
        sendJson(response, 400, { error: 'Invalid publicUrl format' });
        return;
      }

      const result = await repository.registerSpNode({
        publicUrl: effectivePublicUrl,
        displayName: body.displayName,
        nodeId: preallocatedNodeId ?? body.nodeId,
        nodeToken: body.nodeToken,
        serviceToken: body.serviceToken,
      });

      const subdomainPrefix = preallocatedSubdomainPrefix
        ?? resolveManagedSubdomainPrefix({
          domainMode,
          baseStorageDomain,
          requestedManagedDomain,
          nodeId: result.nodeId,
        });
      const spDomain = subdomainPrefix
        ? `${subdomainPrefix}.${baseStorageDomain}`
        : undefined;
      const managedPublicUrl = derivePublicUrlFromSpDomain(spDomain);
      const provisionSpUrl = body.publicUrl ?? managedPublicUrl ?? effectivePublicUrl;
      const tunnelState = await ensureManagedTunnelState({
        repository,
        nodeId: result.nodeId,
        subdomainPrefix,
        publicUrl: provisionSpUrl,
        localPort: body.localPort,
        ipv4: body.ipv4,
        tunnelToken: body.tunnelToken,
        ddnsRepo: options.ddnsRepo,
        dnsProvider: options.dnsProvider,
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

      // 生成自包含 provisionCode（编码 SP 信息和短期 serviceAccessToken，长期 serviceToken 只保留给 Local 持久化/刷新）
      const nowSeconds = Math.floor(Date.now() / 1000);
      const accessTtl = Math.min(ttl, serviceAccessTokenTtl);
      const serviceAccessTokenExp = nowSeconds + accessTtl;
      const serviceAccessToken = createServiceAccessToken({
        serviceToken: result.serviceToken,
        subject: result.nodeId,
        scopes: ['pod:provision', 'webid:lookup'],
        expiresAt: serviceAccessTokenExp,
      });
      const provisionCode = codec.encode({
        spUrl: provisionSpUrl,
        serviceAccessToken,
        serviceAccessTokenExp,
        nodeId: result.nodeId,
        spDomain,
        exp: serviceAccessTokenExp,
      });

      logger.info(`Registered SP node ${result.nodeId} at ${provisionSpUrl}${spDomain ? `, spDomain: ${spDomain}` : ''}`);

      const responseBody: Record<string, unknown> = {
        nodeId: result.nodeId,
        nodeToken: result.nodeToken,
        serviceToken: result.serviceToken,
        provisionCode,
      };
      if (managedPublicUrl) {
        responseBody.publicUrl = managedPublicUrl;
      }
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
      if (error instanceof InvalidTunnelTokenError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
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

class InvalidTunnelTokenError extends Error {}

async function ensureManagedTunnelState(options: {
  repository: EdgeNodeRepository;
  ddnsRepo?: DdnsRepository;
  dnsProvider?: DnsProvider;
  tunnelProvider?: TunnelProvider;
  nodeId: string;
  subdomainPrefix?: string;
  baseStorageDomain?: string;
  publicUrl: string;
  localPort?: number;
  ipv4?: string;
  tunnelToken?: string;
}): Promise<ManagedTunnelState | undefined> {
  const {
    repository,
    ddnsRepo,
    dnsProvider,
    tunnelProvider,
    nodeId,
    subdomainPrefix,
    baseStorageDomain,
    publicUrl,
    localPort,
    ipv4,
    tunnelToken,
  } = options;

  if (!subdomainPrefix || !baseStorageDomain) {
    return undefined;
  }

  const mode: 'direct' | 'tunnel' = ipv4 ? 'direct' : 'tunnel';

  if (mode === 'direct') {
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

    return { mode };
  }

  if (tunnelToken) {
    if (!localPort || localPort <= 0) {
      throw new InvalidTunnelTokenError('localPort is required when tunnelToken is provided');
    }

    return {
      mode,
      tunnelConfig: await ensureManagedTokenTunnelState({
        repository,
        ddnsRepo,
        dnsProvider,
        nodeId,
        subdomainPrefix,
        baseStorageDomain,
        publicUrl,
        localPort,
        tunnelToken,
      }),
    };
  }

  if (ddnsRepo) {
    const existing = await ddnsRepo.getRecord(subdomainPrefix);
    if (!existing) {
      await ddnsRepo.allocateSubdomain({
        subdomain: subdomainPrefix,
        domain: baseStorageDomain,
        nodeId,
      });
    }
  }

  if (!tunnelProvider || !localPort || localPort <= 0) {
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
  });

  return {
    mode,
    tunnelConfig,
  };
}

async function ensureManagedTokenTunnelState(options: {
  repository: EdgeNodeRepository;
  ddnsRepo?: DdnsRepository;
  dnsProvider?: DnsProvider;
  nodeId: string;
  subdomainPrefix: string;
  baseStorageDomain: string;
  publicUrl: string;
  localPort: number;
  tunnelToken: string;
}): Promise<TunnelConfig> {
  const {
    repository,
    ddnsRepo,
    dnsProvider,
    nodeId,
    subdomainPrefix,
    baseStorageDomain,
    publicUrl,
    localPort,
    tunnelToken,
  } = options;

  const parsed = parseCloudflareTunnelToken(tunnelToken);
  if (!parsed?.tunnelId) {
    throw new InvalidTunnelTokenError('Invalid Cloudflare tunnel token');
  }

  const endpoint = `https://${subdomainPrefix}.${baseStorageDomain}`;
  const cnameTarget = `${parsed.tunnelId}.cfargotunnel.com`;

  if (ddnsRepo) {
    const existing = await ddnsRepo.getRecord(subdomainPrefix);
    if (!existing) {
      await ddnsRepo.allocateSubdomain({
        subdomain: subdomainPrefix,
        domain: baseStorageDomain,
        nodeId,
        ipAddress: cnameTarget,
        recordType: 'CNAME',
      });
    } else if (
      existing.recordType !== 'CNAME'
      || existing.ipAddress !== cnameTarget
      || existing.ipv6Address
    ) {
      await ddnsRepo.updateRecordIp(subdomainPrefix, {
        ipAddress: cnameTarget,
        ipv6Address: null,
        recordType: 'CNAME',
      });
    }
  }

  if (dnsProvider) {
    await dnsProvider.upsertRecord({
      domain: baseStorageDomain,
      subdomain: subdomainPrefix,
      type: 'CNAME',
      value: cnameTarget,
      ttl: 60,
    });
  }

  const config: TunnelConfig = {
    provider: 'cloudflare',
    subdomain: subdomainPrefix,
    endpoint,
    tunnelId: parsed.tunnelId,
    tunnelToken,
  };

  await repository.mergeNodeMetadata(nodeId, {
    managedTunnel: {
      provider: config.provider,
      tunnelId: config.tunnelId,
      tunnelToken: config.tunnelToken,
      endpoint: config.endpoint,
      subdomain: subdomainPrefix,
      localPort,
      configuredAt: new Date().toISOString(),
      source: 'client-token',
    },
  });

  return config;
}

function parseCloudflareTunnelToken(token: string): { accountId?: string; tunnelId?: string } | undefined {
  const decoded = decodeJsonBase64UrlSegment(token) ?? decodeJsonBase64UrlSegment(token.split('.')[0] ?? '');
  if (!decoded || typeof decoded !== 'object') {
    return undefined;
  }

  const value = decoded as Record<string, unknown>;
  return {
    accountId: typeof value.a === 'string' ? value.a : undefined,
    tunnelId: typeof value.t === 'string' ? value.t : undefined,
  };
}

function decodeJsonBase64UrlSegment(segment: string): unknown {
  if (!segment) {
    return undefined;
  }

  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    const json = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
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
  /** 节点 Token */
  nodeToken?: string;
  /** SP service token，刷新 provisionCode 时回传给 Cloud */
  serviceToken?: string;
  /** 当前 SP canonical public URL */
  publicUrl?: string;
  /** SP 子域名 */
  spDomain?: string;
  /** 本地端口，供 Cloud 管理 tunnel 元数据 */
  localPort?: number;
  /** tunnel token，供 Cloud 维护托管域名连通性 */
  tunnelToken?: string;
  /** Cloud baseUrl，用于拼 provisionUrl */
  cloudBaseUrl?: string;
  /** provisionCode（可选，由环境变量传入） */
  provisionCode?: string;
  /** Persist refreshed local-only setup state to the single local setup file. */
  persistState?: (state: ProvisionStatusStateUpdate) => Promise<void> | void;
  /** 测试/调试注入 */
  fetchImpl?: typeof fetch;
  now?: () => number;
  refreshGraceSeconds?: number;
}

export interface ProvisionStatusStateUpdate {
  nodeId: string;
  nodeToken: string;
  serviceToken: string;
  provisionCode: string;
  publicUrl?: string;
  spDomain?: string;
  cloudUrl?: string;
  cloudBaseUrl?: string;
}

export function registerProvisionStatusRoute(
  server: ApiServer,
  options: ProvisionStatusOptions,
): void {
  const logger = getLoggerFor('ProvisionStatusHandler');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const refreshGraceSeconds = options.refreshGraceSeconds ?? PROVISION_STATUS_REFRESH_GRACE_SECONDS;
  const state: ProvisionStatusState = {
    provisionCode: options.provisionCode,
    nodeId: options.nodeId,
    nodeToken: options.nodeToken,
    serviceToken: options.serviceToken,
    publicUrl: normalizeUrl(options.publicUrl),
    spDomain: options.spDomain,
  };
  let refreshPromise: Promise<void> | undefined;

  server.get('/provision/status', async (_request, response) => {
    const registered = Boolean(options.nodeId && options.nodeToken && options.cloudUrl);

    const body: Record<string, unknown> = {
      registered,
    };

    if (registered) {
      const canRefresh = canRefreshProvisionStatus(options, state);
      const currentNow = now();
      const fresh = isProvisionCodeFresh(state.provisionCode, currentNow, refreshGraceSeconds);
      const codeState = inspectProvisionCodeExpiration(state.provisionCode);
      if (!canRefresh && codeState.kind !== 'missing' && !isProvisionCodeUsable(state.provisionCode, currentNow)) {
        sendJson(response, 503, {
          registered: true,
          error: 'provision_refresh_unavailable',
          message: 'Local provision state is expired and cannot be refreshed. Please restart Local or try again.',
        });
        return;
      }

      if (canRefresh && !fresh) {
        let didRefresh = false;
        refreshPromise ??= refreshProvisionStatus({
          options,
          state,
          fetchImpl,
          logger,
        }).finally(() => {
          refreshPromise = undefined;
        });
        try {
          await refreshPromise;
          didRefresh = true;
        } catch (error) {
          logger.warn(`Failed to refresh provisionCode for ${state.nodeId}: ${error}`);
          if (!isProvisionCodeUsable(state.provisionCode, now())) {
            sendJson(response, 503, {
              registered: true,
              error: 'provision_refresh_failed',
              message: 'Local provision state could not be refreshed. Please restart Local or try again.',
            });
            return;
          }
        }
        if (didRefresh) {
          await persistProvisionStatusState(options, state, logger);
        }
      }

      body.cloudUrl = options.cloudUrl;
      body.nodeId = state.nodeId ?? options.nodeId;
      if (state.spDomain) {
        body.spDomain = state.spDomain;
      }
      if (state.publicUrl) {
        body.publicUrl = state.publicUrl;
      }
      if (state.provisionCode) {
        body.provisionCode = state.provisionCode;
      }
      if (options.cloudBaseUrl) {
        const provisionUrl = state.provisionCode
          ? `${options.cloudBaseUrl.replace(/\/$/, '')}/.account/?provisionCode=${encodeURIComponent(state.provisionCode)}`
          : `${options.cloudBaseUrl.replace(/\/$/, '')}/.account/`;
        body.provisionUrl = provisionUrl;
      }
    }

    sendJson(response, 200, body);
  }, { public: true });

  logger.info('Provision status route registered');
}

export function createLocalSetupProvisionStateWriter(
  setupPath: string | undefined,
  providerId: string | undefined,
): ProvisionStatusOptions['persistState'] | undefined {
  const targetPath = resolveLocalSetupPath(setupPath);
  const targetProviderId = resolveLocalSetupProviderId(providerId);
  return async (state): Promise<void> => {
    upsertLocalProvisionState(targetPath, targetProviderId, state);
  };
}

async function persistProvisionStatusState(
  options: ProvisionStatusOptions,
  state: ProvisionStatusState,
  logger: ReturnType<typeof getLoggerFor>,
): Promise<void> {
  if (!options.persistState || !state.nodeId || !state.nodeToken || !state.serviceToken || !state.provisionCode) {
    return;
  }

  try {
    await options.persistState({
      nodeId: state.nodeId,
      nodeToken: state.nodeToken,
      serviceToken: state.serviceToken,
      provisionCode: state.provisionCode,
      publicUrl: state.publicUrl,
      spDomain: state.spDomain,
      cloudUrl: options.cloudUrl,
      cloudBaseUrl: options.cloudBaseUrl,
    });
  } catch (error) {
    logger.warn(`Failed to persist refreshed local provision state: ${error}`);
  }
}

interface ProvisionStatusState {
  provisionCode?: string;
  nodeId?: string;
  nodeToken?: string;
  serviceToken?: string;
  publicUrl?: string;
  spDomain?: string;
}

interface ProvisionNodeRefreshResponse {
  nodeId: string;
  nodeToken: string;
  serviceToken: string;
  provisionCode: string;
  publicUrl?: string;
  spDomain?: string;
}

function canRefreshProvisionStatus(options: ProvisionStatusOptions, state: ProvisionStatusState): boolean {
  return Boolean(
    options.cloudUrl
    && state.nodeId
    && state.nodeToken
    && state.serviceToken
    && state.publicUrl,
  );
}

async function refreshProvisionStatus(options: {
  options: ProvisionStatusOptions;
  state: ProvisionStatusState;
  fetchImpl: typeof fetch;
  logger: ReturnType<typeof getLoggerFor>;
}): Promise<void> {
  const { options: statusOptions, state, fetchImpl, logger } = options;
  const endpoint = new URL('/provision/nodes', ensureTrailingSlash(statusOptions.cloudUrl!)).toString();
  const requestBody: Record<string, unknown> = {
    publicUrl: state.publicUrl,
    nodeId: state.nodeId,
    nodeToken: state.nodeToken,
    serviceToken: state.serviceToken,
    domainMode: state.spDomain ? 'managed' : 'self-managed',
    spDomain: state.spDomain,
  };

  if (statusOptions.localPort && statusOptions.localPort > 0) {
    requestBody.localPort = statusOptions.localPort;
  }
  if (statusOptions.tunnelToken) {
    requestBody.tunnelToken = statusOptions.tunnelToken;
    requestBody.tunnelMode = 'client';
  }

  const result = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!result.ok) {
    const detail = await result.text().catch(() => '');
    throw new Error(detail || `HTTP ${result.status}`);
  }

  const payload = await result.json().catch(() => undefined) as Partial<ProvisionNodeRefreshResponse> | undefined;
  if (
    !payload
    || typeof payload.nodeId !== 'string'
    || typeof payload.nodeToken !== 'string'
    || typeof payload.serviceToken !== 'string'
    || typeof payload.provisionCode !== 'string'
  ) {
    throw new Error('Cloud returned an incomplete provision refresh response.');
  }

  state.nodeId = payload.nodeId;
  state.nodeToken = payload.nodeToken;
  state.serviceToken = payload.serviceToken;
  state.provisionCode = payload.provisionCode;
  state.publicUrl = normalizeUrl(payload.publicUrl) ?? state.publicUrl;
  state.spDomain = typeof payload.spDomain === 'string' ? payload.spDomain : state.spDomain;

  process.env.XPOD_NODE_ID = state.nodeId;
  process.env.XPOD_NODE_TOKEN = state.nodeToken;
  process.env.XPOD_SERVICE_TOKEN = state.serviceToken;
  process.env.XPOD_PROVISION_CODE = state.provisionCode;
  if (statusOptions.cloudBaseUrl) {
    process.env.XPOD_PROVISION_URL = `${statusOptions.cloudBaseUrl.replace(/\/$/u, '')}/.account/?provisionCode=${encodeURIComponent(state.provisionCode)}`;
  }
  if (state.spDomain) {
    process.env.XPOD_SP_DOMAIN = state.spDomain;
  }

  logger.info(`Refreshed provisionCode for ${state.nodeId}`);
}

function isProvisionCodeFresh(code: string | undefined, nowMs: number, graceSeconds: number): boolean {
  const state = inspectProvisionCodeExpiration(code);
  return state.kind === 'self-contained' && state.expiresAt > Math.floor(nowMs / 1000) + graceSeconds;
}

function isProvisionCodeUsable(code: string | undefined, nowMs: number): boolean {
  const state = inspectProvisionCodeExpiration(code);
  if (state.kind === 'legacy') {
    return true;
  }
  return state.kind === 'self-contained' && state.expiresAt > Math.floor(nowMs / 1000);
}

function inspectProvisionCodeExpiration(code: string | undefined): { kind: 'missing' | 'legacy' | 'invalid' } | { kind: 'self-contained'; expiresAt: number } {
  if (!code) {
    return { kind: 'missing' };
  }
  const dotIndex = code.indexOf('.');
  if (dotIndex <= 0) {
    return { kind: 'legacy' };
  }

  try {
    const payload = JSON.parse(Buffer.from(code.slice(0, dotIndex), 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? { kind: 'self-contained', expiresAt: payload.exp }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    return new URL(value.trim()).toString().replace(/\/+$/u, '') + '/';
  } catch {
    return value.trim().replace(/\/+$/u, '') + '/';
  }
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

function derivePublicUrlFromSpDomain(spDomain: string | undefined): string | undefined {
  return spDomain ? `https://${spDomain}/` : undefined;
}

function normalizeRequestedManagedDomain(value: string | undefined, baseStorageDomain: string | undefined): string | undefined {
  if (!value || !baseStorageDomain) {
    return undefined;
  }

  const domain = value.trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '').replace(/\.$/u, '');
  const suffix = `.${baseStorageDomain.toLowerCase()}`;
  if (!domain.endsWith(suffix)) {
    return undefined;
  }

  const prefix = domain.slice(0, -suffix.length).replace(/[^a-z0-9-]/giu, '').slice(0, 63);
  if (!prefix) {
    return undefined;
  }

  return `${prefix}.${baseStorageDomain}`;
}

function resolveManagedSubdomainPrefix(options: {
  domainMode: 'managed' | 'self-managed';
  baseStorageDomain?: string;
  requestedManagedDomain?: string;
  nodeId: string;
}): string | undefined {
  if (options.domainMode !== 'managed' || !options.baseStorageDomain) {
    return undefined;
  }

  if (options.requestedManagedDomain) {
    const suffix = `.${options.baseStorageDomain}`;
    return options.requestedManagedDomain.slice(0, -suffix.length);
  }

  return options.nodeId.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63) || options.nodeId.split('-')[0];
}
