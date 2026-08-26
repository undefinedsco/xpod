import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import { ProviderModelsFetchError } from '../ai-connections/models/ProviderModelsAdapter';
import type { ProviderProbeService } from '../ai-connections/ProviderProbeService';

export interface AiConnectionsHandlerOptions {
  probeService: ProviderProbeService;
  jsonBodyLimitBytes?: number;
}

/**
 * Provider probes are stateless. The browser reads credentials from its Pod and
 * supplies one credential for this request; Xpod never reads the Pod here.
 */
export function registerAiConnectionsRoutes(
  server: ApiServer,
  options: AiConnectionsHandlerOptions,
): void {
  const jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? 64 * 1024;

  server.post('/api/ai/connections/providers/:provider/models/refresh', async (request, response, params) => {
    if (!authorizeCurrentSolidCaller(request, response)) {
      return;
    }
    const credential = await readProviderCredential(request, response, jsonBodyLimitBytes);
    if (!credential) {
      return;
    }
    try {
      const result = await options.probeService.discoverModels({
        provider: params.provider,
        ...credential,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendProbeError(response, error);
    }
  });

  server.post('/api/ai/connections/providers/:provider/quota/refresh', async (request, response, params) => {
    if (!authorizeCurrentSolidCaller(request, response)) {
      return;
    }
    const credential = await readProviderCredential(request, response, jsonBodyLimitBytes);
    if (!credential) {
      return;
    }
    try {
      sendJson(response, 200, await options.probeService.quota({
        provider: params.provider,
        ...credential,
      }));
    } catch (error) {
      sendProbeError(response, error);
    }
  });

}

function authorizeCurrentSolidCaller(
  request: AuthenticatedRequest,
  response: ServerResponse,
): boolean {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (request.auth.type !== 'solid' || !request.auth.webId) {
    sendJson(response, 403, { error: 'AI provider probes require the current Solid identity' });
    return false;
  }
  return true;
}

async function readProviderCredential(
  request: AuthenticatedRequest,
  response: ServerResponse,
  limitBytes: number,
): Promise<{ apiKey: string; baseUrl?: string } | undefined> {
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
  const object = body as Record<string, unknown>;
  const unexpected = Object.keys(object).filter((key) => key !== 'apiKey' && key !== 'baseUrl');
  if (unexpected.length > 0) {
    sendJson(response, 400, { error: 'provider_probe_body_invalid' });
    return undefined;
  }
  const apiKey = optionalString(object.apiKey);
  const baseUrl = optionalString(object.baseUrl);
  if (!apiKey) {
    sendJson(response, 400, { error: 'provider_api_key_required' });
    return undefined;
  }
  return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
}

function sendProbeError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProviderModelsFetchError) {
    sendJson(response, 502, {
      error: 'provider_models_fetch_failed',
      providerStatus: error.providerStatus,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'provider_api_key_required' || message === 'provider_base_url_not_allowed') {
    sendJson(response, 400, { error: message });
    return;
  }
  if (message.startsWith('Unknown AI provider')
    || message.startsWith('models_adapter_not_found:')
    || message.startsWith('quota_adapter_not_found:')) {
    sendJson(response, 404, { error: 'provider_not_supported' });
    return;
  }
  sendJson(response, 502, { error: 'provider_probe_failed' });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}
