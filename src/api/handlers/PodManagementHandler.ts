import type { ServerResponse, IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { isAdminMutationAllowed } from './AdminHandler';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readLocalProvisionState, resolveLocalSetupPath, resolveLocalSetupProviderId } from '../../provision/LocalProvisionState';
import type { PodDeletionAuthorization } from '../../identity/drizzle/PodDeletionOperationRepository';
import { createProvisionReceipt } from '../../provision/ProvisionReceiptCodec';

export interface PodManagementHandlerOptions {
  /** Pod 存储根目录 */
  rootDir: string;
  internalAdminAuthSecret?: string;
  /** 验证 IdP service token */
  verifyServiceToken: (token: string) => Promise<boolean>;
  /** 可选：限制允许的 pod 名称正则 */
  podNameRegex?: RegExp;
  /** 可选：创建 CSS-compatible Pod 数据，而不是只创建裸目录 */
  provisioningService?: {
    createPod(input: CreatePodRequest): Promise<{ podUrl: string; webId?: string; podId?: string }>;
  };
  /** SP-local Pod lookup used by Cloud consent to scope account WebIDs. */
  podLookupRepository?: Pick<PodLookupRepository, 'findByWebIds'> & Partial<Pick<PodLookupRepository, 'findByResourceIdentifier'>>;
  /** Canonical storage root for this SP; lookup responses are fail-closed to this root. */
  storageProviderBaseUrl?: string;
  /** Derived from the long-lived SP service token; never from per-request access tokens. */
  receiptSigningSecret?: string;
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
  webId?: string;
  provisionReceipt?: string;
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
  const {
    rootDir,
    verifyServiceToken,
    podNameRegex = /^[a-zA-Z0-9_-]+$/,
    provisioningService,
    podLookupRepository,
    receiptSigningSecret,
  } = options;
  const storageProviderRoot = normalizeStorageRoot(options.storageProviderBaseUrl);
  const setupPath = resolveLocalSetupPath(process.env.XPOD_LOCAL_SETUP_PATH, rootDir);
  const providerId = resolveLocalSetupProviderId(process.env.XPOD_PROVIDER_ID);

