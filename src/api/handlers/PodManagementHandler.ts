import type { ServerResponse, IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';

export interface PodManagementHandlerOptions {
  /** Pod 存储根目录 */
  rootDir: string;
  /** 验证 IdP service token */
  verifyServiceToken: (token: string) => Promise<boolean>;
  /** 可选：限制允许的 pod 名称正则 */
  podNameRegex?: RegExp;
}

export interface CreatePodRequest {
  /** Pod 名称（通常是用户名） */
  podName: string;
  /** 可选：初始资源 */
  initialResources?: Record<string, string>;
}

export interface CreatePodResponse {
  success: boolean;
  podUrl: string;
  message: string;
}

export interface DeletePodResponse {
  success: boolean;
  message: string;
}

/**
 * Pod Management Handler
 *
 * SP (Storage Provider) 端供 IdP 调用的 API。
 * 用于创建/删除 Pod 目录。
 *
 * 端点:
 * - POST /api/v1/pods - 创建 Pod
 * - DELETE /api/v1/pods/:podName - 删除 Pod
 *
 * 认证:
 * - 使用 IdP service token (Bearer)
 * - 验证 token 是否来自信任的 IdP
 */
export function registerPodManagementRoutes(
  server: ApiServer,
  options: PodManagementHandlerOptions
): void {
  const logger = getLoggerFor('PodManagementHandler');
  const { rootDir, verifyServiceToken, podNameRegex = /^[a-zA-Z0-9_-]+$/ } = options;

  /**
   * 验证 service token
   */
  async function authenticate(request: IncomingMessage): Promise<boolean> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }
    const token = authHeader.slice(7);
    return verifyServiceToken(token);
  }

  /**
   * 验证 pod 名称
   */
  function validatePodName(podName: string): boolean {
    if (!podName || podName.length < 1 || podName.length > 64) {
      return false;
    }
    return podNameRegex.test(podName);
  }

  /**
   * POST /api/v1/pods
   *
   * 创建 Pod 目录
   *
   * Request:
   *   Authorization: Bearer {service_token}
   *   Content-Type: application/json
   *   Body: { podName: "alice", initialResources?: {...} }
   *
   * Response:
   *   201: { success: true, podUrl: "https://node1.pods.site/alice/" }
   *   400: { error: "Invalid pod name" }
   *   401: { error: "Unauthorized" }
   *   409: { error: "Pod already exists" }
   */
  server.post('/api/v1/pods', async (request, response) => {
    // 1. 认证
    if (!await authenticate(request)) {
      sendJson(response, 401, { error: 'Unauthorized', message: 'Invalid or missing service token' });
      return;
    }

    // 2. 解析请求体
    let body: CreatePodRequest;
    try {
      body = await readJsonBody(request) as CreatePodRequest;
    } catch (error) {
      sendJson(response, 400, { error: 'Bad Request', message: 'Invalid JSON body' });
      return;
    }

    const { podName, initialResources } = body;

    // 3. 验证 pod 名称
    if (!validatePodName(podName)) {
      sendJson(response, 400, {
        error: 'Bad Request',
        message: `Invalid pod name: ${podName}. Must match ${podNameRegex.toString()}`
      });
      return;
    }

    // 4. 检查是否已存在
    const podPath = `${rootDir}/${podName}`;
    try {
      const exists = await fileExists(podPath);
      if (exists) {
        sendJson(response, 409, { error: 'Conflict', message: `Pod ${podName} already exists` });
        return;
      }
    } catch (error) {
      logger.error(`Error checking pod existence: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to check pod existence' });
      return;
    }

    // 5. 创建 Pod 目录
    try {
      await createPodDirectory(podPath, initialResources);
      logger.info(`Created pod: ${podName} at ${podPath}`);

      // 构建 pod URL (基于请求的 host)
      const host = request.headers.host || 'localhost';
      const podUrl = `https://${host}/${podName}/`;

      sendJson(response, 201, {
        success: true,
        podUrl,
        message: `Pod ${podName} created successfully`
      });
    } catch (error) {
      logger.error(`Failed to create pod: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to create pod' });
    }
  }, { public: true }); // Service token auth handled internally

  /**
   * DELETE /api/v1/pods/:podName
   *
   * 删除 Pod 目录
   *
   * Request:
   *   Authorization: Bearer {service_token}
   *
   * Response:
   *   200: { success: true }
   *   401: { error: "Unauthorized" }
   *   404: { error: "Pod not found" }
   */
  server.delete('/api/v1/pods/:podName', async (request, response, params) => {
    // 1. 认证
    if (!await authenticate(request)) {
      sendJson(response, 401, { error: 'Unauthorized', message: 'Invalid or missing service token' });
      return;
    }

    const podName = decodeURIComponent(params.podName);

    // 2. 验证 pod 名称
    if (!validatePodName(podName)) {
      sendJson(response, 400, { error: 'Bad Request', message: `Invalid pod name: ${podName}` });
      return;
    }

    // 3. 检查是否存在
    const podPath = `${rootDir}/${podName}`;
    try {
      const exists = await fileExists(podPath);
      if (!exists) {
        sendJson(response, 404, { error: 'Not Found', message: `Pod ${podName} not found` });
        return;
      }
    } catch (error) {
      logger.error(`Error checking pod existence: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to check pod existence' });
      return;
    }

    // 4. 删除 Pod 目录
    try {
      await deletePodDirectory(podPath);
      logger.info(`Deleted pod: ${podName}`);

      sendJson(response, 200, {
        success: true,
        message: `Pod ${podName} deleted successfully`
      });
    } catch (error) {
      logger.error(`Failed to delete pod: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to delete pod' });
    }
  }, { public: true });

  /**
   * GET /api/v1/pods/:podName
   *
   * 获取 Pod 信息（存在性检查）
   */
  server.get('/api/v1/pods/:podName', async (request, response, params) => {
    // 1. 认证
    if (!await authenticate(request)) {
      sendJson(response, 401, { error: 'Unauthorized', message: 'Invalid or missing service token' });
      return;
    }

    const podName = decodeURIComponent(params.podName);
    const podPath = `${rootDir}/${podName}`;

    try {
      const exists = await fileExists(podPath);
      if (!exists) {
        sendJson(response, 404, { error: 'Not Found', message: `Pod ${podName} not found` });
        return;
      }

      const host = request.headers.host || 'localhost';
      const podUrl = `https://${host}/${podName}/`;

      sendJson(response, 200, {
        exists: true,
        podName,
        podUrl,
        storagePath: podPath
      });
    } catch (error) {
      logger.error(`Error getting pod info: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to get pod info' });
    }
  }, { public: true });

  logger.info(`Pod management routes registered with rootDir: ${rootDir}`);
}

/**
 * 读取 JSON 请求体
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve({});
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

/**
 * 发送 JSON 响应
 */
function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

/**
 * 检查文件/目录是否存在
 */
async function fileExists(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 Pod 目录
 */
async function createPodDirectory(
  podPath: string,
  initialResources?: Record<string, string>
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  // 创建目录
  await mkdir(podPath, { recursive: true });

  // 创建初始资源
  if (initialResources) {
    for (const [filename, content] of Object.entries(initialResources)) {
      const filePath = join(podPath, filename);
      await writeFile(filePath, content, 'utf8');
    }
  }
}

/**
 * 删除 Pod 目录
 */
async function deletePodDirectory(podPath: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(podPath, { recursive: true, force: true });
}
