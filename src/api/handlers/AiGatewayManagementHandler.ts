import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import {
  canManageGatewayKeys,
  isInternalGatewayInvocationPrincipal,
  isGatewayApiKeyPrincipal,
  ownerWebIdForGatewayKeyManagement,
} from '../ai-gateway/auth/GatewayPrincipal';
import type { SolidAuthContext } from '../auth/AuthContext';
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
import { ProviderModelsFetchError, ProviderModelsResponseError, type ProviderCustomModelsService, type ProviderModelsService } from '../ai-gateway/models';
import { createAiConnectionsServiceAccess } from '../ai-gateway/service-access/AiConnectionsServiceAccess';
import type { AiConnectionsInvocationKeyIssuer } from '../ai-gateway/auth/AiConnectionsInvocationKeyIssuer';
import {
  type AiClientConfigurationCapabilityDescriptor,
  unavailableAiClientConfigurationCapability,
} from '../service/AiClientConfigurationService';
import { GatewayProtocolError, normalizeGatewayError } from '../ai-gateway/errors';
import { normalizeProviderProxyUrl, redactProviderProxyUrl } from '../service/provider-http-transport';

const logger = getLoggerFor('AiGatewayManagementHandler');

export interface AiGatewayManagementHandlerOptions {
  /** Legacy persistent Gateway key storage. AI Connection routes do not need it. */
  repository?: GatewayAccessKeyRepository;
  deployment: GatewayDeployment;
  connectService?: ProviderConnectService;
  quotaService?: ProviderQuotaService;
  modelsService?: ProviderModelsService;
  customModelsService?: ProviderCustomModelsService;
  servicePrincipal?: {
    getServicePrincipal(): Promise<{ webId: string }>;
  };
  aiClientConfiguration?: AiClientConfigurationCapabilityDescriptor;
  aiConnectionInvocationKeyIssuer?: Pick<AiConnectionsInvocationKeyIssuer, 'issue'>;
  now?: () => Date;
  keyId?: (owner: string) => string;
  jsonBodyLimitBytes?: number;
}

