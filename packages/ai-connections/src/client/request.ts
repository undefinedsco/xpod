import type {
  AiConnectAttempt,
  AiConnectionsClient,
  AiConnectionsProvider,
  AiGatewayModel,
  AiQuotaSnapshot,
  CreateAiConnectionsClientInput,
} from './types'
import {
  AiConnectionsRequestError,
  assertProvider,
  compactObject,
  isDefined,
  isRecord,
  normalizeAiConnectionsErrorMessage,
  parseAuthorizationMethodsSummary,
  parseConnectAttempt,
  parseCredential,
  parseCustomModelList,
  parseGatewayKeyRecord,
  parseGatewayModel,
  parseModelDiscovery,
  parseProviderCredentialSummary,
  parseProviderSummaries,
  readJson,
  sanitizePublicObject,
} from './normalize'

/**
 * The HTTP client itself: one factory over the Pod base URL and an authenticated
 * fetch, with every response normalised by `normalize.ts`.
 */
export function resolveAiConnectionsApiBase(podBaseUrl: string): string {
  const parsed = new URL(podBaseUrl)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Current Pod URL must use HTTP or HTTPS')
  }
  return parsed.origin
}

export function createAiConnectionsClient({
  webId,
  podBaseUrl,
  authenticatedFetch,
}: CreateAiConnectionsClientInput): AiConnectionsClient {
  const apiBase = resolveAiConnectionsApiBase(podBaseUrl)

  const request = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: Record<string, unknown>,
    context: { provider?: AiConnectionsProvider; authMode?: 'apiKey' | 'deviceCodeOAuth' | 'local' } = {},
  ): Promise<T> => {
    const response = await authenticatedFetch(`${apiBase}${path}`, {
      method,
      credentials: 'omit',
      mode: 'cors',
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await readJson(response)
    if (!response.ok) {
      throw new AiConnectionsRequestError(normalizeAiConnectionsErrorMessage(payload, response.status, context), payload)
    }
    return payload as T
  }

  const providerPath = (provider: AiConnectionsProvider): string => {
    assertProvider(provider)
    return `/api/ai/gateway/providers/${provider}`
  }
  const requestConnect = async (
    provider: AiConnectionsProvider,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<AiConnectAttempt> => {
    const payload = await request<unknown>(`${providerPath(provider)}${path}`, method, body, { provider })
    return parseConnectAttempt(payload, provider)
  }

  const listGatewayModels = async (): Promise<AiGatewayModel[]> => {
    const payload = await request<{ data?: unknown[] }>('/v1/models', 'GET')
    return Array.isArray(payload.data)
      ? payload.data.map(parseGatewayModel).filter(isDefined)
      : []
  }

  return {
    webId,
    apiBase,

    getServiceAccess() {
      return request<unknown>('/api/applets/service-access/ai-connections', 'GET')
    },

    async listProviders() {
      const payload = await request<{ data?: unknown[] }>('/api/ai/providers', 'GET')
      return Array.isArray(payload.data) ? parseProviderSummaries(payload.data) : []
    },

    async listAuthorizationMethods() {
      const response = await authenticatedFetch(`${apiBase}/api/ai/connections/authorization-methods`, {
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) return []
      const payload = await readJson(response)
      if (!response.ok) {
        throw new Error(normalizeAiConnectionsErrorMessage(payload, response.status))
      }
      return isRecord(payload) && Array.isArray(payload.data)
        ? payload.data.map(parseAuthorizationMethodsSummary).filter(isDefined)
        : []
    },

    listModels: listGatewayModels,
    listGatewayModels,

    async listGatewayKeys() {
      const payload = await request<{ data?: unknown[] }>('/api/ai/gateway/keys', 'GET')
      return Array.isArray(payload.data)
        ? payload.data.map(parseGatewayKeyRecord).filter(isDefined)
        : []
    },

    async createGatewayKey(input) {
      const payload = await request<{ key?: unknown; record?: unknown }>(
        '/api/ai/gateway/keys',
        'POST',
        compactObject(input),
      )
      if (typeof payload.key !== 'string' || !payload.key) {
        throw new Error('Xpod did not return the new API Key')
      }
      const record = parseGatewayKeyRecord(payload.record)
      if (!record) throw new Error('Xpod returned an invalid API Key record')
      return { plaintext: payload.key, record }
    },

    async revealGatewayKey(keyId) {
      const payload = await request<{ key?: unknown }>(
        `/api/ai/gateway/keys/${encodeURIComponent(keyId)}/reveal`,
        'POST',
      )
      if (typeof payload.key !== 'string' || !payload.key) {
        throw new Error('This API Key cannot be recovered from the Pod')
      }
      return payload.key
    },

    async updateGatewayKey(keyId, input) {
      const payload = await request<{ record?: unknown }>(
        `/api/ai/gateway/keys/${encodeURIComponent(keyId)}`,
        'PATCH',
        input,
      )
      const record = parseGatewayKeyRecord(payload.record)
      if (!record) throw new Error('Xpod returned an invalid API Key record')
      return record
    },

    async deleteGatewayKey(keyId) {
      await request<unknown>(
        `/api/ai/gateway/keys/${encodeURIComponent(keyId)}`,
        'DELETE',
      )
    },

    async beginConnect(provider, mode, options) {
      return await requestConnect(
        provider,
        '/connect/begin',
        'POST',
        compactObject({
          mode,
          offeringId: options?.offeringId,
          authorizationMethodId: options?.authorizationMethodId,
        }),
      )
    },

    connectStatus(provider, attempt) {
      if (!attempt.attemptId) {
        throw new Error('Connect attempt id is required')
      }
      const query = new URLSearchParams({
        state: attempt.state ?? '',
        signature: attempt.signature ?? '',
      })
      if (attempt.mode) query.set('mode', attempt.mode)
      return requestConnect(
        provider,
        `/connect/status/${encodeURIComponent(attempt.attemptId)}?${query}`,
        'GET',
      )
    },

    completeApiKey(provider, attempt, apiKey, accountLabel, baseUrl) {
      return requestConnect(
        provider,
        '/connect/complete-api-key',
        'POST',
        compactObject({
          attemptId: attempt.attemptId,
          state: attempt.state,
          signature: attempt.signature,
          offeringId: attempt.offeringId,
          apiKey,
          accountLabel,
          baseUrl,
        }),
      )
    },

    pollDevice(provider, attempt) {
      return requestConnect(
        provider,
        '/connect/poll',
        'POST',
        compactObject({
          mode: attempt.mode,
          attemptId: attempt.attemptId,
          state: attempt.state,
          signature: attempt.signature,
          offeringId: attempt.offeringId,
        }),
      )
    },

    cancelConnect(provider, attempt) {
      return requestConnect(
        provider,
        '/connect/cancel',
        'POST',
        compactObject({
          mode: attempt.mode,
          attemptId: attempt.attemptId,
          state: attempt.state,
          signature: attempt.signature,
          offeringId: attempt.offeringId,
        }),
      )
    },

    refreshOAuthCredential(provider, credentialId, refreshToken, expectedVersion, offeringId, mode) {
      return requestConnect(provider, '/connect/refresh', 'POST', {
        credentialId,
        refreshToken,
        expectedVersion,
        ...(offeringId ? { offeringId } : {}),
        ...(mode ? { mode } : {}),
      })
    },

    async disconnect(provider, credentialId) {
      const query = credentialId
        ? `?${new URLSearchParams({ credentialId })}`
        : ''
      const payload = await request<{ record?: unknown }>(
        `${providerPath(provider)}/connect${query}`,
        'DELETE',
      )
      return parseCredential(payload.record)
    },

    async createApiKeyCredential(provider, input) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/api-key`,
        'POST',
        compactObject({ ...input }),
        { provider },
      )
      const credential = parseProviderCredentialSummary(payload.credential)
      if (!credential) {
        throw new Error('AI Connection returned an invalid Provider credential')
      }
      return credential
    },

    async createLocalCredential(provider, input) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/local`,
        'POST',
        compactObject(input),
        { provider },
      )
      const credential = parseProviderCredentialSummary(payload.credential)
      if (!credential) throw new Error('AI Connection returned an invalid Provider credential')
      return credential
    },

    async updateProviderCredential(provider, credentialId, input) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/${encodeURIComponent(credentialId)}`,
        'PATCH',
      compactObject({ ...input }),
        { provider },
      )
      const credential = parseProviderCredentialSummary(payload.credential)
      if (!credential) {
        throw new Error('AI Connection returned an invalid Provider credential')
      }
      return credential
    },

    async deleteProviderCredential(provider, credentialId) {
      const payload = await request<{ credential?: unknown }>(
        `/api/ai/providers/${provider}/credentials/${encodeURIComponent(credentialId)}`,
        'DELETE',
        undefined,
        { provider },
      )
      return parseProviderCredentialSummary(payload.credential)
    },

    async testProviderCredential(provider, input) {
      const payload = await request<{ result?: unknown }>(
        `/api/ai/providers/${provider}/credentials/test`,
        'POST',
        compactObject({ ...input }),
        { provider },
      )
      return sanitizePublicObject(payload.result)
    },

    quota(provider, refresh = false, input) {
      const query = !refresh && input?.credentialIri
        ? `?credentialIri=${encodeURIComponent(input.credentialIri)}${input.offeringId ? `&offeringId=${encodeURIComponent(input.offeringId)}` : ''}`
        : ''
      return request<AiQuotaSnapshot>(
        `${providerPath(provider)}/quota/${refresh ? 'refresh' : 'status'}${query}`,
        refresh ? 'POST' : 'GET',
        refresh ? compactObject({ offeringId: input?.offeringId, credentialId: input?.credentialId, credentialIri: input?.credentialIri }) : undefined,
        { provider },
      )
    },

    quotaFromSecret(provider, input) {
      return request<AiQuotaSnapshot>(
        `${providerPath(provider)}/quota/refresh`,
        'POST',
        compactObject(input),
        { provider },
      )
    },

    async discoverModels(provider, input) {
      const payload = await request<unknown>(
        `${providerPath(provider)}/models/refresh`,
        'POST',
        compactObject({ ...input }),
        { provider, authMode: input?.authMode },
      )
      return parseModelDiscovery(payload, provider)
    },

    async saveProviderModel(provider, model) {
      const payload = await request<{ data?: unknown }>(
        providerPath(provider) + '/models',
        'POST',
        compactObject({
          id: model.id,
          displayName: model.displayName,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          capabilities: model.capabilities,
        }),
        { provider },
      )
      return parseCustomModelList(payload.data)
    },

    async deleteProviderModel(provider, modelId) {
      const payload = await request<{ data?: unknown }>(
        `${providerPath(provider)}/models/${encodeURIComponent(modelId)}`,
        'DELETE',
        undefined,
        { provider },
      )
      return parseCustomModelList(payload.data)
    },
  }
}
