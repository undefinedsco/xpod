// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SolidPermissionCapability,
  SolidServiceAccessRequest,
  WebExtensionHost,
  WebExtensionSolidCapability,
} from '@undefineds.co/extension-sdk/web'
import { AiConnectionsList, AiConnectionsMain, createAiConnectionsController } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_URL = 'https://pod.example/alice/'

const SERVICE_ACCESS_DESCRIPTOR = {
  appletId: 'co.undefineds.ai-connections',
  service: {
    webId: 'https://id.example/xpod/profile/card#me',
    label: 'Xpod AI Connection',
  },
  resources: [{
    id: 'providerCredentials',
    url: 'https://pod.example/alice/settings/credentials.ttl',
    mediaType: 'text/turtle',
    access: { read: true, append: true, write: true },
  }],
} satisfies SolidServiceAccessRequest

afterEach(cleanup)

function solidCapability(
  overrides: Partial<WebExtensionSolidCapability> = {},
): WebExtensionSolidCapability {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch

  return {
    session: {
      fetch: fetcher,
      getSnapshot: () => ({
        status: 'authenticated' as const,
        webId: WEB_ID,
      }),
      subscribe: () => () => undefined,
    },
    pod: {
      status: 'ready' as const,
      current: {
        webId: WEB_ID,
        podUrl: POD_URL,
        database: { id: 'db' },
        collections: 'ready' as const,
      },
    },
    requireLogin: vi.fn(async () => undefined),
    ...overrides,
  }
}

function permissionCapability(
  overrides: Partial<SolidPermissionCapability> = {},
): SolidPermissionCapability {
  return {
    inspectAgentAccess: vi.fn(async () => ({
      status: 'granted' as const,
      resources: SERVICE_ACCESS_DESCRIPTOR.resources,
    })),
    ensureAgentAccess: vi.fn(async () => ({
      status: 'granted' as const,
      resources: SERVICE_ACCESS_DESCRIPTOR.resources,
    })),
    revokeAgentAccess: vi.fn(async () => ({
      status: 'missing' as const,
      resources: SERVICE_ACCESS_DESCRIPTOR.resources,
    })),
    ...overrides,
  }
}

