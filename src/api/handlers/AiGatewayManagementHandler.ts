import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import {
  canManageGatewayKeys,
  isGatewayApiKeyPrincipal,
  ownerWebIdForGatewayKeyManagement,
} from '../ai-gateway/auth/GatewayPrincipal';
import {
  createGatewayApiKey,
  createGatewayKeyId,
  type GatewayDeployment,
} from '../ai-gateway/auth/GatewayApiKey';
import type {
  GatewayAccessKeyRecord,
  GatewayAccessKeyRepository,
} from '../ai-gateway/auth/GatewayApiKeyAuthenticator';
import { DEFAULT_GATEWAY_API_KEY_SCOPES } from '../ai-gateway/auth/GatewayApiKeyAuthenticator';
import type {
  CompleteApiKeyInput,
  ConnectBeginInput,
  ProviderConnectService,
} from '../ai-gateway/connect';
import type { ProviderQuotaService } from '../ai-gateway/quota';

export interface AiGatewayManagementHandlerOptions {
  repository: GatewayAccessKeyRepository;
  deployment: GatewayDeployment;
  connectService?: ProviderConnectService;
  quotaService?: ProviderQuotaService;
  now?: () => Date;
  keyId?: (owner: string) => string;
  jsonBodyLimitBytes?: number;
}

