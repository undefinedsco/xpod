import type { ServerResponse, IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';

export interface PodManagementHandlerOptions {
  /** Pod 存储根目录 */
  rootDir: string;
  /** 验证 IdP service token */
  verifyServiceToken: (token: string) => Promise<boolean>;
  /** 可选：限制允许的 pod 名称正则 */
  podNameRegex?: RegExp;
  /** 可选：创建 CSS-compatible Pod 数据，而不是只创建裸目录 */
  provisioningService?: {
    createPod(input: CreatePodRequest): Promise<{ podUrl: string }>;
  };
  /** SP-local Pod lookup used by Cloud consent to scope account WebIDs. */
  podLookupRepository?: Pick<PodLookupRepository, 'findByWebIds'>;
}

export interface CreatePodRequest {
  /** Pod 名称（通常是用户名） */
  podName: string;
  /** Owner WebID，Cloud IDP + Local SP 时应为 Cloud WebID */
  webId?: string;
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

interface LookupWebIdsRequest {
  webIds?: unknown;
}

interface LookupWebIdsResponse {
  entries: Array<{
    webId: string;
    podUrl: string;
    storageUrl: string;
  }>;
}

/**
 * Pod Management Handler
 *
 * SP (Storage Provider) 端供 IdP 调用的 API。
 * 用于创建/删除/查询 Pod 目录。
 *
 * 端点 (Solid Storage Provision Protocol):
 * - POST   /provision/pods           - 创建 Pod
 * - GET    /provision/pods/:podName  - 查询 Pod
 * - DELETE /provision/pods/:podName  - 删除 Pod
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
  const { rootDir, verifyServiceToken, podNameRegex = /^[a-zA-Z0-9_-]+$/, provisioningService, podLookupRepository } = options;

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
   * POST /provision/pods
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
  server.post('/provision/pods', async (request, response) => {
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
      const result = provisioningService
        ? await provisioningService.createPod(body)
        : await createPodDirectory(podPath, initialResources).then(() => undefined);
      logger.info(`Created pod: ${podName} at ${podPath}`);

      // 构建 pod URL (基于请求的 host)
      const host = request.headers.host || 'localhost';
      const podUrl = result?.podUrl || `https://${host}/${podName}/`;

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
   * POST /provision/webids
   *
   * Lookup account-linked WebIDs against this SP's Pod facts. Cloud OIDC uses
   * this during Cloud IDP + Local SP consent so the picker cannot offer Pods
   * from a different storage provider.
   */
  server.post('/provision/webids', async (request, response) => {
    if (!await authenticate(request)) {
      sendJson(response, 401, { error: 'Unauthorized', message: 'Invalid or missing service token' });
      return;
    }

    if (!podLookupRepository) {
      sendJson(response, 503, { error: 'Unavailable', message: 'Pod lookup repository is not configured' });
      return;
    }

    let body: LookupWebIdsRequest;
    try {
      body = await readJsonBody(request) as LookupWebIdsRequest;
    } catch {
      sendJson(response, 400, { error: 'Bad Request', message: 'Invalid JSON body' });
      return;
    }

    if (!Array.isArray(body.webIds) || body.webIds.some((webId) => typeof webId !== 'string')) {
      sendJson(response, 400, { error: 'Bad Request', message: 'webIds must be a string array' });
      return;
    }

    try {
      const webIds = body.webIds as string[];
      const pods = await podLookupRepository.findByWebIds(webIds);
      const entries = pods
        .map((pod) => {
          const webId = resolveMatchedWebId(pod.webId, pod.webIds, webIds);
          const storageUrl = ensureTrailingSlash(pod.storageUrl ?? pod.baseUrl);
          return webId
            ? {
              webId,
              podUrl: storageUrl,
              storageUrl,
            }
            : undefined;
        })
        .filter((entry): entry is LookupWebIdsResponse['entries'][number] => Boolean(entry));

      sendJson(response, 200, { entries });
    } catch (error) {
      logger.error(`Failed to lookup provisioned WebIDs: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to lookup provisioned WebIDs' });
    }
  }, { public: true });

  /**
   * DELETE /provision/pods/:podName
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
  server.delete('/provision/pods/:podName', async (request, response, params) => {
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
   * GET /provision/pods/:podName
   *
   * 获取 Pod 信息（存在性检查）
   */
  server.get('/provision/pods/:podName', async (request, response, params) => {
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

function resolveMatchedWebId(webId: string | undefined, webIds: string[] | undefined, requested: string[]): string | undefined {
  const candidates = [
    webId,
    ...(webIds ?? []),
  ].filter((value): value is string => typeof value === 'string');
  const requestedSet = new Set(requested.map(normalizeUrl));
  return candidates.find((candidate) => requestedSet.has(normalizeUrl(candidate)));
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function ensureTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, '') + '/';
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
