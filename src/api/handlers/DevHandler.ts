import type { ServerResponse, IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { DrizzleClientCredentialsStore } from '../store/DrizzleClientCredentialsStore';

export interface DevHandlerOptions {
  nodeRepo: EdgeNodeRepository;
  credentialsStore: DrizzleClientCredentialsStore;
}

/**
 * 开发模式专用 Handler
 *
 * 仅在 NODE_ENV=development 时启用，用于集成测试
 *
 * POST /dev/credentials - 创建测试用 client credentials
 * POST /dev/nodes - 创建测试用 edge node
 * POST /dev/setup - 一键创建 credentials + node（完整测试环境）
 * DELETE /dev/cleanup/:testId - 清理测试数据
 */
export function registerDevRoutes(server: ApiServer, options: DevHandlerOptions): void {
  const logger = getLoggerFor('DevHandler');
  const { nodeRepo, credentialsStore } = options;

  // 安全检查：仅开发模式可用
  const isDev = process.env.NODE_ENV === 'development';

  if (!isDev) {
    logger.info('Dev routes disabled (not in development mode)');
    return;
  }

  logger.warn('⚠️  Dev routes enabled - DO NOT use in production!');

  /**
   * POST /dev/credentials
   *
   * 创建测试用的 client credentials
   *
   * Request body (optional):
   * {
   *   "displayName": "Test Client",
   *   "testId": "my-test-run"  // 用于后续清理
   * }
   *
   * Response:
   * {
   *   "clientId": "test-client-xxx",
   *   "clientSecret": "secret-xxx",
   *   "webId": "https://dev.local/test-xxx#me",
   *   "testId": "my-test-run"
   * }
   */
  server.post('/dev/credentials', async (request, response, _params) => {
    const body = await readJsonBody(request);
    const payload = (body as Record<string, unknown>) ?? {};

    const testId = (payload.testId as string) ?? `test-${Date.now()}`;
    const displayName = (payload.displayName as string) ?? `Dev Test ${testId}`;

    // 生成 credentials
    const clientId = `dev-client-${randomUUID().slice(0, 8)}`;
    const clientSecret = randomBytes(32).toString('base64url');
    const webId = `https://dev.local/${testId}#me`;

    try {
      // 存储到数据库
      await credentialsStore.store({
        clientId,
        clientSecret,
        webId,
        accountId: webId,
        displayName,
      });

      logger.info(`[DEV] Created credentials: ${clientId} for ${webId}`);

      sendJson(response, 201, {
        clientId,
        clientSecret,
        webId,
        testId,
        displayName,
        message: 'Development credentials created. Use these for testing.',
      });
    } catch (error) {
      logger.error(`[DEV] Failed to create credentials: ${error}`);
      sendJson(response, 500, { error: 'Failed to create credentials' });
    }
  }, { public: true });

  /**
   * POST /dev/nodes
   *
   * 创建测试用的 edge node
   *
   * Request body (optional):
   * {
   *   "displayName": "Test Node",
   *   "testId": "my-test-run",
   *   "ownerWebId": "https://dev.local/test-xxx#me"  // 关联到指定用户
   * }
   *
   * Response:
   * {
   *   "nodeId": "uuid-xxx",
   *   "token": "node-token-xxx",
   *   "testId": "my-test-run"
   * }
   */
  server.post('/dev/nodes', async (request, response, _params) => {
    const body = await readJsonBody(request);
    const payload = (body as Record<string, unknown>) ?? {};

    const testId = (payload.testId as string) ?? `test-${Date.now()}`;
    const displayName = (payload.displayName as string) ?? `Dev Node ${testId}`;
    const ownerWebId = (payload.ownerWebId as string) ?? `https://dev.local/${testId}#me`;

    try {
      // 创建节点
      const result = await nodeRepo.createNode(displayName, ownerWebId);

      logger.info(`[DEV] Created node: ${result.nodeId} for ${ownerWebId}`);

      sendJson(response, 201, {
        nodeId: result.nodeId,
        token: result.token,
        testId,
        displayName,
        ownerWebId,
        createdAt: result.createdAt,
        message: 'Development node created. Use nodeId + token for signaling.',
      });
    } catch (error) {
      logger.error(`[DEV] Failed to create node: ${error}`);
      sendJson(response, 500, { error: 'Failed to create node' });
    }
  }, { public: true });

  /**
   * POST /dev/setup
   *
   * 一键创建完整测试环境：credentials + node
   *
   * Request body (optional):
   * {
   *   "testId": "my-test-run",
   *   "displayName": "My Test"
   * }
   *
   * Response:
   * {
   *   "testId": "my-test-run",
   *   "credentials": { clientId, clientSecret, webId },
   *   "node": { nodeId, token },
   *   "signalingUrl": "ws://localhost:3001/ws/signaling",
   *   "env": { ... }  // 可直接用于 .env 配置
   * }
   */
  server.post('/dev/setup', async (request, response, _params) => {
    const body = await readJsonBody(request);
    const payload = (body as Record<string, unknown>) ?? {};

    const testId = (payload.testId as string) ?? `test-${Date.now()}`;
    const displayName = (payload.displayName as string) ?? `Test ${testId}`;

    // 1. 创建 credentials
    const clientId = `dev-client-${randomUUID().slice(0, 8)}`;
    const clientSecret = randomBytes(32).toString('base64url');
    const webId = `https://dev.local/${testId}#me`;

    // 2. 创建 node
    try {
      await credentialsStore.store({
        clientId,
        clientSecret,
        webId,
        accountId: webId,
        displayName: `${displayName} Client`,
      });

      const nodeResult = await nodeRepo.createNode(`${displayName} Node`, webId);

      // 生成符合 NodeTokenAuthenticator 格式的 token: username:secret
      const formattedNodeToken = `${testId}:${nodeResult.token}`;

      logger.info(`[DEV] Setup complete: credentials=${clientId}, node=${nodeResult.nodeId}`);

      // 获取当前服务的基础 URL
      const host = process.env.API_HOST ?? 'localhost';
      const port = process.env.API_PORT ?? '3001';
      const apiUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

      sendJson(response, 201, {
        testId,
        credentials: {
          clientId,
          clientSecret,
          webId,
        },
        node: {
          nodeId: nodeResult.nodeId,
          token: formattedNodeToken,
        },
        apiUrl,
        // 可直接导出为环境变量
        env: {
          XPOD_CLIENT_ID: clientId,
          XPOD_CLIENT_SECRET: clientSecret,
          XPOD_NODE_ID: nodeResult.nodeId,
          XPOD_NODE_TOKEN: formattedNodeToken,
        },
        message: 'Development environment ready. Copy env values to your .env file or use directly.',
      });
    } catch (error) {
      logger.error(`[DEV] Setup failed: ${error}`);
      sendJson(response, 500, { error: 'Failed to setup test environment' });
    }
  }, { public: true });

  /**
   * DELETE /dev/cleanup/:testId
   *
   * 清理指定 testId 的测试数据
   */
  server.delete('/dev/cleanup/:testId', async (request, response, params) => {
    const testId = decodeURIComponent(params.testId);
    const webId = `https://dev.local/${testId}#me`;

    try {
      // 清理 credentials
      const keys = await credentialsStore.listByAccount(webId);
      for (const key of keys) {
        await credentialsStore.delete(key.clientId, webId);
      }

      // 清理 nodes
      const nodes = await nodeRepo.listNodesByAccount(webId);
      for (const node of nodes) {
        await nodeRepo.deleteNode(node.nodeId);
      }

      logger.info(`[DEV] Cleaned up test: ${testId} (${keys.length} credentials, ${nodes.length} nodes)`);

      sendJson(response, 200, {
        testId,
        deleted: {
          credentials: keys.length,
          nodes: nodes.length,
        },
        message: 'Test data cleaned up.',
      });
    } catch (error) {
      logger.error(`[DEV] Cleanup failed: ${error}`);
      sendJson(response, 500, { error: 'Failed to cleanup test data' });
    }
  }, { public: true });

  /**
   * GET /dev/status
   *
   * 获取开发模式状态
   */
  server.get('/dev/status', async (_request, response, _params) => {
    sendJson(response, 200, {
      mode: 'development',
      enabled: true,
      endpoints: [
        'POST /dev/credentials - Create test credentials',
        'POST /dev/nodes - Create test node',
        'POST /dev/setup - One-click setup (credentials + node)',
        'DELETE /dev/cleanup/:testId - Cleanup test data',
        'GET /dev/status - This endpoint',
      ],
      warning: 'These endpoints are for development only. Never expose in production!',
    });
  }, { public: true });
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
  response.end(JSON.stringify(data, null, 2));
}
