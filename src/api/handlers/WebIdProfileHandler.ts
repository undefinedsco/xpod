/**
 * WebID Profile API Handler
 *
 * 提供 WebID Profile 托管服务的 HTTP API
 *
 * GET  /{username}/profile/card     - 获取 WebID Profile (Turtle 格式)
 * POST /api/v1/identity/{username}/storage - 更新 storage 指针 (需认证)
 */

import type { ServerResponse, IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { WebIdProfileRepository } from '../../identity/drizzle/WebIdProfileRepository';

const logger = getLoggerFor('WebIdProfileHandler');

export interface WebIdProfileHandlerOptions {
  profileRepo: WebIdProfileRepository;
}

export function registerWebIdProfileRoutes(
  server: ApiServer,
  options: WebIdProfileHandlerOptions,
): void {
  const { profileRepo } = options;

  /**
   * GET /{username}/profile/card
   *
   * 获取 WebID Profile (Turtle 格式)
   * 这是 Solid 标准的 WebID 端点
   */
  server.get('/:username/profile/card', async (_request, response, params) => {
    const username = decodeURIComponent(params.username);

    try {
      const profile = await profileRepo.get(username);

      if (!profile) {
        sendError(response, 404, 'Profile not found');
        return;
      }

      // 返回 Turtle 格式
      const turtle = profileRepo.generateProfileTurtle(profile);

      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/turtle');
      response.setHeader('Link', `<${profile.webidUrl}>; rel="describedby"`);
      response.end(turtle);
    } catch (error) {
      logger.error(`Failed to get profile for ${username}: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  }, { public: true });

  /**
   * POST /api/v1/identity/{username}/storage
   *
   * 更新 storage 指针
   * 用于 Local 节点更新其 storage URL
   *
   * Request body:
   * {
   *   "storageUrl": "https://alice.undefineds.xyz/"
   * }
   */
  server.post('/api/v1/identity/:username/storage', async (request, response, params) => {
    const username = decodeURIComponent(params.username);

    try {
      const body = await readJsonBody(request);
      const payload = body as { storageUrl?: string; storageMode?: string } | undefined;

      if (!payload?.storageUrl) {
        sendError(response, 400, 'storageUrl is required');
        return;
      }

      // 验证 URL 格式
      try {
        new URL(payload.storageUrl);
      } catch {
        sendError(response, 400, 'Invalid storageUrl format');
        return;
      }

      const profile = await profileRepo.updateStorage(username, {
        storageUrl: payload.storageUrl,
        storageMode: payload.storageMode as 'cloud' | 'local' | 'custom' | undefined,
      });

      if (!profile) {
        sendError(response, 404, 'Profile not found');
        return;
      }

      logger.info(`Updated storage for ${username}: ${payload.storageUrl}`);

      sendJson(response, 200, {
        success: true,
        username,
        storageUrl: profile.storageUrl,
        storageMode: profile.storageMode,
        updatedAt: profile.updatedAt.toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to update storage for ${username}: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  /**
   * GET /api/v1/identity/{username}
   *
   * 获取 WebID Profile 信息 (JSON 格式)
   */
  server.get('/api/v1/identity/:username', async (_request, response, params) => {
    const username = decodeURIComponent(params.username);

    try {
      const profile = await profileRepo.get(username);

      if (!profile) {
        sendError(response, 404, 'Profile not found');
        return;
      }

      sendJson(response, 200, {
        username: profile.username,
        webidUrl: profile.webidUrl,
        storageUrl: profile.storageUrl,
        storageMode: profile.storageMode,
        oidcIssuer: profile.oidcIssuer,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to get profile for ${username}: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  }, { public: true });

  /**
   * POST /api/v1/identity
   *
   * 创建 WebID Profile
   *
   * Request body:
   * {
   *   "username": "alice",
   *   "storageMode": "local",  // optional, default: "cloud"
   *   "storageUrl": "https://alice.undefineds.xyz/"  // optional
   * }
   */
  server.post('/api/v1/identity', async (request, response, _params) => {
    try {
      const body = await readJsonBody(request);
      const payload = body as {
        username?: string;
        storageMode?: string;
        storageUrl?: string;
        accountId?: string;
      } | undefined;

      if (!payload?.username) {
        sendError(response, 400, 'username is required');
        return;
      }

      // 验证用户名格式
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(payload.username)) {
        sendError(response, 400, 'Invalid username format');
        return;
      }

      // 检查是否已存在
      const existing = await profileRepo.get(payload.username);
      if (existing) {
        sendError(response, 409, 'Username already taken');
        return;
      }

      const profile = await profileRepo.create({
        username: payload.username,
        storageMode: payload.storageMode as 'cloud' | 'local' | 'custom' | undefined,
        storageUrl: payload.storageUrl,
        accountId: payload.accountId,
      });

      logger.info(`Created profile for ${payload.username}`);

      sendJson(response, 201, {
        success: true,
        username: profile.username,
        webidUrl: profile.webidUrl,
        storageUrl: profile.storageUrl,
        storageMode: profile.storageMode,
        createdAt: profile.createdAt.toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to create profile: ${error}`);
      sendError(response, 500, 'Internal server error');
    }
  });

  logger.info('WebID Profile routes registered');
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
