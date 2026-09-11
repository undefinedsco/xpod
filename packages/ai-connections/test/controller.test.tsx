// @vitest-environment jsdom
import './setup-jsdom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  WebExtensionHost,
  WebExtensionSolidCapability,
} from '@undefineds.co/extension-sdk/web'
import { normalizeAiConnectionsThrownError } from '../src/ai-connections-client'
import type { AiProviderSummary } from '../src'
import { AiConnectionsList, AiConnectionsMain, createAiConnectionsController } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const POD_URL = 'https://pod.example/alice/'

afterEach(cleanup)

it('keeps the Gateway routing catalog separate from the host Pod model catalog', async () => {
  const solid = solidCapability()
  vi.mocked(solid.session.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'kimi-k2.5', owned_by: 'kimi' }, { id: 'deepseek-v4-pro', owned_by: 'deepseek' },
  ] }), { headers: { 'content-type': 'application/json' } }))
  const host = hostFromSolid(solid)
  host.capabilities.aiConnectionsPodStore = {
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => [{ id: 'unselected-pod-model', provider: 'kimi' }]),
  }
  const controller = createAiConnectionsController(host)
  expect(await controller.client?.listModels()).toEqual([{ id: 'unselected-pod-model', provider: 'kimi' }])
  expect(await controller.client?.listGatewayModels?.()).toEqual([
    { id: 'kimi-k2.5', provider: 'kimi' }, { id: 'deepseek-v4-pro', provider: 'deepseek' },
  ])
  expect(solid.session.fetch).toHaveBeenCalledWith('https://pod.example/v1/models', expect.any(Object))
})

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

function mockCalls<T extends (...args: any[]) => unknown>(fn: T): Parameters<T>[] {
  return (fn as unknown as { mock: { calls: Parameters<T>[] } }).mock.calls
}

