import { describe, expect, it, vi } from 'vitest'
import {
  createAiConnectionsClient,
  resolveAiConnectionsApiBase,
} from '../src/ai-connections-client'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_BASE = 'https://pod.example/alice/'

describe('AI Connection management client', () => {
  it('derives the management API from the current Pod and uses authenticated fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.listGatewayKeys()

    expect(resolveAiConnectionsApiBase(POD_BASE)).toBe('https://pod.example')
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/keys',
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
      }),
    )
  })

  it('loads safe current-identity Provider status from the AI Connection product route', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        provider: 'kimi',
        status: 'connected',
        authMode: 'deviceCodeOAuth',
        accountLabel: 'user@example.com',
        baseUrl: 'https://proxy.example/v1',
        deployment: 'cloud',
        webId: WEB_ID,
        metadata: { token: 'secret' },
        connect: {
          modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
          configured: true,
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const providers = await client.listProviders()

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/providers',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(providers).toMatchObject([{
      id: 'kimi',
      name: 'Kimi',
      credentials: [{
        id: 'kimi:current',
        offeringId: 'official-subscription',
        authMode: 'deviceCode',
        label: 'user@example.com',
        enabled: true,
        priority: 0,
        health: 'healthy',
        baseUrl: 'https://proxy.example/v1',
        version: 0,
      }],
      status: 'available',
    }])
    expect(providers[0]?.offerings).toEqual([])
    expect(providers[0]?.selectedModels).toEqual([])
    expect(JSON.stringify(providers)).not.toMatch(/deployment|webId|metadata|secret/)
  })

  it('parses grouped Provider credentials without exposing secrets', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: 'bailian',
        name: 'Alibaba Bailian',
        status: 'available',
        offerings: [
          {
            id: 'pay-as-you-go', label: 'Pay as You Go', productLabel: 'Alibaba Bailian', lifecycle: 'active',
            kind: 'api-platform', authModes: ['apiKey'], runtimeProviderIds: ['bailian'],
            credentialPrefixHints: ['sk-'], consoleUrl: 'https://console.example',
            subscriptionUrl: 'https://subscribe.example',
            endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.example/v1', region: 'cn' }],
            modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
            quota: { strategy: 'providerApi', url: 'https://quota.example' },
            usagePolicyUrl: 'https://policy.example', region: 'cn',
          },
          { id: 'coding-plan', label: 'Coding Plan', kind: 'token-plan', authModes: ['apiKey'], runtimeProviderIds: ['bailian-coding-plan'] },
          { id: 'token-plan', label: 'Token Plan', kind: 'token-plan', authModes: ['apiKey'], runtimeProviderIds: ['bailian-token-plan'] },
        ],
        credentials: [
          { id: 'cred-payg', offeringId: 'pay-as-you-go', authMode: 'apiKey', label: 'PAYG', enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-...payg', version: 1, apiKey: 'sk-secret-payg' },
          { id: 'cred-coding', offeringId: 'coding-plan', authMode: 'apiKey', label: 'Coding', enabled: true, priority: 20, health: 'unknown', maskedHint: 'sk-...code', version: 2, encryptedSecret: 'ciphertext-coding' },
          { id: 'cred-token', offeringId: 'token-plan', authMode: 'apiKey', label: 'Token', enabled: false, priority: 30, health: 'expired', expiresAt: '2026-08-08T00:00:00.000Z', maskedHint: 'sk-...tokn', version: 3, accessToken: 'token-secret' },
        ],
        selectedModels: [
          { id: 'qwen-max', provider: 'bailian', secret: 'model-secret' },
        ],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const providers = await client.listProviders()

    expect(providers).toMatchObject([{
      id: 'bailian',
      name: 'Alibaba Bailian',
      offerings: [
        {
          id: 'pay-as-you-go', productLabel: 'Alibaba Bailian', lifecycle: 'active', credentialPrefixHints: ['sk-'],
          consoleUrl: 'https://console.example', subscriptionUrl: 'https://subscribe.example',
          endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.example/v1', region: 'cn' }],
          modelDiscovery: { strategy: 'openaiCompatible', path: '/models', endpointProtocol: 'chatCompletions' },
          quota: { strategy: 'providerApi', url: 'https://quota.example' },
          usagePolicyUrl: 'https://policy.example', region: 'cn',
        },
        { id: 'coding-plan' },
        { id: 'token-plan' },
      ],
      credentials: [
        { id: 'cred-payg', offeringId: 'pay-as-you-go', authMode: 'apiKey' },
        { id: 'cred-coding', offeringId: 'coding-plan', authMode: 'apiKey' },
        { id: 'cred-token', offeringId: 'token-plan', authMode: 'apiKey' },
      ],
      selectedModels: [{ id: 'qwen-max', provider: 'bailian' }],
      status: 'available',
    }])
    expect(JSON.stringify(providers)).not.toMatch(/encryptedSecret|accessToken|sk-secret|ciphertext|token-secret|model-secret/)
  })

  it('creates API-key credentials through the Provider credential-pool route without exposing secrets', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      credential: {
        id: 'openai-key-work',
        provider: 'openai',
        offeringId: 'api-platform',
        authMode: 'apiKey',
        label: 'Work key',
        enabled: true,
        priority: 20,
        health: 'healthy',
        maskedHint: 'sk-...work',
        baseUrl: 'https://proxy.example/v1',
        version: 1,
        encryptedSecret: 'ciphertext',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const credential = await client.createApiKeyCredential('openai', {
      offeringId: 'api-platform',
      apiKey: 'sk-new-secret',
      label: 'Work key',
      baseUrl: 'https://proxy.example/v1',
      priority: 20,
    })

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/providers/openai/credentials/api-key',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          offeringId: 'api-platform',
          apiKey: 'sk-new-secret',
          label: 'Work key',
          baseUrl: 'https://proxy.example/v1',
          priority: 20,
        }),
      }),
    )
    expect(credential).toMatchObject({
      id: 'openai-key-work',
      offeringId: 'api-platform',
      authMode: 'apiKey',
      label: 'Work key',
      maskedHint: 'sk-...work',
      baseUrl: 'https://proxy.example/v1',
      version: 1,
    })
    expect(JSON.stringify(credential)).not.toMatch(/sk-new-secret|ciphertext/)
  })

  it('patches, deletes, and tests exact Provider credentials through credential-pool routes', async () => {
    const authenticatedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/providers/openai/credentials/openai-key-work')) {
        return new Response(JSON.stringify({
          credential: {
            id: 'openai-key-work',
            provider: 'openai',
            offeringId: 'api-platform',
            authMode: 'apiKey',
            label: 'Paused key',
            enabled: false,
            priority: 30,
            health: 'unknown',
            version: 8,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/api/ai/providers/openai/credentials/test')) {
        return new Response(JSON.stringify({
          result: {
            status: 'ok',
            checkedAt: '2026-08-08T00:00:00.000Z',
            apiKey: 'must-not-return',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected url: ${url}`)
    }) as unknown as typeof fetch
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.updateProviderCredential('openai', 'openai-key-work', {
      expectedVersion: 7,
      label: 'Paused key',
      enabled: false,
      priority: 30,
      baseUrl: 'https://proxy.example/v1',
    })
    await client.deleteProviderCredential('openai', 'openai-key-work')
    const result = await client.testProviderCredential('openai', { credentialId: 'openai-key-work' })

    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      'https://pod.example/api/ai/providers/openai/credentials/openai-key-work',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 7,
          label: 'Paused key',
          enabled: false,
          priority: 30,
          baseUrl: 'https://proxy.example/v1',
        }),
      }),
    )
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      'https://pod.example/api/ai/providers/openai/credentials/openai-key-work',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      3,
      'https://pod.example/api/ai/providers/openai/credentials/test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ credentialId: 'openai-key-work' }),
      }),
    )
    expect(result).toEqual({
      status: 'ok',
      checkedAt: '2026-08-08T00:00:00.000Z',
    })
  })

  it('discovers the AI Connection service-access descriptor with authenticated fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      appletId: 'co.undefineds.ai-connections',
      service: {
        webId: 'https://id.example/xpod/profile/card#me',
        label: 'Xpod AI Connection',
      },
      resources: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.getServiceAccess()).resolves.toMatchObject({
      appletId: 'co.undefineds.ai-connections',
    })
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/applets/service-access/ai-connections',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('normalizes service-access discovery failures', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'AI Connection service identity is unavailable',
    }), { status: 503, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.getServiceAccess()).rejects.toThrow(
      'AI Connection service identity is unavailable',
    )
  })

  it('does not expose secrets from non-OK server errors', async () => {
    const leaked = [
      'sk-live-secret',
      'xpod_once_secret',
      'apiKey=provider-secret',
      'token=provider-token',
      'Authorization: Bearer provider-bearer',
      '{"secret":"json-secret"}',
    ].join(' ')
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: leaked,
    }), { status: 500, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.listGatewayKeys()).rejects.toThrow(
      'AI Connection request failed. Please try again.',
    )
    await expect(client.listGatewayKeys()).rejects.not.toThrow(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
  })

  it('keeps useful allowlisted server codes without exposing raw details', async () => {
    const responses = [
      { code: 'not_configured', error: 'not_configured: missing token sk-live-secret' },
      { code: 'unsupported', error: 'unsupported: Authorization Bearer provider-secret' },
    ]
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const messages: string[] = []
    for (let index = 0; index < 2; index += 1) {
      try {
        await client.quota('openai')
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error))
      }
    }
    expect(messages).toEqual([
      'OpenAI connection is not configured.',
      'OpenAI does not support this operation.',
    ])
    expect(messages.join(' ')).not.toMatch(/sk-|token|Bearer|provider-secret/)
  })

  it('forwards offering identity through quota status and refresh requests', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      credential: 'credentials.ttl#bailian-token',
      status: 'unsupported',
      windows: [],
      observedAt: '2026-08-09T00:00:00.000Z',
      expiresAt: '2026-08-09T01:00:00.000Z',
      source: 'bailian:console-only',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.quota('bailian', false, {
      offeringId: 'token-plan',
      credentialIri: 'credentials.ttl#bailian-token',
    })
    await client.quota('bailian', true, {
      offeringId: 'token-plan',
      credentialId: 'credentials.ttl#bailian-token',
      credentialIri: 'credentials.ttl#bailian-token',
    })

    expect(authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      'https://pod.example/api/ai/gateway/providers/bailian/quota/status?credentialIri=credentials.ttl%23bailian-token&offeringId=token-plan',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(JSON.parse(String(authenticatedFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      offeringId: 'token-plan',
      credentialId: 'credentials.ttl#bailian-token',
      credentialIri: 'credentials.ttl#bailian-token',
    })
  })

  it('normalizes only attributable models from the current-identity model catalog', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.4',
          provider: 'openai',
          name: 'GPT-5.4',
          context_window: 200_000,
          protocols: ['responses', 'chat-completions'],
          secret: 'must-not-escape',
        },
        { id: 'qwen3-max', owned_by: 'dashscope' },
        { id: 'linx-lite', provider: 'openai' },
        { id: 'unattributed-model' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const models = await client.listModels()

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/v1/models',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(models).toEqual([
      {
        id: 'gpt-5.4',
        provider: 'openai',
        displayName: 'GPT-5.4',
        contextWindow: 200_000,
        protocols: ['responses', 'chat-completions'],
      },
      { id: 'qwen3-max', provider: 'bailian' },
    ])
    expect(JSON.stringify(models)).not.toContain('must-not-escape')
  })

  it('never exposes deployment or plaintext key fields from subsequent key lists', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: 'key-1',
        owner: WEB_ID,
        deployment: 'cloud',
        key: 'must-not-escape',
        scopes: ['models:read'],
        createdAt: '2026-07-24T00:00:00.000Z',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const keys = await client.listGatewayKeys()

    expect(keys).toEqual([{
      id: 'key-1',
      owner: WEB_ID,
      scopes: ['models:read'],
      createdAt: '2026-07-24T00:00:00.000Z',
    }])
    expect(JSON.stringify(keys)).not.toMatch(/deployment|must-not-escape/)
  })

  it('returns a newly-created plaintext key only from the create response', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      key: 'xpod_once_secret',
      record: {
        id: 'key-2',
        owner: WEB_ID,
        deployment: 'local',
        scopes: ['models:read', 'inference:write'],
        createdAt: '2026-07-24T00:00:00.000Z',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const created = await client.createGatewayKey({ name: 'Codex' })

    expect(created.plaintext).toBe('xpod_once_secret')
    expect(created.record).not.toHaveProperty('deployment')
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/keys',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Codex' }),
      }),
    )
  })

  it('binds provider operations to the fixed provider route and current identity fetch', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: 'openai',
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/providers/openai/connect/begin',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ mode: 'browserAssistedApiKey' }),
      }),
    )
  })

  it('disconnects a specific Provider credential when credentialId is supplied', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      record: {
        id: 'cloud-kimi-oauth',
        credentialIri: 'https://pod.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth',
        webId: WEB_ID,
        provider: 'kimi',
        authMode: 'oauth',
        status: 'disconnected',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.disconnect('kimi', 'cloud-kimi-oauth')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/providers/kimi/connect?credentialId=cloud-kimi-oauth',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('removes infrastructure deployment fields from Connect responses', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: 'openai',
      deployment: 'cloud',
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const result = await client.beginConnect('openai', 'browserAssistedApiKey')

    expect(result).not.toHaveProperty('deployment')
  })

  it('rejects unknown providers before constructing a request path', async () => {
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch: vi.fn(),
    })

    await expect(client.beginConnect('evil/provider' as never, 'browserAssistedApiKey'))
      .rejects.toThrow('Unsupported AI provider')
  })

  it('discovers provider models through the server-side refresh route', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      provider: 'kimi',
      credential: 'https://pod.example/alice/.data/credentials.ttl#kimi',
      models: [
        { id: 'kimi-k2', displayName: 'Kimi K2' },
        { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
        { invalid: true },
      ],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const discovery = await client.discoverModels('kimi')

    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/gateway/providers/kimi/models/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(discovery).toEqual({
      provider: 'kimi',
      credential: 'https://pod.example/alice/.data/credentials.ttl#kimi',
      models: [
        { id: 'kimi-k2', displayName: 'Kimi K2' },
        { id: 'moonshot-v1-8k', capabilities: ['function_calling'] },
      ],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: 'kimi:/models',
    })
  })

  it('sends caller-owned OAuth model refresh as authMode plus secret, not an apiKey alias', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      provider: 'kimi',
      credential: 'credentials.ttl#kimi-oauth',
      models: [{ id: 'kimi-for-coding' }],
      observedAt: '2026-08-09T00:00:00.000Z',
      source: 'kimi:official-subscription:/models',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await client.discoverModels('kimi', {
      credentialId: 'credentials.ttl#kimi-oauth',
      offeringId: 'official-subscription',
      authMode: 'deviceCodeOAuth',
      secret: {
        type: 'oauth',
        accessToken: 'caller-access-token',
      },
    })

    const requestInit = authenticatedFetch.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(requestInit.body))).toEqual({
      credentialId: 'credentials.ttl#kimi-oauth',
      offeringId: 'official-subscription',
      authMode: 'deviceCodeOAuth',
      secret: {
        type: 'oauth',
        accessToken: 'caller-access-token',
      },
    })
    expect((JSON.parse(String(requestInit.body)).secret)).not.toHaveProperty('refreshToken')
  })

  it('maps provider fetch failures to the LinX verification messages', async () => {
    const scenarios = [
      { providerStatus: 401, message: '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。' },
      { providerStatus: 404, message: '模型服务地址不正确。请检查服务地址后重试。' },
      { providerStatus: 429, message: '请求太频繁。请稍等一会儿再试。' },
      { providerStatus: 503, message: '模型服务暂时没有响应。请稍后重试。' },
    ]
    for (const scenario of scenarios) {
      const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
        error: 'provider_models_fetch_failed',
        providerStatus: scenario.providerStatus,
      }), { status: 502, headers: { 'content-type': 'application/json' } }))
      const scoped = createAiConnectionsClient({
        webId: WEB_ID,
        podBaseUrl: POD_BASE,
        authenticatedFetch,
      })
      await expect(scoped.discoverModels('kimi')).rejects.toThrow(scenario.message)
    }
  })

  it('preserves safe upstream model discovery failure details', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'provider_models_fetch_failed',
      providerStatus: 403,
      providerMessage: 'API Key 所属分组已停用',
    }), { status: 502, headers: { 'content-type': 'application/json' } }))
    const scoped = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(scoped.discoverModels('openai')).rejects.toThrow(
      '密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。 上游返回：API Key 所属分组已停用',
    )
  })

  it('maps registry capability objects and custom capability lists onto catalog models', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'gpt-5', owned_by: 'openai', capabilities: { imageInput: true, toolCalls: true, reasoningEffort: true, promptCaching: true } },
        { id: 'gpt-4.1', owned_by: 'openai', capabilities: { promptCaching: true } },
        { id: 'ft-mine', owned_by: 'openai', custom: true, display_name: 'Mine', modalities: { input: ['text', 'image'] }, custom_capabilities: ['web'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const models = await client.listModels()
    expect(models).toEqual([
      { id: 'gpt-5', provider: 'openai', capabilities: ['image', 'tool_call', 'reasoning'] },
      { id: 'gpt-4.1', provider: 'openai' },
      { id: 'ft-mine', provider: 'openai', custom: true, displayName: 'Mine', inputModalities: ['text', 'image'], capabilities: ['web'] },
    ])
  })

  it('preserves offering and resource identity from gateway model payloads', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'shared-model',
          provider: 'kimi',
          offeringId: 'official-subscription',
          resourceId: 'urn:model:kimi:official-subscription:shared-model',
        },
        {
          id: 'shared-model',
          provider: 'kimi',
          offeringId: 'api-platform',
          resourceId: 'urn:model:kimi:api-platform:shared-model',
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    await expect(client.listModels()).resolves.toEqual([
      {
        id: 'shared-model',
        provider: 'kimi',
        offeringId: 'official-subscription',
        resourceId: 'urn:model:kimi:official-subscription:shared-model',
      },
      {
        id: 'shared-model',
        provider: 'kimi',
        offeringId: 'api-platform',
        resourceId: 'urn:model:kimi:api-platform:shared-model',
      },
    ])
  })

  it('keeps same-id selected models from separate offerings when provider summaries merge', async () => {
    const authenticatedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'kimi',
          status: 'available',
          offerings: [{ id: 'token-plan', authModes: ['apiKey'] }],
          credentials: [],
          selectedModels: [{ id: 'shared-model', provider: 'kimi', offeringId: 'token-plan' }],
        },
        {
          id: 'kimi',
          status: 'available',
          offerings: [{ id: 'api-platform', authModes: ['apiKey'] }],
          credentials: [],
          selectedModels: [{ id: 'shared-model', provider: 'kimi', offeringId: 'api-platform' }],
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const providers = await client.listProviders()

    expect(providers).toHaveLength(1)
    expect(providers[0]?.selectedModels).toEqual([
      { id: 'shared-model', provider: 'kimi', offeringId: 'token-plan' },
      { id: 'shared-model', provider: 'kimi', offeringId: 'api-platform' },
    ])
  })

  it('saves and deletes custom provider models through the management routes', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const authenticatedFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify({
        data: [{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const client = createAiConnectionsClient({
      webId: WEB_ID,
      podBaseUrl: POD_BASE,
      authenticatedFetch,
    })

    const saved = await client.saveProviderModel('openai', {
      id: 'ft-a',
      displayName: 'A',
      inputModalities: ['image'],
      capabilities: ['tool_call'],
    })
    expect(saved).toEqual([{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }])

    const remaining = await client.deleteProviderModel('openai', 'ft-a/latest')
    expect(remaining).toEqual([{ id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] }])

    expect(calls).toEqual([
      {
        url: 'https://pod.example/api/ai/gateway/providers/openai/models',
        method: 'POST',
        body: { id: 'ft-a', displayName: 'A', inputModalities: ['image'], capabilities: ['tool_call'] },
      },
      {
        url: `https://pod.example/api/ai/gateway/providers/openai/models/${encodeURIComponent('ft-a/latest')}`,
        method: 'DELETE',
        body: undefined,
      },
    ])
  })
})