function hostFromSolid(solid: WebExtensionSolidCapability): WebExtensionHost {
  return {
    solid,
    navigation: {
      openExternal: vi.fn(async () => undefined),
    },
    capabilities: {},
  } as WebExtensionHost
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AI Connection controller host.solid integration', () => {
  it('treats an authenticated WebID-only host without Pod as unavailable', async () => {
    const sessionFetch = vi.fn(async () => {
      throw new Error('Pod-backed API must not be called without a Pod capability')
    }) as unknown as typeof fetch
    const solid = solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
      pod: undefined,
    })

    const controller = createAiConnectionsController(hostFromSolid(solid))

    expect(controller.sessionStatus).toBe('authenticated')
    expect(controller.podStatus).toBe('unavailable')
    expect(controller.client).toBeNull()
    expect(controller.serviceAccessState).toBe('missing')

    await controller.loadProviders()
    expect(sessionFetch).not.toHaveBeenCalled()
  })

  it('creates the API client from host.solid session fetch and ready Pod URL', async () => {
    const solid = solidCapability()

    const controller = createAiConnectionsController(hostFromSolid(solid))

    expect(controller.sessionStatus).toBe('authenticated')
    expect(controller.client?.webId).toBe(WEB_ID)
    expect(controller.client?.apiBase).toBe('https://pod.example')

    await controller.client?.listGatewayKeys()

    await waitFor(() => {
      expect(solid.session.fetch).toHaveBeenCalledWith(
        'https://pod.example/api/ai/gateway/keys',
        expect.objectContaining({ method: 'GET' }),
      )
    })
  })

  it('loads interactive Provider state from the host Pod store without service delegation', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected interactive API request: ${String(input)}`)
    }) as unknown as typeof fetch
    const listProviders = vi.fn(async () => [{
      id: 'openai',
      name: 'OpenAI',
      offerings: [],
      credentials: [],
      selectedModels: [],
      status: 'unconfigured',
    }])
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
      permissions: undefined,
    })) as WebExtensionHost & {
      capabilities: WebExtensionHost['capabilities'] & {
        aiConnectionsPodStore: { listProviders: typeof listProviders }
      }
    }
    host.capabilities.aiConnectionsPodStore = { listProviders }

    const controller = createAiConnectionsController(host)
    await controller.loadProviders()

    expect(listProviders).toHaveBeenCalledTimes(1)
    expect(controller.providerSummaries.openai?.status).toBe('unconfigured')
    expect(sessionFetch).not.toHaveBeenCalled()
  })

  it('persists a completed OAuth payload through the current Pod store exactly once', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/ai/gateway/providers/kimi/connect/poll')) {
        return Response.json({
          mode: 'deviceCodeOAuth',
          status: 'completed',
          provider: 'kimi',
          attemptId: 'attempt-1',
          oauthCredential: {
            accessToken: 'kimi-access-token',
            refreshToken: 'kimi-refresh-token',
            expiresAt: '2026-08-09T08:00:00.000Z',
          },
        })
      }
      throw new Error(`Unexpected interactive API request: ${String(input)}`)
    }) as unknown as typeof fetch
    const saveOAuthCredential = vi.fn(async () => ({ id: 'credentials.ttl#kimi-oauth-1' }))
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => []),
      saveOAuthCredential,
    }
    const controller = createAiConnectionsController(host)

    const result = await controller.client!.pollDevice('kimi', {
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
    })

    expect(saveOAuthCredential).toHaveBeenCalledTimes(1)
    expect(saveOAuthCredential).toHaveBeenCalledWith('kimi', expect.objectContaining({
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
    }))
    expect(result).toMatchObject({
      status: 'completed',
      credentialId: 'credentials.ttl#kimi-oauth-1',
    })
    expect(result).not.toHaveProperty('oauthCredential')
  })

  it('refreshes OAuth from the current Pod and updates the same credential by version', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/kimi\/connect\/refresh$/u)
      expect(JSON.parse(String(init?.body))).toEqual({
        credentialId: 'credentials.ttl#kimi-oauth-1',
        refreshToken: 'current-refresh-token',
        expectedVersion: 3,
      })
      return Response.json({
        mode: 'deviceCodeOAuth',
        status: 'completed',
        provider: 'kimi',
        credentialId: 'credentials.ttl#kimi-oauth-1',
        oauthCredential: {
          accessToken: 'next-access-token',
          refreshToken: 'next-refresh-token',
        },
      })
    }) as unknown as typeof fetch
    const updateOAuthCredential = vi.fn(async () => ({ id: 'credentials.ttl#kimi-oauth-1' }))
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'kimi',
        credentials: [{ id: 'credentials.ttl#kimi-oauth-1', version: 3 }],
      }]),
      readCredentialSecret: vi.fn(async () => ({
        type: 'deviceCodeOAuth',
        refreshToken: 'current-refresh-token',
      })),
      updateOAuthCredential,
    }
    const controller = createAiConnectionsController(host)

    const result = await controller.client!.refreshOAuthCredential(
      'kimi',
      'credentials.ttl#kimi-oauth-1',
      'must-not-use-caller-argument',
      999,
    )

    expect(updateOAuthCredential).toHaveBeenCalledWith(
      'kimi',
      'credentials.ttl#kimi-oauth-1',
      3,
      expect.objectContaining({ refreshToken: 'next-refresh-token' }),
    )
    expect(result).not.toHaveProperty('oauthCredential')
  })

  it('reads quota credentials from the current Pod and sends them only as a transient request', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/deepseek\/quota\/refresh$/u)
      expect(JSON.parse(String(init?.body))).toEqual(expect.objectContaining({
        credentialId: 'credentials.ttl#deepseek-primary',
        offeringId: 'api-platform',
        authMode: 'apiKey',
        secret: { type: 'apiKey', apiKey: 'deepseek-transient-key' },
      }))
      return Response.json({
        credential: 'credentials.ttl#deepseek-primary',
        status: 'available',
        windows: [{ name: 'USD.total_balance', remaining: 2 }],
        observedAt: '2026-08-09T08:00:00.000Z',
        expiresAt: '2026-08-09T08:05:00.000Z',
        source: 'deepseek:/user/balance',
      })
    }) as unknown as typeof fetch
    const readCredentialSecret = vi.fn(async () => ({
      type: 'apiKey',
      apiKey: 'deepseek-transient-key',
    }))
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'deepseek',
        credentials: [{
          id: 'credentials.ttl#deepseek-primary',
          offeringId: 'api-platform',
          authMode: 'apiKey',
          enabled: true,
          priority: 1,
          baseUrl: 'https://api.deepseek.com/v1',
        }],
      }]),
      readCredentialSecret,
    }
    const controller = createAiConnectionsController(host)

    await expect(controller.client!.quota('deepseek', true)).resolves.toMatchObject({
      status: 'available',
      windows: [{ remaining: 2 }],
    })
    expect(readCredentialSecret).toHaveBeenCalledWith('deepseek', 'credentials.ttl#deepseek-primary')
  })

  it('routes provider quota through the enabled credential offering identity', async () => {
    const requestBodies: unknown[] = []
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/bailian\/quota\/refresh$/u)
      requestBodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        credential: 'credentials.ttl#bailian-token',
        status: 'unsupported',
        windows: [],
        observedAt: '2026-08-09T00:00:00.000Z',
        expiresAt: '2026-08-09T01:00:00.000Z',
        source: 'bailian:console-only',
      })
    }) as unknown as typeof fetch
    const readCredentialSecret = vi.fn(async () => ({
      type: 'apiKey',
      apiKey: 'bailian-transient-key',
    }))
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'bailian',
        credentials: [
          {
            id: 'credentials.ttl#bailian-payg',
            offeringId: 'pay-as-you-go',
            authMode: 'apiKey',
            enabled: false,
            priority: 1,
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          },
          {
            id: 'credentials.ttl#bailian-token',
            offeringId: 'token-plan',
            authMode: 'apiKey',
            enabled: true,
            priority: 2,
            baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          },
        ],
      }]),
      readCredentialSecret,
    }
    const controller = createAiConnectionsController(host)

    await expect(controller.client!.quota('bailian', true)).resolves.toMatchObject({
      status: 'unsupported',
    })

    expect(readCredentialSecret).toHaveBeenCalledWith('bailian', 'credentials.ttl#bailian-token')
    expect(requestBodies).toEqual([
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#bailian-token',
        credentialIri: 'credentials.ttl#bailian-token',
      }),
    ])
  })

  it('routes quota through the requested credential before falling back to the requested offering', async () => {
    const requestBodies: unknown[] = []
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/bailian\/quota\/refresh$/u)
      requestBodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        credential: (JSON.parse(String(init?.body)) as { credentialId: string }).credentialId,
        status: 'available',
        windows: [{ name: 'tokens.remaining', remaining: 1000 }],
        observedAt: '2026-08-09T00:00:00.000Z',
        expiresAt: '2026-08-09T01:00:00.000Z',
        source: 'bailian:quota',
      })
    }) as unknown as typeof fetch
    const readCredentialSecret = vi.fn(async (_provider: string, credentialId: string) => ({
      type: 'apiKey',
      apiKey: `${credentialId}-secret`,
    }))
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'bailian',
        credentials: [
          {
            id: 'credentials.ttl#api-enabled',
            offeringId: 'api-platform',
            authMode: 'apiKey',
            enabled: true,
            priority: 1,
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          },
          {
            id: 'credentials.ttl#token-disabled',
            offeringId: 'token-plan',
            authMode: 'apiKey',
            enabled: false,
            priority: 2,
            baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          },
          {
            id: 'credentials.ttl#token-enabled',
            offeringId: 'token-plan',
            authMode: 'apiKey',
            enabled: true,
            priority: 3,
            baseUrl: 'https://token-plan-backup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          },
        ],
      }]),
      readCredentialSecret,
    }
    const controller = createAiConnectionsController(host)

    await controller.client!.quota('bailian', true, {
      offeringId: 'api-platform',
      credentialId: 'credentials.ttl#token-disabled',
    })
    await controller.client!.quota('bailian', true, { offeringId: 'token-plan' })

    expect(readCredentialSecret).toHaveBeenNthCalledWith(1, 'bailian', 'credentials.ttl#token-disabled')
    expect(readCredentialSecret).toHaveBeenNthCalledWith(2, 'bailian', 'credentials.ttl#token-enabled')
    expect(requestBodies).toEqual([
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#token-disabled',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        secret: { type: 'apiKey', apiKey: 'credentials.ttl#token-disabled-secret' },
      }),
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#token-enabled',
        baseUrl: 'https://token-plan-backup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        secret: { type: 'apiKey', apiKey: 'credentials.ttl#token-enabled-secret' },
      }),
    ])
  })

  it('discovers models only for the requested offering and forwards its identity', async () => {
    const requestBodies: unknown[] = []
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/bailian\/models\/refresh$/u)
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      return Response.json({
        provider: 'bailian',
        credential: body.credentialId,
        models: [{ id: 'qwen-token-only', displayName: 'Qwen Token Only' }],
        observedAt: '2026-08-09T08:00:00.000Z',
        source: 'bailian:token-plan:/models',
      })
    }) as unknown as typeof fetch
    const readCredentialSecret = vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient-secret' }))
    const saveDiscoveredModels = vi.fn(async () => undefined)
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'bailian',
        credentials: [
          { id: 'credentials.ttl#payg', offeringId: 'api-platform', enabled: true, priority: 1 },
          { id: 'credentials.ttl#token', offeringId: 'token-plan', enabled: true, priority: 2 },
        ],
      }]),
      readCredentialSecret,
      saveDiscoveredModels,
    }
    const controller = createAiConnectionsController(host)

    await expect(controller.client!.discoverModels('bailian', { offeringId: 'token-plan' })).resolves.toMatchObject({
      models: [{ id: 'qwen-token-only' }],
    })

    expect(readCredentialSecret).toHaveBeenCalledTimes(1)
    expect(readCredentialSecret).toHaveBeenCalledWith('bailian', 'credentials.ttl#token')
    expect(requestBodies).toEqual([expect.objectContaining({
      offeringId: 'token-plan',
      credentialId: 'credentials.ttl#token',
      authMode: 'apiKey',
      secret: {
        type: 'apiKey',
        apiKey: 'transient-secret',
      },
    })])
    expect(saveDiscoveredModels).toHaveBeenCalledWith(
      'bailian',
      'credentials.ttl#token',
      [expect.objectContaining({ id: 'qwen-token-only', displayName: 'Qwen Token Only', offeringId: 'token-plan' })],
    )
  })

  it('keeps duplicate discovered model ids when they come from different offerings', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/bailian\/models\/refresh$/u)
      const body = JSON.parse(String(init?.body)) as { credentialId: string; offeringId: string }
      return Response.json({
        provider: 'bailian',
        credential: body.credentialId,
        models: [
          { id: 'qwen-plus', displayName: `Qwen Plus ${body.offeringId}` },
          { id: `${body.offeringId}-only`, displayName: body.offeringId },
        ],
        observedAt: '2026-08-09T08:00:00.000Z',
        source: `bailian:${body.offeringId}:/models`,
      })
    }) as unknown as typeof fetch
    const readCredentialSecret = vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient-secret' }))
    const saveDiscoveredModels = vi.fn(async () => undefined)
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'bailian',
        credentials: [
          { id: 'credentials.ttl#api', offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: 1 },
          { id: 'credentials.ttl#token', offeringId: 'token-plan', authMode: 'apiKey', enabled: true, priority: 2 },
        ],
      }]),
      readCredentialSecret,
      saveDiscoveredModels,
    }
    const controller = createAiConnectionsController(host)

    const result = await controller.client!.discoverModels('bailian')

    expect(result.models).toEqual([
      expect.objectContaining({ id: 'qwen-plus', offeringId: 'api-platform' }),
      expect.objectContaining({ id: 'api-platform-only', offeringId: 'api-platform' }),
      expect.objectContaining({ id: 'qwen-plus', offeringId: 'token-plan' }),
      expect.objectContaining({ id: 'token-plan-only', offeringId: 'token-plan' }),
    ])
    expect(result.models.filter((model) => model.id === 'qwen-plus')).toHaveLength(2)
    expect(saveDiscoveredModels).toHaveBeenNthCalledWith(
      1,
      'bailian',
      'credentials.ttl#api',
      [
        expect.objectContaining({ id: 'qwen-plus', offeringId: 'api-platform' }),
        expect.objectContaining({ id: 'api-platform-only', offeringId: 'api-platform' }),
      ],
    )
    expect(saveDiscoveredModels).toHaveBeenNthCalledWith(
      2,
      'bailian',
      'credentials.ttl#token',
      [
        expect.objectContaining({ id: 'qwen-plus', offeringId: 'token-plan' }),
        expect.objectContaining({ id: 'token-plan-only', offeringId: 'token-plan' }),
      ],
    )
  })

  it('discovers OAuth provider models by forwarding only the discovery access token', async () => {
    const requestBodies: unknown[] = []
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/kimi\/models\/refresh$/u)
      requestBodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        provider: 'kimi',
        credential: 'credentials.ttl#kimi-oauth',
        models: [{ id: 'kimi-for-coding', displayName: 'Kimi for Coding' }],
        observedAt: '2026-08-09T00:00:00.000Z',
        source: 'kimi:official-subscription:/models',
      })
    }) as unknown as typeof fetch
    const readCredentialSecret = vi.fn(async () => ({
      type: 'oauth',
      accessToken: 'caller-access-token',
      refreshToken: 'browser-owned-refresh-token',
    }))
    const saveDiscoveredModels = vi.fn(async () => undefined)
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'kimi',
        credentials: [
          {
            id: 'credentials.ttl#kimi-oauth',
            offeringId: 'official-subscription',
            authMode: 'deviceCode',
            enabled: true,
            priority: 1,
          },
        ],
      }]),
      readCredentialSecret,
      saveDiscoveredModels,
    }
    const controller = createAiConnectionsController(host)

    await expect(controller.client!.discoverModels('kimi', { offeringId: 'official-subscription' })).resolves.toMatchObject({
      models: [{ id: 'kimi-for-coding' }],
    })

    expect(requestBodies).toEqual([expect.objectContaining({
      offeringId: 'official-subscription',
      credentialId: 'credentials.ttl#kimi-oauth',
      authMode: 'deviceCodeOAuth',
      secret: {
        type: 'oauth',
        accessToken: 'caller-access-token',
      },
    })])
    expect((requestBodies[0] as Record<string, unknown>)).not.toHaveProperty('apiKey')
    expect((requestBodies[0] as { secret?: Record<string, unknown> }).secret).not.toHaveProperty('refreshToken')
    expect(saveDiscoveredModels).toHaveBeenCalledWith(
      'kimi',
      'credentials.ttl#kimi-oauth',
      [expect.objectContaining({ id: 'kimi-for-coding', displayName: 'Kimi for Coding', offeringId: 'official-subscription' })],
    )
  })

  it('uses host CSS client credentials for coding-client Gateway key methods', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected opaque Gateway request: ${String(input)}`)
    }) as unknown as typeof fetch
    const capability = {
      list: vi.fn(async () => []),
      create: vi.fn(async (input: { name?: string; webId: string }) => ({
        plaintext: 'sk-Y2xpZW50LTE6c2VjcmV0',
        record: {
          id: 'client-1',
          resourceUrl: 'https://pod.example/.account/client-credentials/client-1/',
          owner: input.webId,
          name: input.name,
        },
      })),
      revoke: vi.fn(async () => undefined),
    }
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiClientCredentials = capability

    const controller = createAiConnectionsController(host)
    const created = await controller.client?.createGatewayKey({ name: 'Codex' })

    expect(created?.plaintext).toBe('sk-Y2xpZW50LTE6c2VjcmV0')
    expect(capability.create).toHaveBeenCalledWith({ name: 'Codex', webId: WEB_ID })
    expect(sessionFetch).not.toHaveBeenCalled()
  })

  it('renders the canonical SolidAuthBoundary and passes an opaque route id to the host', async () => {
    const requireLogin = vi.fn(async () => undefined)
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: vi.fn() as unknown as typeof fetch,
        getSnapshot: () => ({ status: 'anonymous' as const }),
        subscribe: () => () => undefined,
      },
      pod: { status: 'unavailable' },
      requireLogin,
    })))
    const login = vi.spyOn(controller, 'login')

    render(<AiConnectionsMain controller={controller} />)
    expect(controller.loginRoutes).toHaveLength(1)
    expect(controller.loginRoutes[0]?.id).toBe('xpod-current-origin')
    expect(controller.loginRoutes[0]?.identityProvider.url).toBe(`${window.location.origin}/.account/`)
    expect(screen.getByText('登录 Xpod')).toBeTruthy()
    expect(screen.queryByLabelText('Identity provider URL')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(login).toHaveBeenCalledWith('xpod-current-origin'))
    expect(requireLogin).toHaveBeenCalledTimes(1)
  })

  it('shows loading while the host-owned Pod is opening', () => {
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      pod: { status: 'opening' },
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByRole('status').textContent).toContain('正在打开当前 Pod')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
  })

  it('shows a retryable error state when the host-owned Pod fails', () => {
    const requireLogin = vi.fn(async () => undefined)
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      pod: {
        status: 'error',
        error: new Error('Pod 打开失败'),
      },
      requireLogin,
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByText('Pod 打开失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    expect(requireLogin).toHaveBeenCalledTimes(1)
  })

  it('does not let stale provider loads roll back badge state after API key save or disconnect', async () => {
    const staleProviderLoad = deferred<Response>()
    const providerLoadQueue = [staleProviderLoad]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/providers')) {
        const load = providerLoadQueue.shift()
        if (!load) throw new Error('Unexpected provider load')
        return await load.promise
      }
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/keys')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/begin')) {
        return new Response(JSON.stringify({
          provider: 'openai',
          mode: 'browserAssistedApiKey',
          status: 'pending',
          attemptId: 'attempt-1',
          state: 'state-1',
          signature: 'signature-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect/complete-api-key')) {
        return new Response(JSON.stringify({
          provider: 'openai',
          mode: 'browserAssistedApiKey',
          status: 'completed',
          credentialId: 'credential-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/connect')) {
        return new Response(JSON.stringify({
          record: {
            id: 'credential-1',
            credentialIri: 'https://pod.example/credentials/openai',
            webId: WEB_ID,
            provider: 'openai',
            authMode: 'browserAssistedApiKey',
            status: 'disconnected',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions: permissionCapability(),
    })))
    void controller.ensureServiceAccess()

    render(<>{<AiConnectionsList controller={controller} />}<AiConnectionsMain controller={controller} /></>)

    const openAiButton = screen.getByRole('option', { name: 'OpenAI' })
    const describedBy = openAiButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe('读取中')
    await waitFor(() => {
      expect(
        vi.mocked(fetcher).mock.calls.filter(([input]) => String(input).endsWith('/api/ai/providers')),
      ).toHaveLength(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    await waitFor(() => {
      expect(screen.getByText('连接中')).toBeTruthy()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('连接中')).toBeTruthy()

    fireEvent.change(await screen.findByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-provider-secret' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('已配置')
    })

    const staleDisconnected = new Response(JSON.stringify({
      data: [{
        provider: 'openai',
        status: 'disconnected',
        connect: {
          modes: ['browserAssistedApiKey'],
          configured: false,
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    staleProviderLoad.resolve(staleDisconnected)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.getElementById(describedBy!)?.textContent).toBe('已配置')

    fireEvent.click(screen.getByRole('button', { name: '移除配置' }))

    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('未设置')
    })
  })

  it('single-flights service access bootstrap before loading providers', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.endsWith('/api/ai/providers')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const permissions = permissionCapability()
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions,
    })))

    await Promise.all([
      controller.ensureServiceAccess(),
      controller.ensureServiceAccess(),
    ])

    expect(controller.serviceAccessState).toBe('granted')
    expect(fetcher).toHaveBeenCalledWith(
      'https://pod.example/api/applets/service-access/ai-connections',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(permissions.ensureAgentAccess).toHaveBeenCalledTimes(1)
    expect(permissions.ensureAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appletId: 'co.undefineds.ai-connections' }),
    )
    expect(
      vi.mocked(fetcher).mock.calls.filter(([input]) => String(input).endsWith('/api/ai/providers')),
    ).toHaveLength(1)
  })

  it('groups Provider credentials into one controller summary per product', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/providers')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'bailian',
            name: 'Alibaba Bailian',
            status: 'available',
            offerings: [
              { id: 'pay-as-you-go', label: 'Pay as You Go', kind: 'payAsYouGo', authModes: ['apiKey'], runtimeProviderIds: ['bailian'] },
              { id: 'coding-plan', label: 'Coding Plan', kind: 'codingPlan', authModes: ['apiKey'], runtimeProviderIds: ['bailian-coding-plan'] },
              { id: 'token-plan', label: 'Token Plan', kind: 'tokenPlan', authModes: ['apiKey'], runtimeProviderIds: ['bailian-token-plan'] },
            ],
            credentials: [
              { id: 'cred-payg', offeringId: 'pay-as-you-go', authMode: 'apiKey', label: 'PAYG', enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-...payg', version: 1, encryptedSecret: 'ciphertext-payg' },
              { id: 'cred-coding', offeringId: 'coding-plan', authMode: 'apiKey', label: 'Coding', enabled: true, priority: 20, health: 'unknown', maskedHint: 'sk-...code', version: 2, apiKey: 'sk-secret-coding' },
              { id: 'cred-token', offeringId: 'token-plan', authMode: 'apiKey', label: 'Token', enabled: false, priority: 30, health: 'expired', maskedHint: 'sk-...tokn', version: 3, refreshToken: 'refresh-secret' },
            ],
            selectedModels: [{ id: 'qwen-max', provider: 'bailian', apiKey: 'model-secret' }],
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
    })))

    await controller.loadProviders()

    expect(controller.providerStates.bailian).toBe('configured')
    expect(controller.providerSummaries.bailian?.credentials).toHaveLength(3)
    expect(controller.providerSummaries.bailian).toMatchObject({
      id: 'bailian',
      name: 'Alibaba Bailian',
      status: 'available',
    })
    expect(JSON.stringify(controller.providerSummaries.bailian)).not.toMatch(/encryptedSecret|refreshToken|ciphertext|sk-secret|model-secret/)
  })

  it('revokes service access through the generic host permission capability', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const permissions = permissionCapability()
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions,
    })))

    await controller.revokeServiceAccess()

    expect(controller.serviceAccessState).toBe('missing')
    expect(permissions.revokeAgentAccess).toHaveBeenCalledTimes(1)
    expect(permissions.revokeAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ appletId: 'co.undefineds.ai-connections' }),
    )
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
  })

  it('does not load providers when host permission capability is unavailable', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(SERVICE_ACCESS_DESCRIPTOR), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
    })))

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('capabilityUnavailable')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps malformed service-access descriptors to invalidDescriptor', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify({
          appletId: 'co.undefineds.ai-connections',
          service: {
            webId: 'https://id.example/xpod/profile/card#me',
            label: 'Xpod AI Connection',
          },
          resources: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const permissions = permissionCapability()
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions,
    })))

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('invalidDescriptor')
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
  })

  it('maps malformed service-access resource URLs to invalidDescriptor', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/applets/service-access/ai-connections')) {
        return new Response(JSON.stringify({
          appletId: 'co.undefineds.ai-connections',
          service: {
            webId: 'https://id.example/xpod/profile/card#me',
            label: 'Xpod AI Connection',
          },
          resources: [{
            id: 'providerCredentials',
            url: 'not a url',
            mediaType: 'text/turtle',
            access: { read: true, append: true, write: true },
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as unknown as typeof fetch
    const permissions = permissionCapability()
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: fetcher,
        getSnapshot: () => ({
          status: 'authenticated',
          webId: WEB_ID,
        }),
        subscribe: () => () => undefined,
      },
      permissions,
    })))

    await controller.ensureServiceAccess()

    expect(controller.serviceAccessState).toBe('invalidDescriptor')
    expect(permissions.ensureAgentAccess).not.toHaveBeenCalled()
  })
})
