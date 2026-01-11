/**
 * SubdomainClientHandler - Local 模式子域名 API
 * 
 * 代理请求到 Cloud API，供本地 UI 调用
 */

import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { SubdomainClient } from '../../subdomain/SubdomainClient';

export interface SubdomainClientHandlerOptions {
  subdomainClient: SubdomainClient;
}

/**
 * 注册 Local 模式子域名路由
 * 
 * 这些路由是本地 UI 调用的入口，内部通过 SubdomainClient 转发到 Cloud
 * 
 * GET  /v1/subdomain/check?name=xxx - 检查子域名可用性
 * GET  /v1/subdomain - 列出子域名
 * GET  /v1/subdomain/:name - 获取子域名详情
 * POST /v1/subdomain/register - 注册子域名
 * DELETE /v1/subdomain/:name - 释放子域名
 * POST /v1/subdomain/:name/start - 启动隧道
 * POST /v1/subdomain/:name/stop - 停止隧道
 */
export function registerSubdomainClientRoutes(
  server: ApiServer,
  options: SubdomainClientHandlerOptions,
): void {
  const logger = getLoggerFor('SubdomainClientHandler');
  const client = options.subdomainClient;

  // GET /v1/subdomain/check?name=xxx - 检查可用性 (public)
  server.get('/v1/subdomain/check', async (request, response, _params) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const name = url.searchParams.get('name');

    if (!name) {
      sendJson(response, 400, { error: 'Missing "name" query parameter' });
      return;
    }

    try {
      const result = await client.checkAvailability(name);
      sendJson(response, 200, result);
    } catch (error) {
      logger.error(`Failed to check availability: ${error}`);
      sendErrorJson(response, error);
    }
  }, { public: true });

  // GET /v1/subdomain - 列出子域名
  server.get('/v1/subdomain', async (_request, response, _params) => {
    try {
      const result = await client.list();
      sendJson(response, 200, result);
    } catch (error) {
      logger.error(`Failed to list subdomains: ${error}`);
      sendErrorJson(response, error);
    }
  });

  // GET /v1/subdomain/:name - 获取子域名详情
  server.get('/v1/subdomain/:name', async (_request, response, params) => {
    const name = decodeURIComponent(params.name);

    try {
      const result = await client.getInfo(name);
      if (!result) {
        sendJson(response, 404, { error: 'Subdomain not found' });
        return;
      }
      sendJson(response, 200, result);
    } catch (error) {
      logger.error(`Failed to get subdomain info: ${error}`);
      sendErrorJson(response, error);
    }
  });

  // POST /v1/subdomain/register - 注册子域名
  server.post('/v1/subdomain/register', async (request, response, _params) => {
    const body = await readJsonBody(request);
    
    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Invalid request body' });
      return;
    }

    const { subdomain, localPort, publicIp } = body as Record<string, unknown>;

    if (!subdomain || typeof subdomain !== 'string') {
      sendJson(response, 400, { error: 'Missing "subdomain" field' });
      return;
    }

    if (!localPort || typeof localPort !== 'number') {
      sendJson(response, 400, { error: 'Missing or invalid "localPort" field' });
      return;
    }

    try {
      const result = await client.register({
        subdomain,
        localPort,
        publicIp: typeof publicIp === 'string' ? publicIp : undefined,
      });
      sendJson(response, 201, result);
    } catch (error) {
      logger.error(`Failed to register subdomain: ${error}`);
      sendErrorJson(response, error);
    }
  });

  // DELETE /v1/subdomain/:name - 释放子域名
  server.delete('/v1/subdomain/:name', async (_request, response, params) => {
    const name = decodeURIComponent(params.name);

    try {
      const result = await client.release(name);
      sendJson(response, 200, result);
    } catch (error) {
      logger.error(`Failed to release subdomain: ${error}`);
      sendErrorJson(response, error);
    }
  });

  // POST /v1/subdomain/:name/start - 启动隧道
  server.post('/v1/subdomain/:name/start', async (_request, response, params) => {
    const name = decodeURIComponent(params.name);

    try {
      const result = await client.startTunnel(name);
      sendJson(response, 200, result);
    } catch (error) {
      logger.error(`Failed to start tunnel: ${error}`);
      sendErrorJson(response, error);
    }
  });

  // POST /v1/subdomain/:name/stop - 停止隧道
  server.post('/v1/subdomain/:name/stop', async (_request, response, params) => {
    const name = decodeURIComponent(params.name);

    try {
      const result = await client.stopTunnel(name);
      sendJson(response, 200, result);
    } catch (error) {
      logger.error(`Failed to stop tunnel: ${error}`);
      sendErrorJson(response, error);
    }
  });
}

// ============ Helper Functions ============

async function readJsonBody(request: AuthenticatedRequest): Promise<unknown> {
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

function sendErrorJson(response: ServerResponse, error: unknown): void {
  const status = (error as any)?.status ?? 500;
  const message = error instanceof Error ? error.message : 'Unknown error';
  sendJson(response, status, { error: message });
}
