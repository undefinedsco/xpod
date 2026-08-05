import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import type { SolidAuthContext } from '../auth/AuthContext';
import type { GatewayDeployment } from '../ai-gateway/auth/InvocationTokenCodec';
import { GatewayProtocolError } from '../ai-gateway/errors';
import type {
  CompleteApiKeyInput,
  ConnectBeginInput,
  ProviderConnectService,
} from '../ai-gateway/connect';
import type { ProviderModelSelectionService } from '../ai-gateway/models/ProviderModelSelectionService';
import {
  createDefaultProviderRegistry,
  normalizeProviderId,
  type ProviderRegistry,
} from '../ai-gateway/providers/ProviderRegistry';
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
  providerModelSelectionService?: ProviderModelSelectionServicePort;
  modelSelectionService?: ProviderModelSelectionServicePort;
  selectionService?: ProviderModelSelectionServicePort;
  providerRegistry?: ProviderRegistry;
  aiClientConfiguration?: AiClientConfigurationCapabilityDescriptor;
  aiConnectionInvocationKeyIssuer?: Pick<AiConnectionInvocationKeyIssuer, 'issueClientConfiguration'>;
  now?: () => Date;
  jsonBodyLimitBytes?: number;
}

const MAX_SELECTED_MODELS = 100;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_SELECTION_VERSION_LENGTH = 256;
const SAFE_MODEL_ERROR_CLASSIFICATIONS = new Set([
  'authentication',
  'authorization',
  'invalid_response',
  'network_error',
  'not_configured',
  'pagination_cursor_missing',
  'pagination_cursor_repeated',
  'pagination_limit',
  'provider_error',
  'rate_limited',
  'unsafe_base_url',
  'upstream_unavailable',
]);

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
    try {
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
    } catch (error) {
      const stage = credentialPersistenceFailureStage(error);
      if (!stage) {
        throw error;
      }
      sendJson(response, 500, { error: 'credential_persistence_failed', stage });
    }
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

  server.post('/api/ai/gateway/providers/:provider/models/discover', async (request, response, params) => {
    if (!authorizeProviderModels(request, response)) {
      return;
    }
    if (!knownModelProvider(params.provider, options, response)) {
      return;
    }
    const selectionService = requireModelSelectionService(options, response);
    if (!selectionService) {
      return;
    }
    try {
      const catalog = await selectionService.discover({
        webId: request.auth.webId,
        provider: params.provider,
        deployment: options.deployment,
        auth: request.auth,
        forceRefresh: true,
      });
      sendJson(response, 200, catalog);
    } catch (error) {
      sendModelSelectionError(response, error);
    }
  });

  server.get('/api/ai/gateway/providers/:provider/models', async (request, response, params) => {
    if (!authorizeProviderModels(request, response)) {
      return;
    }
    if (!knownModelProvider(params.provider, options, response)) {
      return;
    }
    const selectionService = requireModelSelectionService(options, response);
    if (!selectionService) {
      return;
    }
    try {
      const catalogInput = {
        webId: request.auth.webId,
        provider: params.provider,
        deployment: options.deployment,
        auth: request.auth,
      };
      const catalog = selectionService.getCatalog
        ? await selectionService.getCatalog(catalogInput)
        : selectionService.listCatalog
          ? await selectionService.listCatalog(catalogInput)
          : undefined;
      if (!catalog) {
        sendJson(response, 503, { error: 'AI provider model selection service is not configured' });
        return;
      }
      sendJson(response, 200, catalog);
    } catch (error) {
      sendModelSelectionError(response, error);
    }
  });

  // Keep registration tolerant of lightweight legacy test doubles that only
  // implement the original GET/POST/DELETE convenience methods. ApiServer
  // always exposes put in production.
  if (typeof server.put === 'function') {
    server.put('/api/ai/gateway/providers/:provider/models/selection', async (request, response, params) => {
      if (!authorizeProviderModels(request, response)) {
        return;
      }
      if (!knownModelProvider(params.provider, options, response)) {
        return;
      }
      const body = await readJsonObject(request, response, jsonBodyLimitBytes);
      if (!body) {
        return;
      }
      const selectionInput = parseModelSelectionBody(body, response);
      if (!selectionInput) {
        return;
      }
      const selectionService = requireModelSelectionService(options, response);
      if (!selectionService) {
        return;
      }
      try {
        const catalog = await selectionService.replaceSelection({
          webId: request.auth.webId,
          provider: params.provider,
          modelIds: selectionInput.modelIds,
          defaultModel: selectionInput.defaultModel,
          expectedVersion: selectionInput.expectedVersion,
          deployment: options.deployment,
          auth: request.auth,
        });
        sendJson(response, 200, catalog);
      } catch (error) {
        sendModelSelectionError(response, error);
      }
    });
  }

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

