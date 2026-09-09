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
import type { GatewayDeployment } from '../ai-gateway/auth/GatewayApiKey';
import {
  createGatewayApiKey,
} from '../ai-gateway/auth/GatewayApiKey';
import {
  DEFAULT_GATEWAY_API_KEY_SCOPES,
  type GatewayAccessKeyRecord,
  type GatewayAccessKeyRepository,
} from '../ai-gateway/auth/GatewayApiKeyAuthenticator';
import type {
  CompleteApiKeyInput,
  ConnectBeginInput,
  ProviderConnectService,
} from '../ai-gateway/connect';
import type { ProviderModelSelectionService } from '../ai-gateway/models/ProviderModelSelectionService';
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
  deployment: GatewayDeployment;
  connectService?: ProviderConnectService;
  quotaService?: ProviderQuotaService;
  modelsService?: ProviderModelsService;
  providerModelSelectionService?: ProviderModelSelectionServicePort;
  modelSelectionService?: ProviderModelSelectionServicePort;
  selectionService?: ProviderModelSelectionServicePort;
  customModelsService?: ProviderCustomModelsService;
  servicePrincipal?: {
    getServicePrincipal(): Promise<{ webId: string }>;
  };
  gatewayAccessKeyRepository?: GatewayAccessKeyRepository;
  aiClientConfiguration?: AiClientConfigurationCapabilityDescriptor;
  aiConnectionInvocationKeyIssuer?: Pick<AiConnectionsInvocationKeyIssuer, 'issue' | 'issueClientConfiguration'>;
  jsonBodyLimitBytes?: number;
}

