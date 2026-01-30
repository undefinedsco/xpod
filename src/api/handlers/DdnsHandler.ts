/**
 * DDNS API Handler
 *
 * 提供 DDNS 服务的 HTTP API
 *
 * POST /api/v1/ddns/{subdomain}     - 更新 DNS 记录
 * GET  /api/v1/ddns/{subdomain}     - 查询 DNS 记录
 * POST /api/v1/ddns/allocate        - 分配子域名
 * DELETE /api/v1/ddns/{subdomain}   - 释放子域名
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { DdnsRepository } from '../../identity/drizzle/DdnsRepository';
import type { DnsProvider } from '../../dns/DnsProvider';

const logger = getLoggerFor('DdnsHandler');

export interface DdnsHandlerOptions {
  ddnsRepo: DdnsRepository;
  dnsProvider?: DnsProvider;
  defaultDomain: string;
}

export function registerDdnsRoutes(
  server: ApiServer,
  options: DdnsHandlerOptions,
): void {
  const { ddnsRepo, dnsProvider, defaultDomain } = options;

  /**
   * POST /api/v1/ddns/allocate
   *
   * 分配子域名
   *
   * Request body:
   * {
   *   "subdomain": "alice",
   *   "nodeId": "node-xxx",  // optional
   *   "ipAddress": "1.2.3.4"  // optional
   * }
   */
  server.post('/api/v1/ddns/allocate', async (request, response, _params) => {
    try {
      const body = await readJsonBody(request);
      const payload = body as {
        subdomain?: string;
        nodeId?: string;
        username?: string;
        ipAddress?: string;
        ipv6Address?: string;
      } | undefined;

      if (!payload?.subdomain) {
        sendError(response, 400, 'subdomain is required');
        return;
      }

      // 验证子域名格式
      if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(payload.subdomain)) {
        sendError(response, 400, 'Invalid subdomain format');
        return;
      }

      // 检查是否已存在
      const existing = await ddnsRepo.getRecord(payload.subdomain);
      if (existing) {
        sendError(response, 409, 'Subdomain already allocated');
        return;
      }

      const record = await ddnsRepo.allocateSubdomain({
        subdomain: payload.subdomain,
        domain: defaultDomain,
        nodeId: payload.nodeId,
        username: payload.username,
        ipAddress: payload.ipAddress,
        ipv6Address: payload.ipv6Address,
      });

      // 如果有 DNS Provider 且有 IP，创建 DNS 记录
      if (dnsProvider && (payload.ipAddress || payload.ipv6Address)) {
        try {
          await dnsProvider.upsertRecord({
            domain: defaultDomain,
            subdomain: payload.subdomain,
            type: payload.ipv6Address ? 'AAAA' : 'A',
            value: payload.ipv6Address ?? payload.ipAddress!,
            ttl: 60,
          });
          logger.info(`Created DNS record: ${payload.subdomain}.${defaultDomain}`);
        } catch (dnsError) {
          logger.error(`Failed to create DNS record: ${dnsError}`);
          // 不回滚数据库记录，DNS 可以稍后重试
        }
      }

      logger.info(`Allocated subdomain: ${payload.subdomain}.${defaultDomain}`);

      sendJson(response, 201, {
        success: true,
        subdomain: record.subdomain,
        domain: record.domain,
        fqdn: `${record.subdomain}.${record.domain}`,
        ipAddress: record.ipAddress,
        ipv6Address: record.ipv6Address,
        createdAt: record.createdAt.toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to allocate subdomain: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  /**
   * POST /api/v1/ddns/{subdomain}
   *
   * 更新 DNS 记录
   *
   * Request body:
   * {
   *   "ip": "1.2.3.4",
   *   "type": "A"  // optional, default: "A"
   * }
   */
  server.post('/api/v1/ddns/:subdomain', async (request, response, params) => {
    const subdomain = decodeURIComponent(params.subdomain);

    // 跳过 allocate 路由
    if (subdomain === 'allocate') {
      return;
    }

    try {
      const body = await readJsonBody(request);
      const payload = body as {
        ip?: string;
        ipAddress?: string;
        ipv6Address?: string;
        type?: string;
      } | undefined;

      const ipAddress = payload?.ip ?? payload?.ipAddress;
      const ipv6Address = payload?.ipv6Address;

      if (!ipAddress && !ipv6Address) {
        sendError(response, 400, 'ip or ipv6Address is required');
        return;
      }

      // 更新数据库记录
      const record = await ddnsRepo.updateRecordIp(subdomain, {
        ipAddress,
        ipv6Address,
      });

      if (!record) {
        sendError(response, 404, 'Subdomain not found');
        return;
      }

      // 更新 DNS 记录
      if (dnsProvider) {
        try {
          const recordType = ipv6Address ? 'AAAA' : 'A';
          const recordValue = ipv6Address ?? ipAddress!;

          await dnsProvider.upsertRecord({
            domain: record.domain,
            subdomain: record.subdomain,
            type: recordType,
            value: recordValue,
            ttl: record.ttl,
          });
          logger.info(`Updated DNS record: ${subdomain}.${record.domain} -> ${recordValue}`);
        } catch (dnsError) {
          logger.error(`Failed to update DNS record: ${dnsError}`);
          // 数据库已更新，DNS 更新失败不影响响应
        }
      }

      sendJson(response, 200, {
        success: true,
        subdomain: record.subdomain,
        domain: record.domain,
        fqdn: `${record.subdomain}.${record.domain}`,
        ipAddress: record.ipAddress,
        ipv6Address: record.ipv6Address,
        updatedAt: record.updatedAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('banned')) {
        sendError(response, 403, error.message);
        return;
      }
      logger.error(`Failed to update DDNS record: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  /**
   * GET /api/v1/ddns/{subdomain}
   *
   * 查询 DNS 记录
   */
  server.get('/api/v1/ddns/:subdomain', async (_request, response, params) => {
    const subdomain = decodeURIComponent(params.subdomain);

    try {
      const record = await ddnsRepo.getRecord(subdomain);

      if (!record) {
        sendError(response, 404, 'Subdomain not found');
        return;
      }

      sendJson(response, 200, {
        subdomain: record.subdomain,
        domain: record.domain,
        fqdn: `${record.subdomain}.${record.domain}`,
        ipAddress: record.ipAddress,
        ipv6Address: record.ipv6Address,
        recordType: record.recordType,
        status: record.status,
        ttl: record.ttl,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to get DDNS record: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  /**
   * DELETE /api/v1/ddns/{subdomain}
   *
   * 释放子域名
   */
  server.delete('/api/v1/ddns/:subdomain', async (_request, response, params) => {
    const subdomain = decodeURIComponent(params.subdomain);

    try {
      const record = await ddnsRepo.getRecord(subdomain);

      if (!record) {
        sendError(response, 404, 'Subdomain not found');
        return;
      }

      // 删除 DNS 记录
      if (dnsProvider) {
        try {
          await dnsProvider.deleteRecord({
            domain: record.domain,
            subdomain: record.subdomain,
            type: record.recordType,
          });
          logger.info(`Deleted DNS record: ${subdomain}.${record.domain}`);
        } catch (dnsError) {
          logger.error(`Failed to delete DNS record: ${dnsError}`);
        }
      }

      // 删除数据库记录
      await ddnsRepo.releaseSubdomain(subdomain);

      logger.info(`Released subdomain: ${subdomain}`);

      sendJson(response, 200, {
        success: true,
        message: `Subdomain ${subdomain} released`,
      });
    } catch (error) {
      logger.error(`Failed to release subdomain: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  /**
   * POST /api/v1/ddns/{subdomain}/ban
   *
   * 封禁子域名 (管理员)
   */
  server.post('/api/v1/ddns/:subdomain/ban', async (request, response, params) => {
    const subdomain = decodeURIComponent(params.subdomain);

    try {
      const body = await readJsonBody(request);
      const payload = body as { reason?: string } | undefined;

      const reason = payload?.reason ?? 'Banned by administrator';

      await ddnsRepo.banSubdomain(subdomain, reason);

      // 删除 DNS 记录
      if (dnsProvider) {
        const record = await ddnsRepo.getRecord(subdomain);
        if (record) {
          try {
            await dnsProvider.deleteRecord({
              domain: record.domain,
              subdomain: record.subdomain,
              type: record.recordType,
            });
          } catch (dnsError) {
            logger.error(`Failed to delete DNS record for banned subdomain: ${dnsError}`);
          }
        }
      }

      logger.warn(`Banned subdomain: ${subdomain}, reason: ${reason}`);

      sendJson(response, 200, {
        success: true,
        message: `Subdomain ${subdomain} banned`,
        reason,
      });
    } catch (error) {
      logger.error(`Failed to ban subdomain: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  logger.info('DDNS routes registered');
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
      } catch {
        resolve(undefined);
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

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}
