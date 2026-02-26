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
import { ProvisionCodeCodec } from '../../provision/ProvisionCodeCodec';

export interface ProvisionHandlerOptions {
  repository: EdgeNodeRepository;
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
   *   { publicUrl: string, nodeId?: string, displayName?: string, publicIp?: string, serviceToken?: string }
   *
   * Response 201:
   *   { nodeId, nodeToken, serviceToken, provisionCode, spDomain? }
   */
  server.post('/provision/nodes', async (request, response) => {
    let body: { publicUrl?: string; nodeId?: string; displayName?: string; publicIp?: string; serviceToken?: string };
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

      // 预分配子域名前缀（不创建 DNS 记录，延迟到心跳健康检查通过后）
      // DB 只存前缀，完整 FQDN 由 DnsCoordinator 的 rootDomain 拼接
      // 用 nodeId sanitize 后做前缀（去掉非 DNS 字符，截断到 63 字符）
      const subdomainPrefix = baseStorageDomain
        ? result.nodeId.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 63) || result.nodeId.split('-')[0]
        : undefined;
      const spDomain = subdomainPrefix
        ? `${subdomainPrefix}.${baseStorageDomain}`
        : undefined;

      // 如果提供了 publicIp，存入节点信息（供后续健康检查使用）
      if (body.publicIp || subdomainPrefix) {
        await repository.updateNodeMode(result.nodeId, {
          accessMode: 'direct',
          publicIp: body.publicIp,
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

      sendJson(response, 201, responseBody);
    } catch (error) {
      logger.error(`Failed to register SP node: ${error}`);
      sendJson(response, 500, { error: 'Failed to register SP node' });
    }
  }, { public: true });

  logger.info('Provision routes registered');
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