  async function deletionAuthorization(request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>): Promise<void> {
    if (!isAdminMutationAllowed(request as AuthenticatedRequest, { internalAdminAuthSecret: options.internalAdminAuthSecret, allowLoopback: !request.headers.authorization && !request.headers['x-xpod-admin-token'] })) {
      sendJson(response, 403, { error: 'POD_DELETE_OPERATOR_REQUIRED' }); return;
    }
    const origin = request.headers.origin;
    let sameOrigin = false;
    try {
      const parsed = new URL(typeof origin === 'string' ? origin : '');
      const canonical = storageProviderRoot && new URL(storageProviderRoot).origin;
      const localAlias = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.host === request.headers.host;
      sameOrigin = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin && parsed.host === request.headers.host && (parsed.origin === canonical || localAlias);
    } catch { /* An absent/opaque Origin never grants browser operator authority. */ }
    if (!sameOrigin) { sendJson(response, 403, { error: 'POD_DELETE_ORIGIN_REQUIRED' }); return; }
    const { challenge, podName, expectedLocalPodId } = body;
    if (typeof challenge !== 'string' || !/^[a-f0-9-]{36}\.[a-zA-Z0-9_-]{43}$/u.test(challenge) || typeof podName !== 'string' || !validatePodName(podName) || !storageProviderRoot) {
      sendJson(response, 403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return;
    }
    const state = readLocalProvisionState(setupPath, providerId);
    if (!state?.nodeId || !state.nodeToken || !state.cloudApiUrl) { sendJson(response, 403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return; }
    const storageUrl = new URL(`${podName}/`, storageProviderRoot).href;
    const callback = async (action: 'authorize-details' | 'authorize', payload?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const callbackRoot = new URL(state.cloudApiUrl!);
      if (!['http:', 'https:'].includes(callbackRoot.protocol) || callbackRoot.username || callbackRoot.password || callbackRoot.search || callbackRoot.hash) { throw new Error('Invalid registered callback'); }
      const result = await fetch(new URL(`api/pod-deletions/${challenge.split('.')[0]}/${action}`, callbackRoot.href.replace(/\/?$/u, '/')), {
        method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { authorization: `XpodNode ${state.nodeId}:${state.nodeToken}`, 'x-xpod-pod-authorization': challenge, ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      return { status: result.status, body: await result.json() as Record<string, unknown> };
    };
    try {
      const result = await callback('authorize-details');
      if (result.status !== 200) { sendAuthorizationFailure(response, result.status); return; }
      const details = result.body.authorization as PodDeletionAuthorization | undefined;
      if (!details || details.storageUrl !== storageUrl || details.nodeId !== state.nodeId || details.challengeId !== challenge.split('.')[0]) {
        sendJson(response, 403, { error: 'POD_DELETE_AUTHORIZATION_INVALID' }); return;
      }
      const pod = await podLookupRepository?.findByResourceIdentifier?.(storageUrl);
      if (!pod || pod.baseUrl !== storageUrl || !pod.podId) { sendJson(response, 404, { error: 'POD_DELETE_NOT_FOUND' }); return; }
      const ownerWebIds = [...new Set([pod.webId, ...(pod.webIds ?? [])].filter((value): value is string => Boolean(value)))];
      if (body.action === 'inspectDeletionAuthorization') {
        sendJson(response, 200, { deletionAuthorization: { challenge, podName, expiresAt: details.expiresAt,
          cloudAccountId: details.accountId, cloudPodId: details.podId, nodeId: details.nodeId, storageUrl,
          currentLocalPodId: pod.podId, ownerWebIds, returnUrl: details.returnUrl } }); return;
      }
      if (expectedLocalPodId !== pod.podId) { sendJson(response, 409, { error: 'POD_DELETE_GENERATION_CHANGED' }); return; }
      const accepted = await callback('authorize', { storageUrl, remotePodId: pod.podId, ownerWebIds });
      if (accepted.status !== 200) { sendAuthorizationFailure(response, accepted.status); return; }
      sendJson(response, 200, { success: true, returnUrl: details.returnUrl });
    } catch (error) {
      logger.warn('Pod deletion authorization callback failed');
      sendJson(response, 502, { error: 'POD_DELETE_NODE_UNAVAILABLE' });
    }
  }


  /**
   * 验证 service token
   */
  async function authenticate(request: IncomingMessage): Promise<string | undefined> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return undefined;
    }
    const token = authHeader.slice(7).trim();
    return await verifyServiceToken(token) ? token : undefined;
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
    const serviceAuthorized = Boolean(await authenticate(request));
    if (!serviceAuthorized && !isAdminMutationAllowed(request, { internalAdminAuthSecret: options.internalAdminAuthSecret, allowLoopback: !request.headers.authorization && !request.headers['x-xpod-admin-token'] })) {
      sendJson(response, 401, { error: 'Unauthorized' }); return;
    }
    let body: CreatePodRequest;
    try { body = await readJsonBody(request) as CreatePodRequest; }
    catch (error) {
      if (error instanceof Error && error.message === 'Request body too large') { sendJson(response, 413, { error: 'Request body too large' }); return; }
      sendJson(response, serviceAuthorized ? 400 : 401, { error: 'Invalid request' }); return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(response, 400, { error: 'Invalid request' }); return; }
    const action = (body as unknown as Record<string, unknown>).action;
    if (action === 'inspectDeletionAuthorization' || action === 'authorizeDeletion') {
      await deletionAuthorization(request, response, body as unknown as Record<string, unknown>); return;
    }
    if (!serviceAuthorized) {
      sendJson(response, 401, { error: 'Unauthorized', message: 'Invalid or missing service token' }); return;
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
      if (exists && provisioningService) {
        const existing = await findExistingProvisionedPod(body, podName);
        if (existing) {
          logger.info(`Pod ${podName} already exists for ${body.webId}; returning existing SP-local pod`);
          sendJson(response, 200, {
            success: true,
            podUrl: existing.storageUrl,
            webId: existing.webId,
            // A network access token may retry provisioning but cannot acquire deletion authority over an existing Pod.
            provisionReceipt: createReceipt({ secret: receiptSigningSecret, podName, podUrl: existing.storageUrl, webId: existing.webId }),
            message: `Pod ${podName} already exists for this WebID`,
          });
          return;
        }
      }

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
      const webId = result?.webId ?? body.webId;

      sendJson(response, 201, {
        success: true,
        podUrl,
        ...(webId ? {
          webId,
          provisionReceipt: createReceipt({ secret: receiptSigningSecret, podName, podUrl, webId, podId: result?.podId }),
        } : {}),
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
      const entries: LookupWebIdsResponse['entries'] = [];
      const seenEntries = new Set<string>();

      if (!storageProviderRoot) {
        logger.warn('Refusing to expose provisioned WebIDs because storageProviderBaseUrl is not configured');
        sendJson(response, 200, { entries });
        return;
      }

      for (const pod of pods) {
        const rawStorageUrl = pod.storageUrl ?? pod.baseUrl;
        const canonicalStorageUrl = canonicalizeStorageProviderUrl(rawStorageUrl, storageProviderRoot);
        if (!canonicalStorageUrl) {
          continue;
        }

        const podName = getRootRelativePodName(canonicalStorageUrl, storageProviderRoot);
        if (!podName || !validatePodName(podName)) {
          logger.warn(`Refusing to expose provisioned WebID for invalid SP-local Pod URL: ${rawStorageUrl}`);
          continue;
        }

        const podPath = `${rootDir}/${podName}`;
        if (!await fileExists(podPath)) {
          logger.warn(`Refusing to expose stale provisioned WebID for missing Pod directory: ${podPath}`);
          continue;
        }

        const webId = resolveMatchedWebId(pod.webId, pod.webIds, webIds);
        if (!webId) {
          continue;
        }

        const storageUrl = canonicalStorageUrl;
        const entryKey = `${webId}\u0000${storageUrl}`;
        if (seenEntries.has(entryKey)) {
          continue;
        }
        seenEntries.add(entryKey);
        entries.push({
          webId,
          podUrl: storageUrl,
          storageUrl,
        });
      }

      sendJson(response, 200, { entries });
    } catch (error) {
      logger.error(`Failed to lookup provisioned WebIDs: ${(error as Error).message}`);
      sendJson(response, 500, { error: 'Internal Server Error', message: 'Failed to lookup provisioned WebIDs' });
    }
  }, { public: true });

  async function findExistingProvisionedPod(
    body: CreatePodRequest,
    podName: string,
  ): Promise<{ storageUrl: string; webId: string; podId?: string } | undefined> {
    if (!podLookupRepository || !storageProviderRoot || typeof body.webId !== 'string' ||
      !body.webId || body.webId !== body.webId.trim() || /[\r\n\t]/u.test(body.webId)) {
      return undefined;
    }

    try {
      const expectedPodUrl = buildPodUrl(storageProviderRoot, podName);
      if (body.webId) {
        const requestedWebId = body.webId;
        const pods = await podLookupRepository.findByWebIds([requestedWebId]);
        const match = pods.find((pod) => {
          const storageUrl = canonicalizeStorageProviderUrl(pod.storageUrl ?? pod.baseUrl, storageProviderRoot);
          return storageUrl === expectedPodUrl &&
            storageUrlBelongsToRoot(storageUrl, storageProviderRoot) &&
            Boolean(resolveMatchedWebId(pod.webId, pod.webIds, [requestedWebId]));
        });
        return match ? { storageUrl: expectedPodUrl, webId: requestedWebId, podId: match.podId } : undefined;
      }

      return undefined;
    } catch (error) {
      logger.warn(`Failed to verify existing pod ownership for ${podName}: ${(error as Error).message}`);
      return undefined;
    }
  }

  // Pod deletion runs in CSS with its actual data accessor, indexes and AccountStorage.
  // Direct API callers fail closed instead of removing only a filesystem directory.
  server.delete('/provision/pods/:podName', async (_request, response) => {
    response.setHeader('Allow', 'GET');
    sendJson(response, 405, { error: 'POD_DELETE_USE_GATEWAY', message: 'Pod deletion must use the Gateway lifecycle endpoint' });
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

function createReceipt(input: { secret: string | undefined; podName: string; podUrl: string; webId: string; podId?: string }): string | undefined {
  if (!input.secret) {
    return undefined;
  }
  return createProvisionReceipt({
    secret: input.secret,
    podName: input.podName,
    webId: input.webId,
    podUrl: input.podUrl,
    podId: input.podId,
  });
}

function sendAuthorizationFailure(response: ServerResponse, status: number): void {
  if (status >= 500) { sendJson(response, 502, { error: 'POD_DELETE_NODE_UNAVAILABLE' }); return; }
  sendJson(response, status === 409 ? 409 : 403, { error: status === 409 ? 'POD_DELETE_AUTHORIZATION_CONFLICT' : 'POD_DELETE_AUTHORIZATION_INVALID' });
}

/**
 * 读取 JSON 请求体
 */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      if (tooLarge) { return; }
      if (Buffer.byteLength(data) + Buffer.byteLength(chunk) > 1_048_576) { tooLarge = true; data = ''; reject(new Error('Request body too large')); return; }
      data += chunk;
    });
    request.on('end', () => {
      if (tooLarge) { return; }
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

function getFirstWebId(pod: { webId?: string; webIds?: string[] } | undefined): string | undefined {
  return typeof pod?.webId === 'string' ? pod.webId : pod?.webIds?.find((webId) => typeof webId === 'string');
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

function normalizeStorageRoot(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return ensureTrailingSlash(new URL(url).toString());
  } catch {
    return undefined;
  }
}

function storageUrlBelongsToRoot(storageUrl: string | undefined, storageRoot: string): boolean {
  if (!storageUrl) {
    return false;
  }
  try {
    return ensureTrailingSlash(new URL(storageUrl).toString()).startsWith(storageRoot);
  } catch {
    return false;
  }
}

function canonicalizeStorageProviderUrl(storageUrl: string | undefined, storageRoot: string): string | undefined {
  if (!storageUrl) {
    return undefined;
  }
  try {
    const url = new URL(storageUrl);
    const normalized = ensureTrailingSlash(url.toString());
    if (normalized.startsWith(storageRoot)) {
      return normalized;
    }

    const root = new URL(storageRoot);
    if (isLoopbackUrl(url) && !isLoopbackUrl(root)) {
      const rewritten = new URL(url.pathname.replace(/^\/+/u, ''), root);
      return ensureTrailingSlash(rewritten.toString());
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildPodUrl(storageRoot: string, podName: string): string {
  return ensureTrailingSlash(new URL(`${encodeURIComponent(podName)}/`, storageRoot).toString());
}

function getRootRelativePodName(storageUrl: string | undefined, storageRoot: string): string | undefined {
  if (!storageUrl) {
    return undefined;
  }

  try {
    const normalizedStorageUrl = ensureTrailingSlash(new URL(storageUrl).toString());
    const normalizedRoot = ensureTrailingSlash(new URL(storageRoot).toString());
    if (!normalizedStorageUrl.startsWith(normalizedRoot)) {
      return undefined;
    }

    const relativePath = normalizedStorageUrl.slice(normalizedRoot.length);
    const segment = relativePath.split('/').find(Boolean);
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackUrl(url: URL): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
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