export function registerAiGatewayManagementRoutes(
  server: ApiServer,
  options: AiGatewayManagementHandlerOptions,
): void {
  const jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? 64 * 1024;

  server.get('/api/applets/service-access/ai-connections', async (request, response) => {
    if (!authorizeProviderConnect(request, response)) {
      return;
    }
    try {
      // Interactive applet operations still describe the configured Xpod
      // service identity. A separate service principal is only needed by
      // background/runtime Pod access, so an omitted one remains supported.
      let service = { webId: request.auth.webId };
      if (options.servicePrincipal) {
        try {
          service = await options.servicePrincipal.getServicePrincipal();
        } catch (error) {
          if (options.deployment !== 'local') throw error;
          logger.warn('Local AI Connection service identity is unavailable; using the authenticated WebID for this interactive request');
        }
      }
      const descriptor = createAiConnectionsServiceAccess({
        ownerWebId: request.auth.webId,
        serviceWebId: service.webId,
      });
      const invocation = options.aiConnectionInvocationKeyIssuer
        ? await options.aiConnectionInvocationKeyIssuer.issue({ auth: request.auth })
        : undefined;
      const aiClientConfiguration = await withAiClientConfigurationInvocation(
        options.aiClientConfiguration ?? unavailableAiClientConfigurationCapability(),
        options.aiConnectionInvocationKeyIssuer,
        request.auth,
      );
      logger.debug(`Issuing AI Connection service access for ${request.auth.webId}; invocation=${Boolean(invocation)}`);
      sendJson(response, 200, {
        ...descriptor,
        aiClientConfiguration,
        ...(invocation ? { invocation } : {}),
      });
    } catch (error) {
      sendAiConnectionsServiceAccessError(response, error);
    }
  });

  server.get('/api/ai/gateway/keys', async (request, response) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }
    const repository = requireGatewayAccessKeyRepository(options, response);
    if (!repository) {
      return;
    }
    try {
      const auth = request.auth!;
      const owner = ownerWebIdForGatewayKeyManagement(auth, undefined);
      if (!owner) {
        sendJson(response, 403, { error: 'Gateway API key management requires an owner WebID' });
        return;
      }
      const records = await repository.listByOwner(owner, { auth });
      const plaintextById = await revealAvailablePlaintexts(repository, records, auth);
      sendJson(response, 200, {
        data: records.map((record) =>
          publicGatewayAccessKeyRecord(record, plaintextById.has(record.id), plaintextById.get(record.id))),
      });
    } catch (error) {
      sendGatewayAccessKeyError(response, error);
    }
  });

  server.post('/api/ai/gateway/keys', async (request, response) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }
    const repository = requireGatewayAccessKeyRepository(options, response);
    if (!repository) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    try {
      const auth = request.auth!;
      const owner = ownerWebIdForGatewayKeyManagement(auth, normalizeOptionalString(body.owner));
      if (!owner) {
        sendJson(response, 403, { error: 'Gateway API key management requires an owner WebID' });
        return;
      }
      const name = normalizeOptionalString(body.name) ?? `Xpod API Key ${new Date().toLocaleString('sv-SE')}`;
      const keyId = repository.createKeyId?.(owner, options.deployment);
      const issued = await createGatewayApiKey({
        deployment: options.deployment,
        ...(keyId ? { keyId } : {}),
      });
      const createdAt = new Date();
      const record = await repository.create({
        id: issued.record.id,
        owner,
        secretHash: issued.record.secretHash,
        deployment: issued.record.deployment,
        scopes: normalizeGatewayScopes(body.scopes),
        createdAt,
        name,
        plaintext: issued.plaintext,
      }, { auth });
      sendJson(response, 201, {
        key: issued.plaintext,
        record: publicGatewayAccessKeyRecord(record, true),
      });
    } catch (error) {
      sendGatewayAccessKeyError(response, error);
    }
  });

  server.post('/api/ai/gateway/keys/:keyId/reveal', async (request, response, params) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }
    const repository = requireGatewayAccessKeyRepository(options, response);
    if (!repository) {
      return;
    }
    try {
      const record = await ownedGatewayAccessKey(repository, params.keyId, request.auth!);
      if (!record) {
        sendJson(response, 404, { error: 'Gateway API Key not found' });
        return;
      }
      const key = await repository.revealPlaintext(record.id, { auth: request.auth });
      if (!key) {
        sendJson(response, 409, { error: 'Gateway API Key plaintext is not available' });
        return;
      }
      sendJson(response, 200, { key });
    } catch (error) {
      sendGatewayAccessKeyError(response, error);
    }
  });

  server.patch('/api/ai/gateway/keys/:keyId', async (request, response, params) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }
    const repository = requireGatewayAccessKeyRepository(options, response);
    if (!repository) {
      return;
    }
    const body = await readJsonObject(request, response, jsonBodyLimitBytes);
    if (!body) {
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      sendJson(response, 400, { error: 'enabled must be a boolean' });
      return;
    }
    try {
      const record = await ownedGatewayAccessKey(repository, params.keyId, request.auth!);
      if (!record) {
        sendJson(response, 404, { error: 'Gateway API Key not found' });
        return;
      }
      const updated = await repository.setEnabled(record.id, body.enabled, new Date(), { auth: request.auth });
      if (!updated) {
        sendJson(response, 404, { error: 'Gateway API Key not found' });
        return;
      }
      const plaintext = await repository.revealPlaintext(updated.id, { auth: request.auth });
      sendJson(response, 200, {
        record: publicGatewayAccessKeyRecord(updated, Boolean(plaintext)),
      });
    } catch (error) {
      sendGatewayAccessKeyError(response, error);
    }
  });

  server.delete('/api/ai/gateway/keys/:keyId', async (request, response, params) => {
    if (!authorizeGatewayKeyManagement(request, response)) {
      return;
    }
    const repository = requireGatewayAccessKeyRepository(options, response);
    if (!repository) {
      return;
    }
    try {
      const record = await ownedGatewayAccessKey(repository, params.keyId, request.auth!);
      if (!record) {
        sendJson(response, 404, { error: 'Gateway API Key not found' });
        return;
      }
      await repository.delete(record.id, { auth: request.auth });
      sendJson(response, 200, {
        deleted: true,
        record: publicGatewayAccessKeyRecord(record, false),
      });
    } catch (error) {
      sendGatewayAccessKeyError(response, error);
    }
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

  server.post('/api/ai/gateway/providers/:provider/models/discover', async (request, response, params) => {
    if (!authorizeProviderModels(request, response)) {
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

  server.put('/api/ai/gateway/providers/:provider/models/selection', async (request, response, params) => {
    if (!authorizeProviderModels(request, response)) {
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

async function withAiClientConfigurationInvocation(
  capability: AiClientConfigurationCapabilityDescriptor,
  issuer: Pick<AiConnectionsInvocationKeyIssuer, 'issueClientConfiguration'> | undefined,
  auth: SolidAuthContext,
): Promise<AiClientConfigurationCapabilityDescriptor & { invocation?: unknown }> {
  if (!issuer || capability.available !== true) {
    return capability;
  }
  try {
    return {
      ...capability,
      invocation: await issuer.issueClientConfiguration({ auth }),
    };
  } catch (error) {
    logger.warn(`AI client configuration invocation is unavailable: ${(error as Error).message}`);
    return capability;
  }
}

function normalizeCustomCompatibility(value: unknown): 'auto' | 'openai' | 'anthropic' | undefined {
  return value === 'auto' || value === 'openai' || value === 'anthropic' ? value : undefined;
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

function authorizeProviderModels(
  request: AuthenticatedRequest,
  response: ServerResponse,
): request is AuthenticatedRequest & { auth: Extract<NonNullable<AuthenticatedRequest['auth']>, { type: 'solid' }> } {
  return authorizeCurrentSolidManagement(request, response, {
    gatewayKeyPrincipalError: 'Gateway API keys cannot manage provider model selections',
    nonSolidPrincipalError: 'Provider model management requires the current Solid identity',
  });
}

function authorizeGatewayKeyManagement(
  request: AuthenticatedRequest,
  response: ServerResponse,
): boolean {
  return authorizeManagementCaller(request, response, {
    gatewayKeyPrincipalError: 'Gateway API keys cannot manage Gateway API keys',
    nonSolidPrincipalError: 'Gateway API key management requires the current Solid identity',
    allowServiceGatewayKeyManagement: true,
  });
}

function requireGatewayAccessKeyRepository(
  options: AiGatewayManagementHandlerOptions,
  response: ServerResponse,
): GatewayAccessKeyRepository | undefined {
  if (!options.gatewayAccessKeyRepository) {
    sendJson(response, 503, { error: 'Gateway API Key repository is not configured' });
    return undefined;
  }
  return options.gatewayAccessKeyRepository;
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

const MAX_SELECTED_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 256;

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

  const defaultModel = normalizeOptionalString(body.defaultModel);
  if (body.defaultModel !== undefined) {
    if (!defaultModel || defaultModel.length > MAX_MODEL_ID_LENGTH) {
      sendJson(response, 400, { error: `defaultModel must be a 1-${MAX_MODEL_ID_LENGTH} character string` });
      return undefined;
    }
    if (!modelIds.some((modelId) => canonicalModelId(modelId) === canonicalModelId(defaultModel))) {
      sendJson(response, 400, { error: 'defaultModel must be included in modelIds' });
      return undefined;
    }
  }

  const expectedVersion = normalizeOptionalString(body.expectedVersion);
  if (!expectedVersion) {
    sendJson(response, 400, { error: 'expectedVersion is required' });
    return undefined;
  }

  return { modelIds, ...(defaultModel ? { defaultModel } : {}), expectedVersion };
}

function canonicalModelId(modelId: string): string {
  const fragmentIndex = modelId.lastIndexOf('#');
  return fragmentIndex >= 0 ? modelId.slice(fragmentIndex + 1).toLowerCase() : modelId.toLowerCase();
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

function normalizeGatewayScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_GATEWAY_API_KEY_SCOPES];
  }
  const scopes = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return scopes.length ? [...new Set(scopes)] : [...DEFAULT_GATEWAY_API_KEY_SCOPES];
}

async function ownedGatewayAccessKey(
  repository: GatewayAccessKeyRepository,
  keyId: string | undefined,
  auth: NonNullable<AuthenticatedRequest['auth']>,
): Promise<GatewayAccessKeyRecord | undefined> {
  if (!keyId) {
    return undefined;
  }
  const record = await repository.findById(keyId, { auth });
  if (!record) {
    return undefined;
  }
  const owner = ownerWebIdForGatewayKeyManagement(auth, record.owner);
  return owner && owner === record.owner ? record : undefined;
}

async function revealAvailablePlaintexts(
  repository: GatewayAccessKeyRepository,
  records: GatewayAccessKeyRecord[],
  auth: NonNullable<AuthenticatedRequest['auth']>,
): Promise<Map<string, string>> {
  const available = new Map<string, string>();
  await Promise.all(records.map(async (record) => {
    try {
      const plaintext = await repository.revealPlaintext(record.id, { auth });
      if (plaintext) {
        available.set(record.id, plaintext);
      }
    } catch {
      // Availability is advisory for list rendering; reveal endpoint reports hard failures.
    }
  }));
  return available;
}

function publicGatewayAccessKeyRecord(
  record: GatewayAccessKeyRecord,
  plaintextAvailable: boolean,
  plaintext?: string,
): Record<string, unknown> {
  const suffix = plaintext?.slice(-8) ?? record.plaintext?.slice(-8) ?? record.id.slice(-8);
  const enabled = !record.disabledAt && !record.revokedAt;
  return {
    id: record.id,
    owner: record.owner,
    deployment: record.deployment,
    scopes: record.scopes,
    createdAt: record.createdAt.toISOString(),
    ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt.toISOString() } : {}),
    ...(record.disabledAt ? { disabledAt: record.disabledAt.toISOString() } : {}),
    ...(record.revokedAt ? { revokedAt: record.revokedAt.toISOString() } : {}),
    ...(record.name ? { name: record.name } : {}),
    enabled,
    plaintextAvailable,
    suffix,
    maskedHint: `••••••••${suffix}`,
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

function sendGatewayAccessKeyError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'service_access_missing') {
    sendJson(response, 403, { error: 'service_access_missing' });
    return;
  }
  if (message === 'caller_owner_mismatch') {
    sendJson(response, 403, { error: 'Gateway API Key owner mismatch' });
    return;
  }
  if (message === 'caller_pod_access_unavailable') {
    sendJson(response, 401, { error: 'Authentication required' });
    return;
  }
  if (message === 'gateway_key_secret_write_failed') {
    sendJson(response, 500, { error: 'Gateway API Key secret could not be saved' });
    return;
  }
  logger.error(`Gateway API Key operation failed: ${message}`);
  sendJson(response, 500, { error: 'Gateway API Key operation failed' });
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
      ...(error.providerMessage ? { providerMessage: error.providerMessage } : {}),
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

function sendModelSelectionError(response: ServerResponse, error: unknown): void {
  if (error instanceof GatewayProtocolError) {
    const normalized = normalizeGatewayError(error);
    const details = safeModelSelectionErrorDetails(error.details);
    const message = stableModelSelectionMessage(error);
    sendJson(response, modelSelectionErrorStatus(error, details), {
      error: normalized.error.code,
      message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const stable: Record<string, { status: number; error: string }> = {
    model_selection_version_conflict: { status: 409, error: 'model_selection_version_conflict' },
    model_selection_default_not_picked: { status: 400, error: 'model_selection_default_not_picked' },
    model_selection_exact_remove_failed: { status: 409, error: 'model_selection_conflict' },
    model_selection_exact_update_failed: { status: 409, error: 'model_selection_conflict' },
    model_selection_provider_update_failed: { status: 409, error: 'model_selection_conflict' },
    service_access_missing: { status: 403, error: 'service_access_missing' },
    hosted_pod_auth_required: { status: 401, error: 'authentication_required' },
    hosted_pod_solid_principal_required: { status: 403, error: 'solid_principal_required' },
    hosted_pod_owner_mismatch: { status: 403, error: 'pod_owner_mismatch' },
  };
  const mapped = stable[message];
  if (mapped) {
    sendJson(response, mapped.status, { error: mapped.error });
    return;
  }
  logger.error(`Provider model selection failed: ${message}`);
  sendJson(response, 500, { error: 'Provider model selection failed' });
}

function modelSelectionErrorStatus(
  error: GatewayProtocolError,
  details: Record<string, unknown>,
): number {
  if (error.code === 'provider_error') return 502;
  if (details.reason === 'stale_credential' || details.reason === 'stale_catalog') return 409;
  return error.status;
}

function stableModelSelectionMessage(error: GatewayProtocolError): string {
  const stableMessages = new Set([
    'active_credential_required',
    'model_catalog_not_ready',
    'model_not_in_discovered_catalog',
    'model_selection_default_not_picked',
    'model_selection_version_conflict',
    'provider_not_configured',
    'provider_required',
  ]);
  if (stableMessages.has(error.message)) return error.message;
  if (error.code === 'provider_error') return 'Provider model discovery failed';
  return 'AI model selection request failed';
}

function safeModelSelectionErrorDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return {};
  }
  return publicSafeObject(details) as Record<string, unknown>;
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

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function sendAiConnectionsServiceAccessError(response: ServerResponse, error: unknown): void {
  if (error instanceof GatewayProtocolError && error.status >= 400 && error.status < 500) {
    sendJson(response, error.status, {
      error: error.code,
      message: 'AI Connection service access request was rejected',
    });
    return;
  }

  logger.warn('AI Connection service access is temporarily unavailable');
  sendJson(response, 503, {
    error: 'ai_connection_service_access_unavailable',
    message: 'AI Connection service access is temporarily unavailable',
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