export function registerAiGatewayManagementRoutes(
  server: ApiServer,
  options: AiGatewayManagementHandlerOptions,
): void {
  const now = options.now ?? (() => new Date());
  const jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? 64 * 1024;

  server.get('/api/applets/service-access/ai-connections', async (request, response) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    // Interactive applet operations run as the current Solid user. A separate
    // service principal is only needed by background/runtime Pod access.
    const service = options.servicePrincipal
      ? await options.servicePrincipal.getServicePrincipal()
      : { webId: request.auth.webId };
    const descriptor = createAiConnectionsServiceAccess({
      ownerWebId: request.auth.webId,
      serviceWebId: service.webId,
    });
    const invocation = options.aiConnectionInvocationKeyIssuer
      ? await options.aiConnectionInvocationKeyIssuer.issue({ auth: request.auth })
      : undefined;
    logger.debug(`Issuing AI Connection service access for ${request.auth.webId}; invocation=${Boolean(invocation)}`);
    sendJson(response, 200, {
      ...descriptor,
      aiClientConfiguration: options.aiClientConfiguration ?? unavailableAiClientConfigurationCapability(),
      ...(invocation ? { invocation } : {}),
    });
  });

  const repository = options.repository;
  if (repository) {
    const createKeyId = options.keyId ?? ((owner: string) => (
      repository.createKeyId?.(owner, options.deployment) ?? createGatewayKeyId()
    ));

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
    const record = await repository.create({
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
    const records = await repository.listByOwner(owner, { auth: request.auth });
    sendJson(response, 200, {
      data: records.map(publicRecord),
    });
    });

    server.delete('/api/ai/gateway/keys/:keyId', async (request, response, params) => {
      if (!authorizeGatewayKeyManagement(request, response)) {
        return;
      }

      const keyId = decodeURIComponent(params.keyId);
      const existing = await repository.findById(keyId);
      if (!existing) {
        sendJson(response, 404, { error: 'Gateway key not found' });
        return;
      }
      const owner = ownerForList(request);
      if (!owner || existing.owner !== owner) {
        sendJson(response, 403, { error: 'Cannot revoke a gateway key owned by another WebID' });
        return;
      }
      const revoked = await repository.revoke(keyId, now(), { auth: request.auth });
      sendJson(response, 200, {
        record: revoked ? publicRecord(revoked) : undefined,
      });
    });
  }

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

  server.get('/api/ai/providers', async (request, response) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const poolService = requireCredentialPoolManagementService(options, response);
    if (!poolService) {
      return;
    }
    try {
      const pools = await poolService.listProviderCredentialPools({
        webId: request.auth.webId,
        deployment: options.deployment,
        auth: request.auth,
      });
      sendJson(response, 200, {
        data: pools.map(publicProviderPool),
      });
    } catch (error) {
      sendCredentialPoolError(response, error);
    }
  });

  server.post('/api/ai/providers/:provider/credentials/api-key', async (request, response, params) => {
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
    const priority = normalizeOptionalNumber(body.priority);
    if (body.priority !== undefined && priority === undefined) {
      sendJson(response, 400, { error: 'priority must be a finite number' });
      return;
    }
    const poolService = requireCredentialPoolManagementService(options, response);
    if (!poolService) {
      return;
    }
    try {
      const credential = await poolService.createApiKeyCredential({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        offeringId: normalizeOptionalString(body.offeringId),
        apiKey,
        label: normalizeOptionalString(body.label),
        baseUrl: normalizeOptionalString(body.baseUrl),
        proxyUrl: normalizeOptionalString(body.proxyUrl),
        priority,
        auth: request.auth,
      });
      sendJson(response, 201, {
        credential: publicCredentialPoolCredential(credential),
      });
    } catch (error) {
      sendCredentialPoolError(response, error);
    }
  });

  server.post('/api/ai/providers/:provider/credentials/local', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) return;
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) return;
    const priority = normalizeOptionalNumber(body.priority);
    if (body.priority !== undefined && priority === undefined) {
      sendJson(response, 400, { error: 'priority must be a finite number' });
      return;
    }
    const poolService = requireCredentialPoolManagementService(options, response);
    if (!poolService) return;
    try {
      const credential = await poolService.createLocalCredential({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        offeringId: normalizeOptionalString(body.offeringId),
        label: normalizeOptionalString(body.label),
        baseUrl: normalizeOptionalString(body.baseUrl),
        priority,
        auth: request.auth,
      });
      sendJson(response, 201, { credential: publicCredentialPoolCredential(credential) });
    } catch (error) {
      sendCredentialPoolError(response, error);
    }
  });

  server.patch('/api/ai/providers/:provider/credentials/:credentialId', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    if (typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion)) {
      sendJson(response, 400, { error: 'expectedVersion is required' });
      return;
    }
    const patch = normalizeCredentialPatch(body);
    if (!patch) {
      sendJson(response, 400, { error: 'Credential patch contains invalid field values' });
      return;
    }
    const poolService = requireCredentialPoolManagementService(options, response);
    if (!poolService) {
      return;
    }
    try {
      const credential = await poolService.updateCredential({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialId: decodeURIComponent(params.credentialId),
        expectedVersion: body.expectedVersion,
        patch,
        auth: request.auth,
      });
      if (!credential) {
        sendJson(response, 404, { error: 'Provider credential not found for current identity' });
        return;
      }
      sendJson(response, 200, {
        credential: publicCredentialPoolCredential(credential),
      });
    } catch (error) {
      sendCredentialPoolError(response, error);
    }
  });

  server.delete('/api/ai/providers/:provider/credentials/:credentialId', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const poolService = requireCredentialPoolManagementService(options, response);
    if (!poolService) {
      return;
    }
    try {
      const credential = await poolService.revokeCredential({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialId: decodeURIComponent(params.credentialId),
        auth: request.auth,
      });
      if (!credential) {
        sendJson(response, 404, { error: 'Provider credential not found for current identity' });
        return;
      }
      sendJson(response, 200, {
        credential: publicCredentialPoolCredential(credential),
      });
    } catch (error) {
      sendCredentialPoolError(response, error);
    }
  });

  server.post('/api/ai/providers/:provider/credentials/test', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const credentialId = normalizeOptionalString(body.credentialId);
    if (!credentialId) {
      sendJson(response, 400, { error: 'credentialId is required' });
      return;
    }
    if (body.apiKey !== undefined) {
      sendJson(response, 400, { error: 'credentialId is required' });
      return;
    }
    const poolService = requireCredentialPoolManagementService(options, response);
    if (!poolService) {
      return;
    }
    try {
      const result = await poolService.testCredential({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialId,
        modelsService: options.modelsService,
        auth: request.auth,
      });
      sendJson(response, 200, {
        result: publicCredentialTestResult(result),
      });
    } catch (error) {
      sendCredentialPoolError(response, error);
    }
  });

  server.post('/api/ai/gateway/providers/:provider/connect/begin', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    markLegacyProviderConnectRoute(response);
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    if (body.clientId !== undefined) {
      sendJson(response, 400, { error: 'clientId is not accepted' });
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
    markLegacyProviderConnectRoute(response);
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
    markLegacyProviderConnectRoute(response);
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
        baseUrl: normalizeOptionalString(body.baseUrl),
        auth: request.auth,
      } satisfies CompleteApiKeyInput);
      sendJson(response, 200, publicConnectResult(result));
    } catch (error) {
      sendLegacyProviderConnectError(response, error);
    }
  });

  server.post('/api/ai/gateway/providers/:provider/connect/poll', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    markLegacyProviderConnectRoute(response);
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
    markLegacyProviderConnectRoute(response);
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    try {
      const credentialId = normalizeOptionalString(body.credentialId);
      const refreshToken = normalizeOptionalString(body.refreshToken);
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      if (!credentialId || !refreshToken || expectedVersion === undefined) {
        sendJson(response, 400, { error: 'credentialId, refreshToken and expectedVersion are required' });
        return;
      }
      const result = await connectService.refreshCallerOwned({
        webId: request.auth!.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialId,
        refreshToken,
        expectedVersion,
        auth: request.auth,
      });
      sendJson(response, 200, publicConnectResult(result));
    } catch (error) {
      sendLegacyProviderConnectError(response, error);
    }
  });

  server.delete('/api/ai/gateway/providers/:provider/connect', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    markLegacyProviderConnectRoute(response);
    const connectService = requireConnectService(options, response);
    if (!connectService) {
      return;
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      const record = await connectService.disconnect({
        webId: request.auth!.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialId: normalizeOptionalString(url.searchParams.get('credentialId')),
        auth: request.auth,
      });
      sendJson(response, 200, { record: record ? publicCredentialRecord(record) : undefined });
    } catch (error) {
      sendLegacyProviderConnectError(response, error);
    }
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
        offeringId: normalizeOptionalString(url.searchParams.get('offeringId')),
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
      const credentialId = normalizeOptionalString(body.credentialId);
      const credentialIri = normalizeOptionalString(body.credentialIri);
      const authMode = body.authMode === 'apiKey' || body.authMode === 'deviceCodeOAuth'
        ? body.authMode
        : undefined;
      const secret = body.secret && typeof body.secret === 'object' && !Array.isArray(body.secret)
        ? body.secret as Record<string, unknown>
        : undefined;
      if (!credentialId || !credentialIri || !authMode || !secret) {
        sendJson(response, 400, { error: 'credentialId, credentialIri, authMode and secret are required' });
        return;
      }
      const result = await quotaService.statusCallerOwned({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        credentialId,
        credentialIri,
        offeringId: normalizeOptionalString(body.offeringId),
        authMode,
        baseUrl: normalizeOptionalString(body.baseUrl),
        proxyUrl: normalizeOptionalString(body.proxyUrl),
        secret,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendQuotaError(response, error);
    }
  });

  server.post('/api/ai/gateway/providers/:provider/models/refresh', async (request, response, params) => {
    const requester = request.auth?.type === 'solid' ? request.auth.webId : 'anonymous';
    logger.debug(`Refreshing ${params.provider} models for ${requester}`);
    if (!authorizeProviderQuota(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const modelsService = requireModelsService(options, response);
    if (!modelsService) {
      return;
    }
    try {
      const apiKey = normalizeOptionalString(body.apiKey);
      const credentialId = normalizeOptionalString(body.credentialId);
      const authMode = body.authMode === 'apiKey' || body.authMode === 'deviceCodeOAuth' || body.authMode === 'local'
        ? body.authMode
        : undefined;
      const secret = body.secret && typeof body.secret === 'object' && !Array.isArray(body.secret)
        ? body.secret as Record<string, unknown>
        : undefined;
      logger.debug(`Model refresh credential input: apiKey=${Boolean(apiKey)} authMode=${authMode ?? 'none'} secret=${Boolean(secret)} credentialId=${Boolean(credentialId)} baseUrl=${Boolean(normalizeOptionalString(body.baseUrl))}`);
      const result = credentialId && ((authMode && secret) || apiKey)
        ? await modelsService.listFromSecret({
          webId: request.auth.webId,
          provider: params.provider,
          offeringId: normalizeOptionalString(body.offeringId),
          credentialId,
          ...(authMode ? { authMode } : {}),
          ...(secret ? { secret } : {}),
          ...(apiKey ? { apiKey } : {}),
          baseUrl: normalizeOptionalString(body.baseUrl),
          proxyUrl: normalizeOptionalString(body.proxyUrl),
          compatibility: normalizeCustomCompatibility(body.compatibility),
        })
        : await modelsService.list({
          webId: request.auth.webId,
          deployment: options.deployment,
          provider: params.provider,
          credentialIri: normalizeOptionalString(body.credentialIri),
          auth: request.auth,
        });
      sendJson(response, 200, result);
    } catch (error) {
      sendModelsError(response, error);
    }
  });

  server.post('/api/ai/gateway/providers/:provider/models', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    const customModelsService = requireCustomModelsService(options, response);
    if (!customModelsService) {
      return;
    }
    const model = normalizeCustomModelInput(body);
    if (!model) {
      sendJson(response, 400, { error: 'Model id must be a non-empty string; capabilities must be a string array' });
      return;
    }
    try {
      const data = await customModelsService.upsert({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        model,
        auth: request.auth,
      });
      sendJson(response, 200, { data });
    } catch (error) {
      sendCustomModelsError(response, error);
    }
  });

  server.delete('/api/ai/gateway/providers/:provider/models/:modelId', async (request, response, params) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    const customModelsService = requireCustomModelsService(options, response);
    if (!customModelsService) {
      return;
    }
    const modelId = normalizeOptionalString(params.modelId);
    if (!modelId) {
      sendJson(response, 400, { error: 'Model id is required' });
      return;
    }
    try {
      const data = await customModelsService.remove({
        webId: request.auth.webId,
        deployment: options.deployment,
        provider: params.provider,
        modelId,
        auth: request.auth,
      });
      sendJson(response, 200, { data });
    } catch (error) {
      sendCustomModelsError(response, error);
    }
  });
}

