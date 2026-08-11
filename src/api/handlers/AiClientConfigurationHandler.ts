import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import type { AuthContext } from '../auth/AuthContext';
import {
  AiClientConfigurationError,
  type AiClientConfigurationService,
  type AiClientId,
  redactSecretText,
  unavailableAiClientConfigurationCapability,
} from '../service/AiClientConfigurationService';

export interface AiClientConfigurationHandlerOptions {
  service?: AiClientConfigurationService;
  jsonBodyLimitBytes?: number;
}

export function registerAiClientConfigurationRoutes(
  server: ApiServer,
  options: AiClientConfigurationHandlerOptions,
): void {
  const jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? 16 * 1024;

  server.get('/api/ai/client-configuration/capability', async (request, response) => {
    if (!authorizeCapability(request, response)) {
      return;
    }
    sendJson(response, 200, options.service?.capability() ?? unavailableAiClientConfigurationCapability());
  });

  server.get('/api/ai/client-configuration/:client', async (request, response, params) => {
    if (!requireService(options, response)) return;
    if (!authorizeClientConfig(request, response, 'client-config:read')) {
      return;
    }
    await sendServiceResult(response, () => options.service!.inspect(requireClient(params.client)));
  });

  server.post('/api/ai/client-configuration/:client/plan', async (request, response, params) => {
    if (!requireService(options, response)) return;
    if (!authorizeClientConfig(request, response, 'client-config:write')) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    await sendServiceResult(response, () => options.service!.plan({
      client: requireClient(params.client),
      endpoint: requireString(body.endpoint, 'endpoint'),
      model: optionalString(body.model),
      auth: request.auth,
      webId: request.auth?.type === 'solid' ? request.auth.webId : optionalString(body.webId),
    }));
  });

  server.post('/api/ai/client-configuration/:client/apply', async (request, response, params) => {
    if (!requireService(options, response)) return;
    if (!authorizeClientConfig(request, response, 'client-config:write')) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    await sendServiceResult(response, () => options.service!.apply({
      client: requireClient(params.client),
      planId: requireString(body.planId, 'planId'),
      gatewayKey: requireString(body.apiKey, 'apiKey'),
      auth: request.auth,
      confirmation: optionalConfirmation(body.confirmation),
      webId: request.auth?.type === 'solid' ? request.auth.webId : optionalString(body.webId),
    }));
  });

  server.post('/api/ai/client-configuration/:client/verify', async (request, response, params) => {
    if (!requireService(options, response)) return;
    if (!authorizeClientConfig(request, response, 'client-config:read')) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    await sendServiceResult(response, () => options.service!.verify({
      client: requireClient(params.client),
      planId: optionalString(body.planId),
    }));
  });

  server.post('/api/ai/client-configuration/:client/restore', async (request, response, params) => {
    if (!requireService(options, response)) return;
    if (!authorizeClientConfig(request, response, 'client-config:write')) {
      return;
    }
    await sendServiceResult(response, () => options.service!.restore(
      requireClient(params.client),
      request.auth?.type === 'solid' ? request.auth.webId : undefined,
    ));
  });
}

function requireService(options: AiClientConfigurationHandlerOptions, response: ServerResponse): boolean {
  if (options.service) return true;
  sendJson(response, 503, safeErrorPayload(new AiClientConfigurationError(
    'client_configuration_unavailable',
    'Local AI client configuration is unavailable on this host.',
    503,
    { aiClientConfiguration: unavailableAiClientConfigurationCapability() },
  )));
  return false;
}

function authorizeCapability(request: AuthenticatedRequest, response: ServerResponse): boolean {
  if (request.auth?.type === 'solid' || request.auth?.type === 'service') {
    return true;
  }
  sendJson(response, 401, safeErrorPayload(new AiClientConfigurationError(
    'authentication_required',
    'Authentication required.',
    401,
  )));
  return false;
}

function authorizeClientConfig(
  request: AuthenticatedRequest,
  response: ServerResponse,
  scope: 'client-config:read' | 'client-config:write',
): boolean {
  const auth = request.auth;
  if (!auth) {
    sendJson(response, 401, safeErrorPayload(new AiClientConfigurationError('authentication_required', 'Authentication required.', 401)));
    return false;
  }
  if (hasClientConfigScope(auth, scope)) {
    return true;
  }
  sendJson(response, 403, safeErrorPayload(new AiClientConfigurationError('insufficient_permissions', 'Insufficient permissions.', 403)));
  return false;
}

function hasClientConfigScope(auth: AuthContext, scope: 'client-config:read' | 'client-config:write'): boolean {
  const scopes = readScopes(auth);
  if (!scopes.includes(scope)) {
    return false;
  }
  if (auth.type === 'service') {
    return true;
  }
  return auth.type === 'solid' && auth.internalInvocation === true;
}

function readScopes(auth: AuthContext): string[] {
  if (auth.type === 'service') {
    return auth.scopes;
  }
  if (auth.type === 'solid' && auth.internalInvocation === true) {
    return auth.scopes ?? [];
  }
  return [];
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
  if (!bodyResult.value || typeof bodyResult.value !== 'object' || Array.isArray(bodyResult.value)) {
    sendJson(response, 400, { error: 'Request body must be a JSON object' });
    return undefined;
  }
  return bodyResult.value as Record<string, unknown>;
}

async function sendServiceResult(response: ServerResponse, action: () => Promise<unknown>): Promise<void> {
  try {
    sendJson(response, 200, await action());
  } catch (error) {
    if (error instanceof AiClientConfigurationError) {
      sendJson(response, error.statusCode, safeErrorPayload(error));
      return;
    }
    sendJson(response, 500, safeErrorPayload(new AiClientConfigurationError(
      'client_configuration_failed',
      redactSecretText(error instanceof Error ? error.message : 'Unknown error'),
      500,
    )));
  }
}

function requireClient(value: string | undefined): AiClientId {
  if (value === 'codex' || value === 'claude-code' || value === 'pi' || value === 'codebuddy') {
    return value;
  }
  throw new AiClientConfigurationError('unsupported_client', 'Unsupported AI client.', 404);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AiClientConfigurationError('invalid_request', `${field} must be a non-empty string.`, 400);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalConfirmation(value: unknown): { token: string; targetHash: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const token = optionalString(record.token);
  const targetHash = optionalString(record.targetHash);
  return token && targetHash ? { token, targetHash } : undefined;
}

function safeErrorPayload(error: AiClientConfigurationError): { code: string; message: string; details?: unknown } {
  return {
    code: error.code,
    message: redactSecretText(error.message),
    ...(error.details ? { details: redactDetails(error.details) } : {}),
  };
}

function redactDetails(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactSecretText(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactDetails);
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/path|secret|token|key/iu.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactDetails(entry);
    }
  }
  return output;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}