describe('AI Connection controller host.solid integration', () => {
  it('disables creation from the first render until the real provider catalog resolves', async () => {
    const providerLoad = deferred<AiProviderSummary[]>()
    const solid = solidCapability()
    const host = hostFromSolid(solid)
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(() => providerLoad.promise),
      listModels: vi.fn(async () => []),
      createApiKeyCredential: vi.fn(async () => undefined),
    }
    const controller = createAiConnectionsController(host)
    controller.selectProvider('openai')
    render(<AiConnectionsMain controller={controller} />)

    const create = screen.getByRole('button', { name: '新建 API Key 连接' })
    expect(create).toHaveProperty('disabled', true)
    fireEvent.click(create)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mockCalls(solid.session.fetch).some(([url]) => String(url).endsWith('/connect/begin'))).toBe(false)

    providerLoad.resolve([{
      id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
      offerings: [{ id: 'api-platform', kind: 'api-platform', authModes: ['apiKey'] }],
    }])
    await waitFor(() => expect(screen.getByRole('button', { name: '新建 API Key 连接' })).toHaveProperty('disabled', false))
    fireEvent.click(screen.getByRole('button', { name: '新建 API Key 连接' }))
    expect(screen.getByRole('dialog', { name: '新建连接' })).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: '接入方式' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }))
    expect(screen.getByLabelText('OpenAI Base URL 输入')).toBeTruthy()
    expect(mockCalls(solid.session.fetch).some(([url]) => String(url).endsWith('/connect/begin'))).toBe(false)
  })

  it('creates CSS credentials before registering the exact wrapper at the current Pod gateway', async () => {
    const solid = solidCapability()
    const host = hostFromSolid(solid)
    const issued = { apiKey: 'sk-Y2xpZW50OnNlY3JldA==', resource: 'https://id.example/.account/credentials/one/' }
    host.capabilities.aiClientCredentials = {
      create: vi.fn(async () => issued), revoke: vi.fn(async () => undefined),
    }
    const record = { id: 'key-1', owner: WEB_ID, scopes: [], createdAt: '2026-09-10T00:00:00Z', kind: 'client-credentials', credentialResource: issued.resource }
    solid.session.fetch = vi.fn(async () => Response.json({ key: issued.apiKey, record }))
    const controller = createAiConnectionsController(host)
    const created = await controller.client!.createGatewayKey({ name: 'Work' })
    expect(host.capabilities.aiClientCredentials.create).toHaveBeenCalledWith({ name: 'Work', webId: WEB_ID })
    expect(solid.session.fetch).toHaveBeenCalledWith('https://pod.example/api/ai/gateway/keys', expect.objectContaining({
      body: JSON.stringify({ name: 'Work', apiKey: issued.apiKey, credentialResource: issued.resource }),
    }))
    expect(created.record.kind).toBe('client-credentials')
    expect(created.plaintext).toBe(issued.apiKey)
  })

  it('revokes newly issued CSS credentials when registration fails', async () => {
    const solid = solidCapability()
    solid.session.fetch = vi.fn(async () => Response.json({ error: 'save_failed' }, { status: 500 }))
    const host = hostFromSolid(solid)
    const issued = { apiKey: 'sk-Y2xpZW50OnNlY3JldA==', resource: 'https://id.example/.account/credentials/one/' }
    host.capabilities.aiClientCredentials = { create: vi.fn(async () => issued), revoke: vi.fn(async () => undefined) }
    const controller = createAiConnectionsController(host)
    await expect(controller.client!.createGatewayKey({ name: 'Work' })).rejects.toThrow()
    expect(host.capabilities.aiClientCredentials.revoke).toHaveBeenCalledWith({ ...issued, webId: WEB_ID })
  })

  it('keeps the Pod record when CSS credential revocation fails', async () => {
    const solid = solidCapability()
    const record = { id: 'key-1', owner: WEB_ID, scopes: [], createdAt: '2026-09-10T00:00:00Z', kind: 'client-credentials', credentialResource: 'https://id.example/.account/credentials/one/' }
    solid.session.fetch = vi.fn(async (url) => Response.json(String(url).endsWith('/reveal')
      ? { key: 'sk-Y2xpZW50OnNlY3JldA==' } : { data: [record] }))
    const host = hostFromSolid(solid)
    host.capabilities.aiClientCredentials = {
      create: vi.fn(), revoke: vi.fn(async () => { throw new Error('CSS unavailable') }),
    }
    const controller = createAiConnectionsController(host)
    await expect(controller.client!.deleteGatewayKey('key-1')).rejects.toThrow('CSS unavailable')
    expect(mockCalls(solid.session.fetch).some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('retries Pod cleanup after account revocation succeeds but Pod deletion fails', async () => {
    const solid = solidCapability()
    const record = { id: 'key-1', owner: WEB_ID, scopes: [], createdAt: '2026-09-10T00:00:00Z', kind: 'client-credentials', credentialResource: 'https://id.example/.account/credentials/one/' }
    let deletions = 0
    solid.session.fetch = vi.fn(async (url, init) => {
      if (init?.method === 'DELETE') {
        deletions += 1
        return deletions === 1 ? Response.json({ error: 'Pod unavailable' }, { status: 500 }) : new Response(null, { status: 204 })
      }
      return Response.json(String(url).endsWith('/reveal') ? { key: 'sk-Y2xpZW50OnNlY3JldA==' } : { data: [record] })
    })
    const host = hostFromSolid(solid)
    host.capabilities.aiClientCredentials = { create: vi.fn(), revoke: vi.fn(async () => undefined) }
    const controller = createAiConnectionsController(host)
    await expect(controller.client!.deleteGatewayKey('key-1')).rejects.toThrow()
    await expect(controller.client!.deleteGatewayKey('key-1')).resolves.toBeUndefined()
    expect(deletions).toBe(2)
    expect(host.capabilities.aiClientCredentials.revoke).toHaveBeenCalledTimes(2)
    expect(host.capabilities.aiClientCredentials.revoke).toHaveBeenLastCalledWith({
      apiKey: 'sk-Y2xpZW50OnNlY3JldA==', resource: record.credentialResource, webId: WEB_ID,
    })
  })

  it('keeps the real catalog and reloads the saved OAuth account after browser login', async () => {
    const product: AiProviderSummary = {
      id: 'openai', name: 'OpenAI', status: 'available',
      offerings: [{
        id: 'official-subscription', label: 'Subscription', authModes: ['oauth', 'deviceCode', 'local'],
        authorizationMethods: [
          { id: 'browser-oauth', authMode: 'oauth', connectMode: 'authorizationCodeOAuth', label: '浏览器登录', lifecycle: 'active' },
          { id: 'device-code', authMode: 'deviceCode', connectMode: 'deviceCodeOAuth', label: '设备码登录', lifecycle: 'active' },
          { id: 'local-session-import', authMode: 'local', label: '已有登录态', lifecycle: 'active' },
        ],
      }],
      credentials: [{ id: 'existing', offeringId: 'official-subscription', authMode: 'oauth', enabled: true, priority: 10, health: 'healthy', version: 1 }],
      selectedModels: [{ id: 'retained-model', provider: 'openai', displayName: 'Retained model' }],
    }
    let saved = false
    const listProviders = vi.fn(async () => [{
      ...product,
      credentials: saved ? [...product.credentials, { ...product.credentials[0]!, id: 'browser-new', label: 'Browser account', priority: 20 }] : product.credentials,
    }])
    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/connect/begin')) return Response.json({
        provider: 'openai', mode: 'authorizationCodeOAuth', status: 'pending',
        attemptId: 'browser-attempt', state: 'state', signature: 'signature', intervalSeconds: 1,
        offeringId: 'official-subscription', authorizationMethodId: 'browser-oauth', authorizationUrl: 'https://provider.example/authorize',
      })
      if (url.endsWith('/connect/poll')) return Response.json({
        provider: 'openai', mode: 'authorizationCodeOAuth', status: 'completed',
        oauthCredential: { accessToken: 'new-token', refreshToken: 'new-refresh-token', authorizationMethodId: 'browser-oauth' },
      })
      return Response.json({ data: [] })
    }) as typeof fetch
    const host = hostFromSolid(solidCapability({ session: {
      fetch: sessionFetch,
      getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
      subscribe: () => () => undefined,
    } }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders,
      listModels: vi.fn(async () => product.selectedModels),
      saveOAuthCredential: vi.fn(async () => { saved = true; return { id: 'browser-new' } }),
    }
    const controller = createAiConnectionsController(host)
    await controller.loadProviders()
    const loaded = controller.providerSummaries.openai
    for (const state of ['loading', 'connected', 'attention', 'configured', 'unconfigured'] as const) {
      controller.setProviderState('openai', state)
      expect(controller.providerSummaries.openai).toBe(loaded)
    }
    controller.selectProvider('openai')
    render(<AiConnectionsMain controller={controller} />)
    expect(screen.getByRole('button', { name: '设备码登录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已有登录态' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '浏览器登录' }))
    expect(await screen.findByRole('dialog', { name: '连接账号' })).toBeTruthy()
    await waitFor(() => expect(saved).toBe(true), { timeout: 3000 })
    await waitFor(() => expect(screen.getByRole('button', { name: '测试连接 Browser account' })).toBeTruthy())
    expect(screen.getByRole('button', { name: '浏览器登录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '设备码登录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '已有登录态' })).toBeTruthy()
    expect(controller.providerSummaries.openai?.selectedModels).toEqual(product.selectedModels)
    expect(controller.providerSummaries.openai?.credentials[0]?.id).toBe('existing')
    expect(listProviders.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

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

    expect(controller.client).toBeNull()

    await controller.loadProviders()
    expect(sessionFetch).not.toHaveBeenCalled()
  })

  it('creates the API client from host.solid session fetch and ready Pod URL', async () => {
    const solid = solidCapability()

    const controller = createAiConnectionsController(hostFromSolid(solid))

    expect(controller.client?.webId).toBe(WEB_ID)
    expect(controller.client?.apiBase).toBe('https://pod.example')

    await controller.client?.listModels()

    await waitFor(() => {
      expect(solid.session.fetch).toHaveBeenCalledWith(
        'https://pod.example/v1/models',
        expect.objectContaining({ method: 'GET' }),
      )
    })
  })


  it('merges server authorization methods and endpoints into Pod-owned provider summaries', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/ai/connections/authorization-methods')) {
        return Response.json({ data: [{
          provider: 'kimi',
          offeringId: 'subscription-key',
          endpoints: [{ protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding' }],
          authorizationMethods: [
            { id: 'api-key', authMode: 'apiKey', connectMode: 'browserAssistedApiKey', label: 'API Key', lifecycle: 'active' },
            { id: 'device-code', authMode: 'deviceCode', connectMode: 'deviceCodeOAuth', label: '浏览器登录', lifecycle: 'active' },
            { id: 'local-session-import', authMode: 'local', label: '已有登录态', lifecycle: 'active' },
          ],
        }] })
      }
      throw new Error(`Unexpected interactive API request: ${String(input)}`)
    }) as unknown as typeof fetch
    const listProviders = vi.fn(async () => [{
      id: 'kimi',
      name: 'Kimi',
      status: 'unconfigured',
      offerings: [{ id: 'subscription-key', label: 'Token 套餐', authModes: ['apiKey'] }],
      credentials: [],
      selectedModels: [],
    }])
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = { listProviders }
    const controller = createAiConnectionsController(host)

    await controller.loadProviders()

    expect(controller.providerSummaries.kimi?.offerings[0]).toMatchObject({
      id: 'subscription-key',
      endpoints: [{ protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding' }],
      authorizationMethods: [
        expect.objectContaining({ id: 'api-key' }),
        expect.objectContaining({ id: 'device-code' }),
        expect.objectContaining({ id: 'local-session-import' }),
      ],
    })
  })

  it('loads interactive Provider state from the host Pod store without service delegation', async () => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/ai/connections/authorization-methods')) {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
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
    expect(sessionFetch).toHaveBeenCalledWith(
      'https://pod.example/api/ai/connections/authorization-methods',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it.each([['openai', 'official-subscription'], ['kimi', 'subscription-key']])('imports %s sessions through the host operation client', async (provider, offeringId) => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://pod.example/api/ai/providers/${provider}/credentials/local`)
      expect(init).toMatchObject({ method: 'POST' })
      return Response.json({
        credential: {
          id: 'credentials.ttl#openai-subscription',
          provider,
          offeringId,
          authMode: 'deviceCode',
          label: 'OpenAI Subscription',
          enabled: true,
          priority: 10,
          health: 'healthy',
          version: 1,
        },
      })
    }) as unknown as typeof fetch
    const createLocalCredential = vi.fn(async () => ({ id: 'must-not-be-created' }))
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => []),
      createLocalCredential,
    }
    const controller = createAiConnectionsController(host)

    await expect(controller.client!.createLocalCredential(provider, {
      authorizationMethodId: 'local-session-import',
      offeringId,
      label: 'OpenAI Subscription',
      priority: 10,
    })).resolves.toMatchObject({
      id: 'credentials.ttl#openai-subscription',
      authMode: 'deviceCode',
    })
    expect(createLocalCredential).not.toHaveBeenCalled()
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
            offeringId: 'subscription-key',
            accountId: 'moonshot-account-1',
            accountLabel: 'alice@kimi.example',
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
      offeringId: 'subscription-key',
      accountId: 'moonshot-account-1',
      accountLabel: 'alice@kimi.example',
    }))
    expect(result).toMatchObject({
      status: 'completed',
      credentialId: 'credentials.ttl#kimi-oauth-1',
    })
    expect(result).not.toHaveProperty('oauthCredential')
  })

  it.each([undefined, 'browser-oauth'])('refreshes OAuth from the Pod using method %s and current version', async (authorizationMethodId) => {
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/kimi\/connect\/refresh$/u)
      expect(JSON.parse(String(init?.body))).toEqual({
        credentialId: 'credentials.ttl#kimi-oauth-1',
        refreshToken: 'current-refresh-token',
        expectedVersion: 3,
        ...(authorizationMethodId ? { mode: 'authorizationCodeOAuth' } : {}),
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
        authorizationMethodId,
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

  it.each(['oauth', 'deviceCode'] as const)(
    'sends OpenAI local-imported subscription quota through caller-owned OAuth secret for %s credentials',
    async (credentialAuthMode) => {
      const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toMatch(/\/openai\/quota\/refresh$/u)
        expect(JSON.parse(String(init?.body))).toEqual({
          credentialId: 'credentials.ttl#openai-subscription',
          credentialIri: 'credentials.ttl#openai-subscription',
          authMode: 'deviceCodeOAuth',
          offeringId: 'official-subscription',
          secret: { type: 'oauth', accessToken: 'openai-transient-access-token' },
        })
        return Response.json({
          credential: 'credentials.ttl#openai-subscription',
          status: 'available',
          windows: [{ name: 'five-hour', remaining: 75 }],
          observedAt: '2026-08-09T08:00:00.000Z',
          expiresAt: '2026-08-09T08:05:00.000Z',
          source: 'openai:chatgpt-wham',
        })
      }) as unknown as typeof fetch
      const readCredentialSecret = vi.fn(async () => ({
        type: 'deviceCodeOAuth',
        accessToken: 'openai-transient-access-token',
        refreshToken: 'openai-refresh-token',
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
          id: 'openai',
          credentials: [{
            id: 'credentials.ttl#openai-subscription',
            offeringId: 'official-subscription',
            authMode: credentialAuthMode,
            enabled: true,
            priority: 1,
          }],
        }]),
        readCredentialSecret,
      }
      const controller = createAiConnectionsController(host)

      await expect(controller.client!.quota('openai', true, {
        offeringId: 'official-subscription',
      })).resolves.toMatchObject({
        status: 'available',
        source: 'openai:chatgpt-wham',
        windows: [{ remaining: 75 }],
      })
      expect(readCredentialSecret).toHaveBeenCalledWith('openai', 'credentials.ttl#openai-subscription')
    },
  )

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
    const modelRefreshBodies: unknown[] = []
    const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body))
      if (/\/bailian\/quota\/refresh$/u.test(url)) {
        requestBodies.push(body)
        return Response.json({
          credential: (body as { credentialId: string }).credentialId,
          status: 'available',
          windows: [{ name: 'tokens.remaining', remaining: 1000 }],
          observedAt: '2026-08-09T00:00:00.000Z',
          expiresAt: '2026-08-09T01:00:00.000Z',
          source: 'bailian:quota',
        })
      }
      if (/\/bailian\/models\/refresh$/u.test(url)) {
        modelRefreshBodies.push(body)
        return Response.json({
          provider: 'bailian',
          credential: (body as { credentialId: string }).credentialId,
          models: [{ id: 'qwen-max', provider: 'bailian' }],
          observedAt: '2026-08-09T00:00:00.000Z',
          source: 'bailian:models',
        })
      }
      throw new Error(`Unexpected request: ${url}`)
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
            proxyUrl: 'https://proxy.example:8443',
          },
          {
            id: 'credentials.ttl#token-enabled',
            offeringId: 'token-plan',
            authMode: 'apiKey',
            enabled: true,
            priority: 3,
            baseUrl: 'https://token-plan-backup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
            proxyUrl: 'https://proxy.example:8443',
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
    await controller.client!.discoverModels('bailian', {
      offeringId: 'token-plan',
      credentialId: 'credentials.ttl#token-enabled',
    })
    await controller.client!.testProviderCredential('bailian', {
      credentialId: 'credentials.ttl#token-enabled',
    })

    expect(readCredentialSecret).toHaveBeenNthCalledWith(1, 'bailian', 'credentials.ttl#token-disabled')
    expect(readCredentialSecret).toHaveBeenNthCalledWith(2, 'bailian', 'credentials.ttl#token-enabled')
    expect(readCredentialSecret).toHaveBeenNthCalledWith(3, 'bailian', 'credentials.ttl#token-enabled')
    expect(readCredentialSecret).toHaveBeenNthCalledWith(4, 'bailian', 'credentials.ttl#token-enabled')
    expect(requestBodies).toEqual([
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#token-disabled',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        proxyUrl: 'https://proxy.example:8443',
        secret: { type: 'apiKey', apiKey: 'credentials.ttl#token-disabled-secret' },
      }),
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#token-enabled',
        baseUrl: 'https://token-plan-backup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        proxyUrl: 'https://proxy.example:8443',
        secret: { type: 'apiKey', apiKey: 'credentials.ttl#token-enabled-secret' },
      }),
    ])
    expect(modelRefreshBodies).toEqual([
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#token-enabled',
        baseUrl: 'https://token-plan-backup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        proxyUrl: 'https://proxy.example:8443',
        secret: { type: 'apiKey', apiKey: 'credentials.ttl#token-enabled-secret' },
      }),
      expect.objectContaining({
        offeringId: 'token-plan',
        credentialId: 'credentials.ttl#token-enabled',
        baseUrl: 'https://token-plan-backup.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        proxyUrl: 'https://proxy.example:8443',
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

  it.each([
    { failed: false, title: 'marks an unverified credential healthy after model discovery succeeds' },
    { failed: true, title: 'does not mark a credential healthy when model discovery fails' },
  ])('$title', async ({ failed }) => {
    const host = hostFromSolid(solidCapability({ session: {
      fetch: vi.fn(async () => failed
        ? Response.json({ error: 'provider_models_fetch_failed' }, { status: 502 })
        : Response.json({ provider: 'openai', models: [{ id: 'selected-model' }] })) as typeof fetch,
      getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
      subscribe: () => () => undefined,
    } }))
    const markCredentialHealth = vi.fn(async () => undefined)
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{ id: 'openai', credentials: [{
        id: 'unverified-key', offeringId: 'api-platform', authMode: 'apiKey',
        enabled: true, health: 'unknown', priority: 10, version: 3,
      }] }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient' })),
      markCredentialHealth,
    }
    const discovery = createAiConnectionsController(host).client!.discoverModels('openai')
    if (failed) {
      await expect(discovery).rejects.toBeInstanceOf(Error)
      expect(markCredentialHealth).not.toHaveBeenCalled()
    } else {
      await discovery
      expect(markCredentialHealth).toHaveBeenCalledTimes(1)
      expect(markCredentialHealth).toHaveBeenCalledWith('openai', 'unverified-key', 'healthy', 3)
    }
  })

  it('does not retry provider discovery when persisting credential health fails', async () => {
    const sessionFetch = vi.fn(async () => Response.json({ provider: 'openai', models: [{ id: 'selected-model' }] }))
    const host = hostFromSolid(solidCapability({ session: {
      fetch: sessionFetch as typeof fetch,
      getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
      subscribe: () => () => undefined,
    } }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{ id: 'openai', credentials: ['primary', 'backup'].map((id, index) => ({
        id, offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: index, version: 1,
      })) }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient' })),
      markCredentialHealth: vi.fn(async () => { throw new Error('Pod health write failed') }),
    }
    await expect(createAiConnectionsController(host).client!.discoverModels('openai')).rejects.toBeInstanceOf(Error)
    expect(sessionFetch).toHaveBeenCalledTimes(1)
  })

  it('writes the shared Pod model catalog once for multiple endpoint credentials', async () => {
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json({
          provider: 'openai', credential: JSON.parse(String(init?.body)).credentialId,
          models: [{ id: 'example-model' }], observedAt: '2026-09-08T08:00:00.000Z',
        })) as unknown as typeof fetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    let writesInProgress = 0
    const saved: string[] = []
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'openai', credentials: ['imported', 'browser'].map((id) => ({
          id: `credentials.ttl#${id}`, offeringId: 'official-subscription',
          authMode: 'oauth', enabled: true, priority: 1, baseUrl: `https://${id}.example/v1`,
        })),
      }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'oauth', accessToken: 'transient-secret' })),
      saveDiscoveredModels: vi.fn(async (_provider, credentialId) => {
        if (writesInProgress) throw new Error('shared catalog write conflict')
        writesInProgress++
        await Promise.resolve()
        saved.push(credentialId)
        writesInProgress--
      }),
    }
    const controller = createAiConnectionsController(host)
    await expect(controller.client!.discoverModels('openai')).resolves.toMatchObject({
      models: [{ id: 'example-model', offeringId: 'official-subscription' }],
    })
    expect(saved).toEqual(['credentials.ttl#imported'])
  })

  it.each([
    { requested: undefined, failed: [], expected: ['first'] },
    { requested: undefined, failed: ['first'], expected: ['first', 'second'] },
    { requested: 'second', failed: [], expected: ['second'] },
  ])('tries model credentials in priority order and stops after success: $expected', async ({ requested, failed, expected }) => {
    const attempted: string[] = []
    const host = hostFromSolid(solidCapability({ session: {
      fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { credentialId } = JSON.parse(String(init?.body))
        attempted.push(credentialId)
        if (failed.includes(credentialId)) return Response.json({ error: 'invalid_credential' }, { status: 401 })
        return Response.json({ provider: 'openai', credential: credentialId, models: [{ id: 'shared' }] })
      }) as typeof fetch,
      getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
      subscribe: () => () => undefined,
    } }))
    const saveDiscoveredModels = vi.fn(async () => undefined)
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{ id: 'openai', credentials: [
        { id: 'disabled', enabled: false, priority: 0 },
        { id: 'second', enabled: true, priority: 20 },
        { id: 'first', enabled: true, priority: 10 },
      ].map((credential) => ({ ...credential, offeringId: 'api-platform', authMode: 'apiKey', baseUrl: credential.id === 'first' ? 'https://api.example/v1/' : 'https://api.example/v1' })) }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient' })),
      saveDiscoveredModels,
    }
    const result = await createAiConnectionsController(host).client!.discoverModels('openai', { credentialId: requested })
    expect(attempted).toEqual(expected)
    expect(result.models).toHaveLength(1)
    expect(saveDiscoveredModels).toHaveBeenCalledTimes(1)
    expect(saveDiscoveredModels).toHaveBeenCalledWith('openai', expected.at(-1), expect.any(Array))
  })

  it('retains identical model IDs for each custom endpoint and protocol scope', async () => {
    const host = hostFromSolid(solidCapability({ session: {
      fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { credentialId } = JSON.parse(String(init?.body))
        return Response.json({ provider: 'custom', credential: credentialId, models: [{ id: 'shared' }] })
      }) as typeof fetch,
      getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
      subscribe: () => () => undefined,
    } }))
    const saveDiscoveredModels = vi.fn(async () => undefined)
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{ id: 'custom', credentials: [
        { id: 'one', baseUrl: 'https://one.example/v1', compatibility: 'openai' },
        { id: 'same', baseUrl: 'https://one.example/v1/', compatibility: 'openai' },
        { id: 'two', baseUrl: 'https://two.example/v1', compatibility: 'openai' },
        { id: 'anthropic', baseUrl: 'https://one.example/v1', compatibility: 'anthropic' },
      ].map((credential, priority) => ({ ...credential, offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority })) }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient' })),
      saveDiscoveredModels,
    }
    const result = await createAiConnectionsController(host).client!.discoverModels('custom')
    expect(result.models.map((model) => model.credentialId)).toEqual(['one', 'same', 'two', 'anthropic'])
    expect(saveDiscoveredModels).toHaveBeenCalledTimes(4)
  })

  it.each([false, true])('saves the offering endpoint union only when discovery is complete (failed: %s)', async (failed) => {
    const host = hostFromSolid(solidCapability({ session: {
      fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const { credentialId } = JSON.parse(String(init?.body))
        if (failed && credentialId === 'two') return Response.json({ error: 'unavailable' }, { status: 503 })
        return Response.json({ provider: 'openai', credential: credentialId, models: [{ id: credentialId }] })
      }) as typeof fetch,
      getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
      subscribe: () => () => undefined,
    } }))
    const saveDiscoveredModels = vi.fn(async () => undefined)
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{ id: 'openai', credentials: ['one', 'two'].map((id) => ({
        id, baseUrl: `https://${id}.example/v1`, offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: 1,
      })) }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'apiKey', apiKey: 'transient' })),
      saveDiscoveredModels,
    }
    const result = await createAiConnectionsController(host).client!.discoverModels('openai')
    expect(result).toMatchObject({ complete: !failed })
    expect(result.models.map((model) => model.id)).toEqual(failed ? ['one'] : ['one', 'two'])
    expect(saveDiscoveredModels).toHaveBeenCalledTimes(failed ? 0 : 1)
    if (!failed) expect(saveDiscoveredModels).toHaveBeenCalledWith('openai', 'one', [
      expect.objectContaining({ id: 'one' }), expect.objectContaining({ id: 'two' }),
    ])
  })

  it('identifies Pod persistence failure after successful model discovery', async () => {
    const host = hostFromSolid(solidCapability({
      session: {
        fetch: vi.fn(async () => Response.json({
          provider: 'openai', credential: 'credentials.ttl#subscription',
          models: [{ id: 'example-model' }], observedAt: '2026-09-08T08:00:00.000Z',
        })) as unknown as typeof fetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      },
    }))
    host.capabilities.aiConnectionsPodStore = {
      listProviders: vi.fn(async () => [{
        id: 'openai', credentials: [{
          id: 'credentials.ttl#subscription', offeringId: 'official-subscription',
          authMode: 'oauth', enabled: true, priority: 1,
        }],
      }]),
      readCredentialSecret: vi.fn(async () => ({ type: 'oauth', accessToken: 'transient-secret' })),
      saveDiscoveredModels: vi.fn(async () => { throw new Error('private Pod response') }),
    }
    const controller = createAiConnectionsController(host)
    const error = await controller.client!.discoverModels('openai').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(normalizeAiConnectionsThrownError(error)).toBe('模型已获取，但保存到 Pod 失败。请重试同步模型。')
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

  it.each(['expired', 'soon', 'concurrent', 'failure', 'conflict', 'unknown', 'apiKey', 'revoked', 'revoked-twice', 'denied', 'secret-expired', 'invalid-expiry', 'incomplete'] as const)(
    'prepares model discovery OAuth credentials: %s', async (scenario) => {
      const credentialId = 'credentials.ttl#kimi-oauth'
      const events: string[] = []
      let credential = {
        id: credentialId, offeringId: 'official-subscription', authMode: scenario === 'apiKey' ? 'apiKey' : 'oauth',
        enabled: true, priority: 1, version: 3,
        expiresAt: ['unknown', 'revoked', 'revoked-twice', 'denied', 'secret-expired', 'invalid-expiry'].includes(scenario) ? undefined : new Date(Date.now() + (scenario === 'soon' ? 30_000 : -60_000)).toISOString(),
      }
      let secret = { accessToken: 'old-access-token', refreshToken: 'old-refresh-token', apiKey: 'api-key',
        expiresAt: scenario === 'secret-expired' ? new Date(Date.now() - 60_000).toISOString()
          : scenario === 'invalid-expiry' ? 'invalid' : undefined }
      const refreshGate = deferred<void>()
      const sessionFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        if (String(input).endsWith('/connect/refresh')) {
          events.push('refresh')
          expect(body).toMatchObject({ credentialId, refreshToken: 'old-refresh-token', expectedVersion: 3 })
          if (scenario === 'concurrent') await refreshGate.promise
          if (scenario === 'incomplete') return Response.json({ provider: 'kimi', status: 'pending' })
          if (scenario === 'failure') return Response.json({ error: 'refresh_failed' }, { status: 401 })
          return Response.json({ provider: 'kimi', mode: 'deviceCodeOAuth', status: 'completed',
            oauthCredential: { accessToken: 'new-access-token', refreshToken: 'new-refresh-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })
        }
        expect(String(input)).toMatch(/\/models\/refresh$/u)
        events.push('models')
        if (scenario === 'denied' || scenario === 'revoked-twice'
          || (scenario === 'revoked' && events.filter((event) => event === 'models').length === 1)) {
          return Response.json({ error: 'provider_models_fetch_failed',
            providerStatus: scenario === 'denied' ? 403 : 401,
          }, { status: 502 })
        }
        expect(body.secret).toEqual(scenario === 'apiKey'
          ? { type: 'apiKey', apiKey: 'api-key' }
          : { type: 'oauth', accessToken: scenario === 'unknown' || scenario === 'invalid-expiry' ? 'old-access-token' : 'new-access-token' })
        expect(body.secret).not.toHaveProperty('refreshToken')
        return Response.json({ provider: 'kimi', models: [{ id: 'kimi-for-coding' }] })
      }) as unknown as typeof fetch
      const updateOAuthCredential = vi.fn(async (provider, id, version, next) => {
        events.push('save')
        expect([provider, id, version]).toEqual(['kimi', credentialId, 3])
        if (scenario === 'conflict') throw new Error('credential_version_conflict')
        secret = { ...secret, ...next }
        credential = { ...credential, version: 4, expiresAt: next.expiresAt }
        return credential
      })
      const host = hostFromSolid(solidCapability({ session: {
        fetch: sessionFetch,
        getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
        subscribe: () => () => undefined,
      } }))
      const markCredentialHealth = vi.fn(async () => undefined)
      host.capabilities.aiConnectionsPodStore = {
        listProviders: vi.fn(async () => [{ id: 'kimi', credentials: [credential] }]),
        readCredentialSecret: vi.fn(async () => { events.push('read'); return secret }),
        updateOAuthCredential,
        markCredentialHealth,
      }
      const client = createAiConnectionsController(host).client!
      const first = client.discoverModels('kimi')
      if (scenario === 'concurrent') {
        const second = client.discoverModels('kimi')
        await waitFor(() => expect(events.filter((event) => event === 'refresh')).toHaveLength(1))
        refreshGate.resolve()
        await Promise.all([first, second])
        expect(events.filter((event) => event === 'refresh')).toHaveLength(1)
        expect(updateOAuthCredential).toHaveBeenCalledTimes(1)
        expect(markCredentialHealth).toHaveBeenCalledWith('kimi', credentialId, 'healthy', 4)
      } else if (scenario === 'failure' || scenario === 'incomplete' || scenario === 'conflict' || scenario === 'revoked-twice' || scenario === 'denied') {
        await expect(first).rejects.toThrow()
        expect(markCredentialHealth).not.toHaveBeenCalled()
        if (scenario === 'revoked-twice' || scenario === 'denied') {
          expect(events.filter((event) => event === 'models')).toHaveLength(scenario === 'denied' ? 1 : 2)
        } else expect(events).not.toContain('models')
        expect(events.filter((event) => event === 'refresh')).toHaveLength(scenario === 'denied' ? 0 : 1)
      } else {
        await expect(first).resolves.toMatchObject({ models: [{ id: 'kimi-for-coding' }] })
        expect(markCredentialHealth).toHaveBeenCalledWith('kimi', credentialId, 'healthy', credential.version)
        if (scenario === 'unknown' || scenario === 'invalid-expiry' || scenario === 'apiKey') {
          expect(updateOAuthCredential).not.toHaveBeenCalled()
          expect(events).not.toContain('refresh')
        } else {
          expect(events.slice(events.indexOf('refresh'))).toEqual(['refresh', 'save', 'read', 'models'])
        }
      }
    },
  )

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

  it('does not own login UI or Account routes when the host capability is unavailable', async () => {
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
    render(<AiConnectionsMain controller={controller} />)
    expect(screen.getByRole('alert').textContent).toContain('宿主需要先提供已登录的 WebID 和可用的 Pod')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(requireLogin).not.toHaveBeenCalled()
  })

  it('does not turn host-owned Pod opening into applet login presentation', () => {
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      pod: { status: 'opening' },
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByRole('alert').textContent).toContain('AI Connections 尚未就绪')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
  })

  it('does not turn browser session initialization into applet login presentation', () => {
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      session: {
        fetch: vi.fn() as unknown as typeof fetch,
        getSnapshot: () => ({ status: 'initializing' as const }),
        subscribe: () => () => undefined,
      },
      pod: { status: 'unavailable' },
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByRole('alert').textContent).toContain('AI Connections 尚未就绪')
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
  })

  it('leaves failed host-owned Pod recovery to the host boundary', () => {
    const requireLogin = vi.fn(async () => undefined)
    const controller = createAiConnectionsController(hostFromSolid(solidCapability({
      pod: {
        status: 'error',
        error: new Error('Pod 打开失败'),
      },
      requireLogin,
    })))

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByRole('alert').textContent).toContain('宿主需要先提供已登录的 WebID 和可用的 Pod')
    expect(screen.queryByRole('button', { name: '重新登录' })).toBeNull()
    expect(requireLogin).not.toHaveBeenCalled()
  })

  it('does not let stale provider loads roll back badge state after API key save or credential removal', async () => {
    const staleProviderLoad = deferred<Response>()
    const initialProviderLoad = deferred<Response>()
    initialProviderLoad.resolve(Response.json({ data: [{
      id: 'openai', name: 'OpenAI', status: 'unconfigured', offerings: [{ id: 'api-platform', kind: 'api-platform', authModes: ['apiKey'] }], credentials: [], selectedModels: [],
    }] }))
    const providerLoadQueue = [initialProviderLoad, staleProviderLoad]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/ai/providers')) {
        const load = providerLoadQueue.shift()
        if (!load) throw new Error('Unexpected provider load')
        return await load.promise
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
      if (url.endsWith('/api/ai/providers/openai/credentials/api-key')) {
        return Response.json({ credential: {
          id: 'credential-1', provider: 'openai', offeringId: 'api-platform', authMode: 'apiKey',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        } })
      }
      if (url.endsWith('/api/ai/gateway/providers/openai/models/refresh')) {
        return Response.json({ provider: 'openai', credential: 'credential-1', models: [] })
      }
      if (url.endsWith('/api/ai/providers/openai/credentials/credential-1')) {
        return Response.json({})
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
    render(<>{<AiConnectionsList controller={controller} />}<AiConnectionsMain controller={controller} /></>)

    const openAiButton = screen.getByRole('option', { name: 'OpenAI' })
    const describedBy = openAiButton.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toBe('未设置')
    await waitFor(() => {
      expect(
        mockCalls(fetcher).filter(([input]) => String(input).endsWith('/api/ai/providers')),
      ).toHaveLength(2)
    })

    fireEvent.click(openAiButton)
    fireEvent.click(screen.getByRole('button', { name: '新建 API Key 连接' }))
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

    fireEvent.click(screen.getByRole('button', { name: '删除 API Key' }))

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/api/ai/providers/openai/credentials/credential-1'),
      expect.objectContaining({ method: 'DELETE' }),
    ))
    await waitFor(() => {
      expect(document.getElementById(describedBy!)?.textContent).toBe('未设置')
    })
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

})