export function registerAiGatewayManagementRoutes(
  server: ApiServer,
  options: AiGatewayManagementHandlerOptions,
): void {
  const now = options.now ?? (() => new Date());
  const createKeyId = options.keyId ?? ((owner: string) => (
    options.repository.createKeyId?.(owner, options.deployment) ?? createGatewayKeyId()
  ));
  const jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? 64 * 1024;

  server.post('/api/ai/gateway/keys', async (request, response) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }

    const bodyResult = await readBoundedJsonBody(request, { limitBytes: jsonBodyLimitBytes });
    if (!bodyResult.ok) {
      sendJson(response, bodyResult.status, { error: bodyResult.error });
      return;
    }
    const body = bodyResult.value;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }
    const payload = body as Record<string, unknown>;
    const owner = ownerWebIdForGatewayKeyManagement(request.auth!, payload.owner);
    if (!owner) {
      sendJson(response, 400, { error: 'Gateway key owner WebID is required' });
      return;
    }
    const scopes = normalizeScopes(payload.scopes);
    if (!scopes) {
      sendJson(response, 400, { error: 'scopes must be a non-empty string array' });
      return;
    }
    const expiresAt = normalizeOptionalDate(payload.expiresAt);
    if (payload.expiresAt !== undefined && !expiresAt) {
      sendJson(response, 400, { error: 'expiresAt must be an ISO date string' });
      return;
    }

    const issued = await createGatewayApiKey({
      deployment: options.deployment,
      keyId: createKeyId(owner),
    });
    const createdAt = now();
    const record = await options.repository.create({
      ...issued.record,
      owner,
      scopes,
      createdAt,
      expiresAt,
      name: normalizeOptionalString(payload.name),
    }, { auth: request.auth });

    sendJson(response, 201, {
      key: issued.plaintext,
      record: publicRecord(record),
    });
  });

  server.get('/api/ai/gateway/keys', async (request, response) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }

    const owner = ownerForList(request);
    if (!owner) {
      sendJson(response, 400, { error: 'Gateway key owner WebID is required' });
      return;
    }
    const records = await options.repository.listByOwner(owner, { auth: request.auth });
    sendJson(response, 200, {
      data: records.map(publicRecord),
    });
  });

  server.delete('/api/ai/gateway/keys/:keyId', async (request, response, params) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }

    const keyId = decodeURIComponent(params.keyId);
    const existing = await options.repository.findById(keyId);
    if (!existing) {
      sendJson(response, 404, { error: 'Gateway key not found' });
      return;
    }
    const owner = ownerForList(request);
    if (!owner || existing.owner !== owner) {
      sendJson(response, 403, { error: 'Cannot revoke a gateway key owned by another WebID' });
      return;
    }
    const revoked = await options.repository.revoke(keyId, now(), { auth: request.auth });
    sendJson(response, 200, {
      record: revoked ? publicRecord(revoked) : undefined,
    });
  });

  server.post('/api/ai/gateway/providers/:provider/connect/begin', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const mode = typeof body.mode === 'string' ? body.mode : undefined;
    if (mode !== 'browserAssistedApiKey' && mode !== 'deviceCodeOAuth' && mode !== 'connectUnsupported') {
      sendJson(response, 400, { error: 'mode must be a supported Connect mode' });
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const result = await connectService.begin({
      webId: request.auth!.webId,
      deployment: options.deployment,
      provider: params.provider,
      requestedMode: mode,
      expectedCredentialVersion: typeof body.expectedCredentialVersion === 'number'
        ? body.expectedCredentialVersion
        : undefined,
    } satisfies ConnectBeginInput);
    sendJson(response, 200, publicConnectResult(result));
  });

  server.get('/api/ai/gateway/providers/:provider/connect/status/:attemptId', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const result = await connectService.status({
      webId: request.auth!.webId,
      deployment: options.deployment,
      provider: params.provider,
      attemptId: decodeURIComponent(params.attemptId),
      state: url.searchParams.get('state') ?? '',
      signature: url.searchParams.get('signature') ?? '',
    });
    sendJson(response, 200, publicConnectResult(result));
  });

  server.post('/api/ai/gateway/providers/:provider/connect/complete-api-key', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const apiKey = normalizeOptionalString(body.apiKey);
    if (!apiKey) {
      sendJson(response, 400, { error: 'apiKey is required' });
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const result = await connectService.completeApiKey({
      webId: request.auth!.webId,
      deployment: options.deployment,
      provider: params.provider,
      attemptId: stringBody(body.attemptId),
      state: stringBody(body.state),
      signature: stringBody(body.signature),
      apiKey,
      accountLabel: normalizeOptionalString(body.accountLabel),
    } satisfies CompleteApiKeyInput);
    sendJson(response, 200, publicConnectResult(result));
  });

  server.post('/api/ai/gateway/providers/:provider/connect/poll', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const result = await connectService.pollDevice({
      webId: request.auth!.webId,
      deployment: options.deployment,
      provider: params.provider,
      attemptId: stringBody(body.attemptId),
      state: stringBody(body.state),
      signature: stringBody(body.signature),
    });
    sendJson(response, 200, publicConnectResult(result));
  });

  server.post('/api/ai/gateway/providers/:provider/connect/refresh', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const record = await connectService.refresh({
      webId: request.auth!.webId,
      deployment: options.deployment,
      provider: params.provider,
    });
    sendJson(response, 200, { record: record ? publicCredentialRecord(record) : undefined });
  });

  server.delete('/api/ai/gateway/providers/:provider/connect', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const record = await connectService.disconnect({
      webId: request.auth!.webId,
      deployment: options.deployment,
      provider: params.provider,
    });
    sendJson(response, 200, { record: record ? publicCredentialRecord(record) : undefined });
  });

  server.get('/api/ai/gateway/providers/:provider/connect/callback', async (_request, response) => {
    // This endpoint is intentionally public only for signed one-time OAuth callbacks.
    // Browser-assisted API key completion is never accepted here because API keys
    // must be submitted through the authenticated management API.
    sendJson(response, 405, {
      error: 'Public Connect callback is unsupported for current provider Connect modes',
    });
  }, { public: true });

  server.get('/api/ai/gateway/providers/:provider/quota/status', async (request, response, params) => {
    if (!authorizeProviderQuota(request, response)) {
      return;
    }
    const quotaService = requireQuotaService(options, response);
    if (!quotaService) {
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      const result = await quotaService.status({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialIri: normalizeOptionalString(url.searchParams.get('credentialIri')),
        refresh: false,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendQuotaError(response, error);
    }
  });

  server.post('/api/ai/gateway/providers/:provider/quota/refresh', async (request, response, params) => {
    if (!authorizeProviderQuota(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const quotaService = requireQuotaService(options, response);
    if (!quotaService) {
      return;
    }
    try {
      const result = await quotaService.status({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialIri: normalizeOptionalString(body.credentialIri),
        refresh: true,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendQuotaError(response, error);
    }
  });
}

function authorizeGatewayKeyManagement(
  request: AuthenticatedRequest,
  response: ServerResponse,
): boolean {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (isGatewayApiKeyPrincipal(request.auth)) {
    sendJson(response, 403, { error: 'Gateway API keys cannot manage gateway keys' });
    return false;
  }
  if (!canManageGatewayKeys(request.auth)) {
    sendJson(response, 403, { error: 'Insufficient permissions' });
    return false;
  }
  return true;
}

function authorizeProviderConnect(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (isGatewayApiKeyPrincipal(request.auth)) {
    sendJson(response, 403, { error: 'Gateway API keys cannot manage provider Connect state' });
    return false;
  }
  if (request.auth.type !== 'solid' || !request.auth.webId) {
    sendJson(response, 403, { error: 'Provider Connect requires the current Solid identity' });
    return false;
  }
  return true;
}

function authorizeProviderQuota(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (isGatewayApiKeyPrincipal(request.auth)) {
    sendJson(response, 403, { error: 'Gateway API keys cannot manage provider quota state' });
    return false;
  }
  if (request.auth.type !== 'solid' || !request.auth.webId) {
    sendJson(response, 403, { error: 'Provider quota requires the current Solid identity' });
    return false;
  }
  return true;
}

function requireConnectService(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): ProviderConnectService | undefined {
  if (!options.connectService) {
    sendJson(response, 503, { error: 'AI provider Connect service is not configured' });
    return undefined;
  }
  return options.connectService;
}

function requireQuotaService(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): ProviderQuotaService | undefined {
  if (!options.quotaService) {
    sendJson(response, 503, { error: 'AI provider quota service is not configured' });
    return undefined;
  }
  return options.quotaService;
}

function sendQuotaError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'quota_credential_not_found') {
    sendJson(response, 404, { error: 'Provider credential not found for current identity' });
    return;
  }
  if (message.startsWith('quota_adapter_not_found:')) {
    sendJson(response, 404, { error: 'Provider quota adapter not found' });
    return;
  }
  sendJson(response, 500, { error: 'Provider quota lookup failed' });
}

async function readJsonObject(
  request: AuthenticatedRequest,
  response: ServerResponse,
  limitBytes: number,
): Promise<Record<string, unknown> | undefined> {
  const bodyResult = await readBoundedJsonBody(request, { limitBytes });
  if (!bodyResult.ok) {
    sendJson(response, bodyResult.status, { error: bodyResult.error });
    return undefined;
  }
  const body = bodyResult.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'Request body must be a JSON object' });
    return undefined;
  }
  return body as Record<string, unknown>;
}