function normalizeCustomCompatibility(value: unknown): 'auto' | 'openai' | 'anthropic' | undefined {
  return value === 'auto' || value === 'openai' || value === 'anthropic' ? value : undefined;
}

function authorizeGatewayKeyManagement(
  request: AuthenticatedRequest,
  response: ServerResponse,
): boolean {
  return authorizeManagementCaller(request, response, {
    gatewayKeyPrincipalError: 'Gateway API keys cannot manage gateway keys',
    nonSolidPrincipalError: 'Insufficient permissions',
    allowServiceGatewayKeyManagement: true,
  });
}

function authorizeManagementCaller(
  request: AuthenticatedRequest,
  response: ServerResponse,
  options: {
    gatewayKeyPrincipalError: string;
    nonSolidPrincipalError: string;
    allowServiceGatewayKeyManagement?: boolean;
  },
): boolean {
  const auth = request.auth;
  if (!auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (auth.type === 'solid' && auth.webId) {
    if (isGatewayApiKeyPrincipal(auth) && !isInternalGatewayInvocationPrincipal(auth)) {
      sendJson(response, 403, { error: options.gatewayKeyPrincipalError });
      return false;
    }
    return true;
  }
  if (options.allowServiceGatewayKeyManagement && canManageGatewayKeys(auth)) {
    return true;
  }
  sendJson(response, 403, { error: options.nonSolidPrincipalError });
  return false;
}

function authorizeCurrentSolidManagement(
  request: AuthenticatedRequest,
  response: ServerResponse,
  options: {
    gatewayKeyPrincipalError: string;
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
    gatewayKeyPrincipalError: 'Gateway API keys cannot manage provider Connect state',
    nonSolidPrincipalError: 'Provider Connect requires the current Solid identity',
  });
}

