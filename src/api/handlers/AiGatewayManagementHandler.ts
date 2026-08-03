import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import type { SolidAuthContext } from '../auth/AuthContext';
import type { GatewayDeployment } from '../ai-gateway/auth/InvocationTokenCodec';
import type {
  CompleteApiKeyInput,
  ConnectBeginInput,
  ProviderConnectService,
} from '../ai-gateway/connect';
import type { ProviderQuotaService } from '../ai-gateway/quota';
import { createAiConnectionServiceAccess } from '../ai-gateway/service-access/AiConnectionServiceAccess';
import type { AiConnectionInvocationKeyIssuer } from '../ai-gateway/auth/AiConnectionInvocationKeyIssuer';
import {
  type AiClientConfigurationCapabilityDescriptor,
  unavailableAiClientConfigurationCapability,
} from '../service/AiClientConfigurationService';

export interface AiGatewayManagementHandlerOptions {
  deployment: GatewayDeployment;
  connectService?: ProviderConnectService;
  quotaService?: ProviderQuotaService;
  aiClientConfiguration?: AiClientConfigurationCapabilityDescriptor;
  aiConnectionInvocationKeyIssuer?: Pick<AiConnectionInvocationKeyIssuer, 'issueClientConfiguration'>;
  now?: () => Date;
  jsonBodyLimitBytes?: number;
}

export function registerAiGatewayManagementRoutes(
  server: ApiServer,
  options: AiGatewayManagementHandlerOptions,
): void {
  const jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? 64 * 1024;

  server.get('/api/applets/service-access/ai-connection', async (request, response) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const descriptor = createAiConnectionServiceAccess({
      ownerWebId: request.auth.webId,
      serviceWebId: request.auth.webId,
    });
    const invocation = options.aiConnectionInvocationKeyIssuer
      ? await options.aiConnectionInvocationKeyIssuer.issueClientConfiguration({ auth: request.auth })
      : undefined;
    sendJson(response, 200, {
      ...descriptor,
      aiClientConfiguration: options.aiClientConfiguration ?? unavailableAiClientConfigurationCapability(),
      ...(invocation ? { invocation } : {}),
    });
  });

  server.get('/api/ai/connections/providers', async (request, response) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const providers = await connectService.listProviders({
      webId: request.auth!.webId,
      deployment: options.deployment,
      auth: request.auth,
    });
    sendJson(response, 200, {
      data: publicConnectResult(providers),
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
      auth: request.auth,
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
      auth: request.auth,
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
      auth: request.auth,
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
      auth: request.auth,
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
      auth: request.auth,
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
      auth: request.auth,
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
        auth: request.auth,
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
        auth: request.auth,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendQuotaError(response, error);
    }
  });
}

function authorizeManagementCaller(
  request: AuthenticatedRequest,
  response: ServerResponse,
  options: {
    nonSolidPrincipalError: string;
  },
): boolean {
  const auth = request.auth;
  if (!auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (auth.type === 'solid' && auth.webId) {
    return true;
  }
  sendJson(response, 403, { error: options.nonSolidPrincipalError });
  return false;
}

function authorizeCurrentSolidManagement(
  request: AuthenticatedRequest,
  response: ServerResponse,
  options: {
    nonSolidPrincipalError: string;
  },
): request is AuthenticatedRequest & { auth: SolidAuthContext } {
  if (!authorizeManagementCaller(request, response, options)) {
    return false;
  }
  const auth = request.auth;
  if (!auth || auth.type !== 'solid' || !auth.webId) {
    sendJson(response, 403, { error: 'Insufficient permissions' });
    return false;
  }
  return true;
}

function authorizeProviderConnect(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  return authorizeCurrentSolidManagement(request, response, {
    nonSolidPrincipalError: 'Provider Connect requires the current Solid identity',
  });
}

function authorizeProviderQuota(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  return authorizeCurrentSolidManagement(request, response, {
    nonSolidPrincipalError: 'Provider quota requires the current Solid identity',
  });
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

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringBody(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
    provider: record.provider,
    authMode: record.authMode,
    status: record.status,
    accountLabel: record.accountLabel,
    expiresAt: record.expiresAt?.toISOString(),
    version: record.version,
    reauthRequired: record.reauthRequired,
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
      .filter(([key]) => ![
        'deployment',
        'webId',
        'encryptedSecret',
        'metadata',
      ].includes(key))
      .map(([key, item]) => [key, publicConnectResult(item)]),
  );
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