function ownerForList(request: AuthenticatedRequest): string | undefined {
  if (request.auth?.type === 'solid') {
    return request.auth.webId;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  return url.searchParams.get('owner') ?? undefined;
}

function normalizeScopes(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [...DEFAULT_GATEWAY_API_KEY_SCOPES];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const scopes = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  if (scopes.length !== value.length) {
    return undefined;
  }
  return [...new Set(scopes)];
}

function normalizeOptionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringBody(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function publicRecord(record: GatewayAccessKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    owner: record.owner,
    scopes: record.scopes,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString(),
    revokedAt: record.revokedAt?.toISOString(),
    name: record.name,
  };
}

function publicCredentialRecord(record: {
  id: string;
  credentialIri: string;
  webId: string;
  provider: string;
  deployment: string;
  authMode: string;
  status: string;
  accountLabel?: string;
  expiresAt?: Date;
  version?: number;
  reauthRequired?: boolean;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: record.id,
    credentialIri: record.credentialIri,
    webId: record.webId,
    provider: record.provider,
    authMode: record.authMode,
    status: record.status,
    accountLabel: record.accountLabel,
    expiresAt: record.expiresAt?.toISOString(),
    version: record.version,
    reauthRequired: record.reauthRequired,
    metadata: record.metadata,
  };
}

function publicConnectResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(publicConnectResult);
  }
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'deployment')
      .map(([key, item]) => [key, publicConnectResult(item)]),
  );
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