function authorizeProviderQuota(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  return authorizeCurrentSolidManagement(request, response, {
    gatewayKeyPrincipalError: 'Gateway API keys cannot manage provider quota state',
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

function requireCredentialPoolManagementService(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): ProviderConnectService | undefined {
  return requireConnectService(options, response);
}

function markLegacyProviderConnectRoute(response: ServerResponse): void {
  response.setHeader('Deprecation', 'true');
  response.setHeader('Link', '</api/ai/providers>; rel="successor-version"');
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

function requireModelsService(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): ProviderModelsService | undefined {
  if (!options.modelsService) {
    sendJson(response, 503, { error: 'AI provider models service is not configured' });
    return undefined;
  }
  return options.modelsService;
}

function requireCustomModelsService(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): ProviderCustomModelsService | undefined {
  if (!options.customModelsService) {
    sendJson(response, 503, { error: 'AI provider custom models service is not configured' });
    return undefined;
  }
  return options.customModelsService;
}

function normalizeCustomModelInput(body: Record<string, unknown>): {
  id: string;
  displayName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  capabilities?: string[];
} | undefined {
  const id = normalizeOptionalString(body.id);
  if (!id || id.length > 256 || /\s/.test(id)) {
    return undefined;
  }
  const displayName = normalizeOptionalString(body.displayName);
  if (body.displayName !== undefined && body.displayName !== null && !displayName) {
    return undefined;
  }
  const inputModalities = normalizeStringList(body.inputModalities);
  const outputModalities = normalizeStringList(body.outputModalities);
  const capabilities = normalizeStringList(body.capabilities);
  if (inputModalities === null || outputModalities === null || capabilities === null) {
    return undefined;
  }
  return {
    id,
    ...(displayName ? { displayName } : {}),
    ...(inputModalities.length > 0 ? { inputModalities } : {}),
    ...(outputModalities.length > 0 ? { outputModalities } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };
}

function normalizeCredentialPatch(body: Record<string, unknown>): {
  label?: string;
  enabled?: boolean;
  priority?: number;
  baseUrl?: string;
  proxyUrl?: string;
} | undefined {
  const patch: {
    label?: string;
    enabled?: boolean;
    priority?: number;
    baseUrl?: string;
    proxyUrl?: string;
  } = {};
  if (body.label !== undefined) {
    const label = normalizeOptionalString(body.label);
    if (!label) {
      return undefined;
    }
    patch.label = label;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return undefined;
    }
    patch.enabled = body.enabled;
  }
  if (body.priority !== undefined) {
    const priority = normalizeOptionalNumber(body.priority);
    if (priority === undefined) {
      return undefined;
    }
    patch.priority = priority;
  }
  if (body.baseUrl !== undefined) {
    const baseUrl = normalizeOptionalString(body.baseUrl);
    if (!baseUrl) {
      return undefined;
    }
    patch.baseUrl = baseUrl;
  }
  if (body.proxyUrl !== undefined) {
    try {
      patch.proxyUrl = normalizeProviderProxyUrl(normalizeOptionalString(body.proxyUrl));
    } catch {
      return undefined;
    }
  }
  return patch;
}

function normalizeStringList(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)
    || value.length > 16
    || !value.every((item) => typeof item === 'string' && item.trim())) {
    return null;
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function sendCustomModelsError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'models_credential_not_found') {
    sendJson(response, 404, { error: 'Provider credential not found for current identity' });
    return;
  }
  if (message === 'credential_version_conflict') {
    sendJson(response, 409, { error: 'credential_version_conflict' });
    return;
  }
  if (message === 'service_access_missing') {
    sendJson(response, 403, { error: 'service_access_missing' });
    return;
  }
  if (message === 'credential_collection_query_unsupported') {
    sendJson(response, 501, {
      error: 'credential_collection_query_unsupported',
      message: 'This Pod does not expose the collection query capability required by AI Connections.',
    });
    return;
  }
  if (message === 'credential_collection_query_unsupported') {
    sendJson(response, 501, {
      error: 'credential_collection_query_unsupported',
      message: 'This Pod does not expose the collection query capability required by AI Connections.',
    });
    return;
  }
  sendJson(response, 500, { error: 'Provider custom models update failed' });
}

function sendCredentialPoolError(response: ServerResponse, error: unknown): void {
  if (error instanceof GatewayProtocolError) {
    const normalized = normalizeGatewayError(error);
    sendJson(response, normalized.error.status, normalized);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'credential_version_conflict') {
    sendJson(response, 409, { error: 'credential_version_conflict' });
    return;
  }
  if (message === 'credential_collection_query_unsupported') {
    sendJson(response, 501, {
      error: 'credential_collection_query_unsupported',
      message: 'This Pod does not expose the collection query capability required by AI Connections.',
    });
    return;
  }
  if (message === 'credential_not_found' || message === 'provider_credential_not_found') {
    sendJson(response, 404, { error: 'Provider credential not found for current identity' });
    return;
  }
  logger.error(`Provider credential pool operation failed: ${message}`);
  sendJson(response, 500, { error: 'Provider credential pool operation failed' });
}

function sendLegacyProviderConnectError(response: ServerResponse, error: unknown): void {
  if (error instanceof GatewayProtocolError) {
    const normalized = normalizeGatewayError(error);
    sendJson(response, normalized.error.status, normalized);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'credential_version_conflict') {
    sendJson(response, 409, { error: 'credential_version_conflict' });
    return;
  }
  if (message === 'service_access_missing') {
    sendJson(response, 403, { error: 'service_access_missing' });
    return;
  }
  if (message === 'credential_collection_query_unsupported') {
    sendJson(response, 501, {
      error: 'credential_collection_query_unsupported',
      message: 'This Pod does not expose the collection query capability required by AI Connections.',
    });
    return;
  }
  if (message === 'credential_not_found'
    || message === 'provider_credential_not_found'
    || message === 'oauth_credential_not_found') {
    sendJson(response, 404, { error: 'Provider credential not found for current identity' });
    return;
  }
  if (/connect attempt not found/iu.test(message)) {
    sendJson(response, 404, { error: 'Provider Connect attempt not found' });
    return;
  }
  if (/provider does not support (?:refresh|disconnect)/iu.test(message)) {
    sendJson(response, 400, { error: message });
    return;
  }
  sendJson(response, 500, { error: 'Provider Connect operation failed' });
}

function sendModelsError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProviderModelsResponseError) {
    sendJson(response, 502, {
      error: 'provider_models_response_error',
      message: error.safeMessage,
    });
    return;
  }
  if (error instanceof ProviderModelsFetchError) {
    logger.warn(`Provider models request returned ${error.providerStatus}`);
    sendJson(response, 502, {
      error: 'provider_models_fetch_failed',
      providerStatus: error.providerStatus,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'models_credential_not_found') {
    sendJson(response, 404, { error: 'Provider credential not found for current identity' });
    return;
  }
  if (message.startsWith('models_adapter_not_found:')) {
    sendJson(response, 404, { error: 'Provider models adapter not found' });
    return;
  }
  if (message === 'models_secret_missing') {
    sendJson(response, 500, { error: 'Provider credential secret is unavailable' });
    return;
  }
  if (message === 'unsafe_provider_base_url'
    || message === 'unsafe_provider_target'
    || message === 'invalid_provider_url') {
    sendJson(response, 400, { error: 'unsafe_provider_base_url' });
    return;
  }
  if (message === 'invalid_proxy_url') {
    sendJson(response, 400, { error: 'invalid_proxy_url' });
    return;
  }
  logger.error(`Provider models lookup failed: ${message}`);
  sendJson(response, 500, { error: 'Provider models lookup failed' });
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

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
    provider: record.provider,
    authMode: record.authMode,
    status: record.status,
    accountLabel: record.accountLabel,
    expiresAt: record.expiresAt?.toISOString(),
    version: record.version,
    reauthRequired: record.reauthRequired,
  };
}

function publicProviderPool(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown>;
  return stripUndefined({
    id: record.id,
    name: record.name,
    status: record.status,
    offerings: publicSafeArray(record.offerings),
    credentials: Array.isArray(record.credentials)
      ? record.credentials.map(publicCredentialPoolCredential)
      : [],
    selectedModels: publicSafeArray(record.selectedModels),
  });
}

function publicCredentialPoolCredential(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const record = value as Record<string, unknown> & {
    label?: string;
    accountLabel?: string;
    status?: string;
    expiresAt?: Date | string;
    baseUrl?: string;
    proxyUrl?: string;
    maskedHint?: string;
    quota?: unknown;
    metadata?: Record<string, unknown>;
  };
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? record.metadata as Record<string, unknown>
    : {};
  return stripUndefined({
    id: record.id,
    provider: record.provider,
    offeringId: record.offeringId ?? stringMetadata(metadata, 'offeringId'),
    authMode: record.authMode,
    label: record.label ?? record.accountLabel,
    enabled: record.enabled ?? (record.status ? record.status === 'active' : undefined),
    priority: record.priority ?? numberMetadata(metadata, 'priority'),
    health: record.health ?? stringMetadata(metadata, 'health'),
    maskedHint: record.maskedHint ?? stringMetadata(metadata, 'maskedHint'),
    expiresAt: record.expiresAt instanceof Date ? record.expiresAt.toISOString() : record.expiresAt,
    baseUrl: record.baseUrl ?? stringMetadata(metadata, 'baseUrl'),
    proxyUrl: redactProviderProxyUrl(record.proxyUrl ?? stringMetadata(metadata, 'proxyUrl')),
    version: record.version,
    quota: record.quota ?? metadata.quota ?? metadata.quotaStatus,
  });
}

function publicCredentialTestResult(value: unknown): unknown {
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(publicCredentialTestResult);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !secretFieldNames.has(key))
      .map(([key, item]) => [key, publicCredentialTestResult(item)]),
  );
}

function publicSafeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(publicSafeObject) : [];
}

function publicSafeObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(publicSafeObject);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !secretFieldNames.has(key))
      .map(([key, item]) => [key, publicSafeObject(item)]),
  );
}

const secretFieldNames = new Set([
  'apiKey',
  'encryptedSecret',
  'refreshToken',
  'accessToken',
  'token',
  'secret',
  'secretHash',
  'ciphertext',
  'wrappedDek',
  'wrappedDataKey',
]);

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
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
