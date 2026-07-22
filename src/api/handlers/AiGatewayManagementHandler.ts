import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
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

export interface AiGatewayManagementHandlerOptions {
  repository: GatewayAccessKeyRepository;
  deployment: GatewayDeployment;
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

    const bodyResult = await readJsonBody(request, jsonBodyLimitBytes);
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

function publicRecord(record: GatewayAccessKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    owner: record.owner,
    deployment: record.deployment,
    scopes: record.scopes,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString(),
    revokedAt: record.revokedAt?.toISOString(),
    name: record.name,
  };
}

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

function readJsonBody(request: AuthenticatedRequest, limitBytes: number): Promise<JsonBodyResult> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limitBytes) {
        tooLarge = true;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        resolve({ ok: false, status: 413, error: 'Request body too large' });
        return;
      }
      if (!body.trim()) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(body) });
      } catch {
        resolve({ ok: false, status: 400, error: 'Request body must be valid JSON' });
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