function credentialPersistenceFailureStage(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const match = /^credential_persistence_failed:([a-z][a-z0-9-]*)$/u.exec(error.message);
  return match?.[1];
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

function authorizeProviderModels(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  return authorizeCurrentSolidManagement(request, response, {
    nonSolidPrincipalError: 'Provider model management requires the current Solid identity',
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

type ProviderModelSelectionServicePort = Pick<ProviderModelSelectionService, 'discover' | 'replaceSelection'>
  & Partial<Pick<ProviderModelSelectionService, 'getCatalog' | 'listCatalog'>>;

function requireModelSelectionService(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): ProviderModelSelectionServicePort | undefined {
  const service = options.providerModelSelectionService
    ?? options.modelSelectionService
    ?? options.selectionService;
  if (!service) {
    sendJson(response, 503, { error: 'AI provider model selection service is not configured' });
    return undefined;
  }
  return service;
}

function knownModelProvider(
  provider: string,
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): boolean {
  const registry = options.providerRegistry ?? createDefaultProviderRegistry();
  try {
    registry.requireProvider(provider);
    return true;
  } catch {
    sendModelSelectionError(response, new GatewayProtocolError('provider_not_configured', {
      code: 'invalid_request',
      status: 400,
      details: { provider: normalizeProviderId(provider), classification: 'not_configured' },
    }));
    return false;
  }
}

function parseModelSelectionBody(
  body: Record<string, unknown>,
  response: ServerResponse,
): { modelIds: string[]; defaultModel?: string; expectedVersion: string } | undefined {
  if (!Array.isArray(body.modelIds)) {
    sendJson(response, 400, { error: 'modelIds must be an array of strings' });
    return undefined;
  }
  if (body.modelIds.length > MAX_SELECTED_MODELS) {
    sendJson(response, 400, { error: `modelIds must contain at most ${MAX_SELECTED_MODELS} models` });
    return undefined;
  }
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const value of body.modelIds) {
    if (typeof value !== 'string') {
      sendJson(response, 400, { error: 'modelIds must contain only strings' });
      return undefined;
    }
    const modelId = value.trim();
    if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) {
      sendJson(response, 400, { error: `modelIds entries must be 1-${MAX_MODEL_ID_LENGTH} characters` });
      return undefined;
    }
    const dedupeKey = canonicalModelId(modelId);
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      modelIds.push(modelId);
    }
  }

  const expectedVersion = normalizeOptionalString(body.expectedVersion);
  if (!expectedVersion || expectedVersion.length > MAX_SELECTION_VERSION_LENGTH) {
    sendJson(response, 400, { error: `expectedVersion must be 1-${MAX_SELECTION_VERSION_LENGTH} characters` });
    return undefined;
  }

  let defaultModel: string | undefined;
  if (body.defaultModel !== undefined) {
    if (typeof body.defaultModel !== 'string') {
      sendJson(response, 400, { error: 'defaultModel must be a string' });
      return undefined;
    }
    defaultModel = body.defaultModel.trim();
    if (!defaultModel || defaultModel.length > MAX_MODEL_ID_LENGTH) {
      sendJson(response, 400, { error: `defaultModel must be 1-${MAX_MODEL_ID_LENGTH} characters` });
      return undefined;
    }
  }

  return { modelIds, ...(defaultModel ? { defaultModel } : {}), expectedVersion };
}

function canonicalModelId(modelId: string): string {
  const fragmentIndex = modelId.lastIndexOf('#');
  return fragmentIndex >= 0 ? modelId.slice(fragmentIndex + 1) : modelId;
}

function sendModelSelectionError(response: ServerResponse, error: unknown): void {
  const normalized = normalizeModelSelectionError(error);
  sendJson(response, normalized.status, {
    error: {
      code: normalized.code,
      message: normalized.message,
      status: normalized.status,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  });
}

function normalizeModelSelectionError(error: unknown): {
  code: 'invalid_request' | 'credential_unavailable' | 'provider_error' | 'internal_error';
  message: string;
  status: 400 | 401 | 409 | 429 | 502;
  details?: Record<string, unknown>;
} {
  if (!(error instanceof GatewayProtocolError)) {
    if (error instanceof Error) {
      const stablePlainErrors: Record<string, {
        code: 'invalid_request' | 'credential_unavailable' | 'provider_error' | 'internal_error';
        message: string;
        status: 400 | 401 | 409 | 429 | 502;
      }> = {
        active_credential_required: {
          code: 'credential_unavailable',
          message: 'active_credential_required',
          status: 401,
        },
        model_not_in_discovered_catalog: {
          code: 'invalid_request',
          message: 'model_not_in_discovered_catalog',
          status: 400,
        },
        model_selection_default_not_picked: {
          code: 'invalid_request',
          message: 'model_selection_default_not_picked',
          status: 400,
        },
        model_selection_version_conflict: {
          code: 'invalid_request',
          message: 'model_selection_version_conflict',
          status: 409,
        },
      };
      const stable = stablePlainErrors[error.message];
      if (stable) {
        return stable;
      }
    }
    return {
      code: 'provider_error',
      message: 'Provider model discovery failed',
      status: 502,
    };
  }

  const details = safeModelErrorDetails(error.details);
  const status = modelSelectionErrorStatus(error, details);
  const code = error.code === 'credential_unavailable'
    ? 'credential_unavailable'
    : error.code === 'provider_error'
      ? 'provider_error'
      : error.code === 'internal_error'
        ? 'internal_error'
        : 'invalid_request';
  return {
    code,
    message: safeModelErrorMessage(error, details),
    status,
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function modelSelectionErrorStatus(
  error: GatewayProtocolError,
  details: Record<string, unknown>,
): 400 | 401 | 409 | 429 | 502 {
  if (details.reauthRequired === true || error.code === 'credential_unavailable') {
    return 401;
  }
  if (error.status === 409) {
    return 409;
  }
  if (error.status === 429) {
    return 429;
  }
  if (error.status === 400) {
    return 400;
  }
  if (error.status === 401) {
    return 401;
  }
  return 502;
}

function safeModelErrorMessage(error: GatewayProtocolError, details: Record<string, unknown>): string {
  const stableMessages = new Set([
    'active_credential_required',
    'model_catalog_not_ready',
    'model_not_in_discovered_catalog',
    'model_selection_default_not_picked',
    'model_selection_version_conflict',
    'provider_not_configured',
    'provider_required',
  ]);
  if (stableMessages.has(error.message)) {
    return error.message;
  }
  if (details.classification === 'unsafe_base_url') {
    return 'provider_endpoint_not_allowed';
  }
  if (details.classification === 'not_configured') {
    return 'provider_not_configured';
  }
  if (error.code === 'provider_error') {
    return 'Provider model discovery failed';
  }
  return 'AI model selection request failed';
}

function safeModelErrorDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) {
    return {};
  }
  const safe: Record<string, unknown> = {};
  if (typeof details.provider === 'string' && /^[a-z0-9_-]{1,64}$/iu.test(details.provider)) {
    safe.provider = details.provider;
  }
  if (typeof details.providerStatusCode === 'number'
    && Number.isInteger(details.providerStatusCode)
    && details.providerStatusCode >= 400
    && details.providerStatusCode <= 599) {
    safe.providerStatusCode = details.providerStatusCode;
  }
  if (typeof details.retryAfter === 'string' && details.retryAfter.length <= 64) {
    safe.retryAfter = details.retryAfter;
  }
  if (typeof details.reauthRequired === 'boolean') {
    safe.reauthRequired = details.reauthRequired;
  } else if (details.requiresReauth === true) {
    safe.reauthRequired = true;
  }
  if (typeof details.classification === 'string' && SAFE_MODEL_ERROR_CLASSIFICATIONS.has(details.classification)) {
    safe.classification = details.classification;
  }
  return safe;
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
