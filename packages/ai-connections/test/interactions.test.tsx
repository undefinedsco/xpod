// @vitest-environment jsdom
import './setup-jsdom'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiConnectionsMain,
  AiConnectionsList,
  AiConnectionsHeader,
  AiCredentialPoolSection,
  AiConnectionsPanel,
  PROVIDERS,
  type AiConnectionsController,
  type AiConnectionsClient,
  type AiProviderSummary,
} from '../src'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import { createAiConnectionsController } from '../src/controller'
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = '<div id="root"></div>'
})

function client(overrides: Partial<AiConnectionsClient> = {}): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listGatewayKeys: vi.fn(async () => []),
    createGatewayKey: vi.fn(async (input) => ({
      plaintext: 'xpod-key-plaintext',
      record: {
        id: 'gateway-key-1',
        owner: WEB_ID,
        scopes: [],
        createdAt: '2026-08-25T00:00:00.000Z',
        name: input.name,
        maskedHint: '********aintext',
        plaintextAvailable: true,
        appliedClients: input.appliedClient ? [input.appliedClient] : [],
      },
    })),
    revealGatewayKey: vi.fn(async () => 'xpod-key-plaintext'),
    updateGatewayKey: vi.fn(),
    deleteGatewayKey: vi.fn(async () => undefined),
    beginConnect: vi.fn(async (provider, mode) => ({
      provider,
      mode,
      status: 'pending' as const,
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
      authorizationUrl: 'https://provider.example/keys',
    })),
    connectStatus: vi.fn(),
    completeApiKey: vi.fn(async (provider) => ({
      provider,
      mode: 'browserAssistedApiKey' as const,
      status: 'completed' as const,
      credentialId: 'credential-1',
    })),
    pollDevice: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    discoverModels: vi.fn(async (provider) => ({
      provider,
      credential: `${provider}-credential`,
      models: [{ id: `${provider}-model-1`, displayName: `${provider} Model 1` }],
      observedAt: '2026-08-06T00:00:00.000Z',
      source: `${provider}:/models`,
    })),
    saveProviderModel: vi.fn(async (_provider, model) => [model]),
    deleteProviderModel: vi.fn(async () => []),
    createApiKeyCredential: vi.fn(async (provider, input) => ({
      id: `${provider}-key-new`,
      provider,
      offeringId: input.offeringId ?? 'api-platform',
      authMode: 'apiKey',
      label: input.label,
      enabled: true,
      priority: input.priority ?? 10,
      health: 'healthy',
      maskedHint: 'sk-...new',
      baseUrl: input.baseUrl,
      version: 1,
    })),
    createLocalCredential: vi.fn(async (provider, input) => ({
      id: `${provider}-local-new`,
      provider,
      offeringId: input.offeringId ?? 'local',
      authMode: 'local',
      label: input.label,
      enabled: true,
      priority: input.priority ?? 10,
      health: 'healthy',
      baseUrl: input.baseUrl,
      version: 1,
    })),
    updateProviderCredential: vi.fn(async (provider, credentialId, patch) => ({
      id: credentialId,
      provider,
      offeringId: 'api-platform',
      authMode: 'apiKey',
      label: patch.label ?? (credentialId.includes('primary') ? 'Primary renamed' : 'Backup key'),
      enabled: patch.enabled ?? true,
      priority: patch.priority ?? 10,
      health: 'healthy',
      baseUrl: patch.baseUrl,
      version: patch.expectedVersion + 1,
    })),
    deleteProviderCredential: vi.fn(async (provider, credentialId) => ({
      id: credentialId,
      provider,
      offeringId: 'api-platform',
      authMode: 'apiKey',
      enabled: false,
      priority: 10,
      health: 'unknown',
      version: 2,
    })),
    testProviderCredential: vi.fn(async () => ({
      status: 'ok',
      checkedAt: '2026-08-08T00:00:00.000Z',
    })),
    quota: vi.fn(async (provider) => ({
      credential: `${provider}-credential`,
      status: 'unsupported' as const,
      windows: [],
      observedAt: '2026-07-24T00:00:00.000Z',
      expiresAt: '2026-07-24T01:00:00.000Z',
      source: `${provider}:console-only`,
    })),
    saveModelSelection: vi.fn(async () => undefined),
    ...overrides,
  }
}

function openAiApiPlatformProduct(): AiProviderSummary {
  return {
    id: 'openai',
    name: 'OpenAI',
    status: 'available',
    offerings: [{ id: 'api-platform', label: 'API Key', kind: 'api-platform', authModes: ['apiKey'] }],
    credentials: [{
      id: 'openai-api-key',
      offeringId: 'api-platform',
      authMode: 'apiKey',
      enabled: true,
      priority: 10,
      health: 'healthy',
      version: 1,
    }],
    selectedModels: [],
  }
}

function openCreateConnection(offeringId?: string) {
  if (!screen.queryByRole('dialog', { name: '新建连接' })) {
    fireEvent.click(screen.getByRole('button', { name: '新建 API Key 连接' }))
  }
  const dialog = screen.getByRole('dialog', { name: '新建连接' })
  if (offeringId) expect(dialog.querySelector(`[data-create-offering="${offeringId}"]`)).toBeTruthy()
  return dialog
}

describe('AI Connection settings', () => {
  it('waits for the provider product before opening the API key creation dialog', () => {
    const props = {
      definition: PROVIDERS.find((provider) => provider.id === 'openai')!,
      apiKey: '', busy: false,
      onApiKeyChange: vi.fn(), onBeginApiKey: vi.fn(), onBeginBrowser: vi.fn(),
      onSaveApiKey: vi.fn(), onDisconnect: vi.fn(),
      onCreateApiKeyCredential: vi.fn(async () => undefined),
    }
    const view = render(<AiCredentialPoolSection {...props} status="pending" />)

    const create = screen.getByRole('button', { name: '新建 API Key 连接' })
    expect(create).toHaveProperty('disabled', true)
    fireEvent.click(create)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onBeginApiKey).not.toHaveBeenCalled()

    view.rerender(<AiCredentialPoolSection {...props} status="disconnected" product={{
      id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
      offerings: [{ id: 'api-platform', kind: 'api-platform', authModes: ['apiKey'] }],
    }} />)
    expect(screen.getByRole('button', { name: '新建 API Key 连接' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: '新建 API Key 连接' }))
    const dialog = screen.getByRole('dialog', { name: '新建连接' })
    expect(within(dialog).queryByRole('combobox', { name: '接入方式' })).toBeNull()
    expect(dialog.querySelector('[data-create-offering="api-platform"]')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '高级设置' }))
    expect(within(dialog).getByLabelText('OpenAI Base URL 输入')).toBeTruthy()
    expect(props.onBeginApiKey).not.toHaveBeenCalled()
  })

  it.each(createDefaultProviderRegistry().listProducts().flatMap((product) =>
    product.offerings.map((offering) => ({ providerId: product.id, offeringId: offering.id, offering }))))(
    'dispatches quota and displays its result for configured $providerId / $offeringId',
    async ({ providerId, offeringId, offering }) => {
      const definition = PROVIDERS.find((provider) => provider.id === providerId)!
      const credentialId = `${providerId}-${offeringId}-credential`
      const product: AiProviderSummary = {
        id: definition.id, name: definition.name, status: 'available', selectedModels: [],
        // An available desktop importer/connector can activate an otherwise unavailable subscription.
        offerings: [{ ...offering, lifecycle: 'active' }],
        credentials: [{
          id: credentialId, offeringId,
          authMode: offering.kind === 'oauth-subscription' ? 'oauth' : offering.authModes.includes('local') ? 'local' : 'apiKey',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        }],
      }
      const current = client()
      render(<AiConnectionsPanel client={current} selectedProvider={definition.id} providerProducts={{ [definition.id]: product }} />)

      fireEvent.click(screen.getByRole('button', { name: /^刷新 / }))

      await waitFor(() => expect(current.quota).toHaveBeenCalledWith(definition.id, true, {
        offeringId, credentialId, credentialIri: credentialId,
      }))
      expect(await screen.findByText('官方额度接口不支持')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /额度详情$/ }))
      expect(screen.getByText(`来源：${definition.id}:console-only`)).toBeTruthy()
    },
  )

  it('renders a deterministic unavailable state for an authenticated WebID-only host', () => {
    const host = createMockWebExtensionHost({
      solid: {
        session: {
          fetch: vi.fn(async () => new Response('{}')) as unknown as typeof fetch,
          getSnapshot: () => ({ status: 'authenticated' as const, webId: WEB_ID }),
          subscribe: () => () => undefined,
        },
        requireLogin: vi.fn(async () => undefined),
      },
    })
    const controller = createAiConnectionsController(host)

    render(<AiConnectionsMain controller={controller} />)

    expect(screen.getByRole('alert').textContent).toContain('宿主需要先提供已登录的 WebID 和可用的 Pod')
    expect(screen.queryByRole('region', { name: /详情/u })).toBeNull()
  })

  it('uses the typed AI Connections failure copy for expired OAuth attempts', () => {
    const definition = PROVIDERS.find((candidate) => candidate.id === 'kimi')!
    const offering = {
      id: 'official-subscription',
      label: 'Kimi 账号',
      kind: 'official-subscription' as const,
      authModes: ['oauth' as const],
    }

    render(
      <AiCredentialPoolSection
        definition={definition}
        product={{
          id: 'kimi',
          name: 'Kimi',
          status: 'unconfigured',
          offerings: [offering],
          credentials: [],
          selectedModels: [],
        }}
        status="disconnected"
        attempt={{ mode: 'deviceCodeOAuth', provider: 'kimi', status: 'expired', message: 'Kimi 账号登录已过期' }}
        attemptOfferingId={offering.id}
        apiKey=""
        busy={false}
        error={{ offeringId: offering.id, message: 'Kimi 账号登录已过期', authorization: { mode: 'deviceCodeOAuth' } }}
        onApiKeyChange={() => undefined}
        onBeginApiKey={() => undefined}
        onBeginBrowser={() => undefined}
        onSaveApiKey={() => undefined}
        onDisconnect={() => undefined}
        onBeginOffering={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(screen.getByText('登录未完成')).toBeTruthy()
  })

  it.each(['completed', 'expired'] as const)('keeps ordinary offering errors separate from a previous %s OAuth attempt', (attemptStatus) => {
    const offering = { id: 'subscription', authModes: ['oauth' as const] }
    render(<AiCredentialPoolSection
      definition={PROVIDERS.find((candidate) => candidate.id === 'kimi')!}
      product={{ id: 'kimi', name: 'Kimi', status: 'available', offerings: [offering], credentials: [], selectedModels: [] }}
      status="connected" attempt={{ mode: 'deviceCodeOAuth', provider: 'kimi', status: attemptStatus }}
      attemptOfferingId={offering.id} apiKey="" busy={false}
      error={{ offeringId: offering.id, message: '凭据测试失败' }}
      onApiKeyChange={() => undefined} onBeginApiKey={() => undefined} onBeginBrowser={() => undefined}
      onSaveApiKey={() => undefined} onDisconnect={() => undefined} onBeginOffering={() => undefined}
    />)
    expect(screen.getByText('凭据测试失败')).toBeTruthy()
    expect(screen.queryByText('登录未完成')).toBeNull()
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy()
  })

  it('describes the current Pod protection accurately before a credential is added', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  />)

    await waitFor(() => expect(current.listModels).toHaveBeenCalled())

    fireEvent.click(screen.getByText('接入信息'))
    expect(screen.queryByText('Provider 凭证保存在当前 Pod，由 Pod 权限保护。')).toBeNull()
    expect(screen.queryByText(/加密保存在当前 Pod/)).toBeNull()
  })
  it('shows one selected Provider without repeating the Applet header or WebID hero', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  />)

    await waitFor(() => expect(current.listModels).toHaveBeenCalled())

    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI Connection' })).toBeNull()
    expect(screen.queryByText(WEB_ID)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Anthropic' })).toBeNull()
    expect(screen.queryByLabelText(/pod url/i)).toBeNull()
    expect(screen.queryByText(/local|cloud|deployment/i)).toBeNull()
  })

  it('presents browser auth as connected and masks the account label', async () => {
    const current = client({
      listProviders: vi.fn(async () => [{
        provider: 'kimi' as const,
        status: 'connected' as const,
        authMode: 'deviceCodeOAuth',
        accountLabel: 'alice@example.com',
        connect: {
          modes: ['deviceCodeOAuth' as const, 'browserAssistedApiKey' as const],
          configured: true,
        },
      }]),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        providerSummaries={{
          kimi: {
            provider: 'kimi',
            status: 'connected',
            authMode: 'deviceCodeOAuth',
            accountLabel: 'alice@example.com',
            connect: {
              modes: ['deviceCodeOAuth', 'browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    expect(await screen.findByText('a***e@example.com')).toBeTruthy()
    expect(screen.queryByText('alice@example.com')).toBeNull()
    expect(screen.getByText('已连接')).toBeTruthy()
    openCreateConnection()
    expect(screen.getByRole('dialog', { name: '新建连接' })).toBeTruthy()
  })

  it('presents an API-key credential as configured', async () => {
    const current = client({
      listProviders: vi.fn(async () => [{
        provider: 'deepseek' as const,
        status: 'connected' as const,
        authMode: 'browserAssistedApiKey',
        connect: {
          modes: ['browserAssistedApiKey' as const],
          configured: true,
        },
      }]),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            baseUrl: 'https://proxy.example/v1',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    expect(await screen.findByText('已配置')).toBeTruthy()
    openCreateConnection()
    await waitFor(() => expect(screen.getByLabelText('DeepSeek Base URL 输入')).toHaveProperty(
      'value',
      'https://proxy.example/v1',
    ))
  })

  it('renders every Provider offering as an independent credential list without tabs', async () => {
    render(
      <AiConnectionsPanel
        client={client()}
        selectedProvider="kimi"
        providerProducts={{
          kimi: {
            id: 'kimi',
            name: 'Kimi',
            status: 'available',
            offerings: [
              {
                id: 'official-subscription',
                label: 'Kimi 账号',
                authModes: ['oauth'],
              },
              {
                id: 'api-platform',
                label: 'API Key',
                authModes: ['apiKey'],
              },
            ],
            credentials: [{
              id: 'kimi-oauth-primary',
              offeringId: 'official-subscription',
              authMode: 'oauth',
              label: 'alice@example.com',
              enabled: true,
              priority: 10,
              health: 'healthy',
              version: 1,
            }],
            selectedModels: [],
          },
        }}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Kimi 账号' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'API 平台' })).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByText('a***e@example.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建 API Key 连接' })).toBeTruthy()
    expect(screen.queryByLabelText(/client.?id/i)).toBeNull()
  })

  it('keeps the selected offering fixed while its OAuth attempt is pending', async () => {
    const current = client({
      beginConnect: vi.fn(async () => ({
        mode: 'deviceCodeOAuth' as const,
        status: 'pending' as const,
        provider: 'kimi' as const,
        attemptId: 'attempt-one',
        userCode: 'ABCD-EFGH',
      })),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        openExternal={vi.fn(async () => undefined)}
        providerProducts={{
          kimi: {
            id: 'kimi', name: 'Kimi', status: 'unconfigured', credentials: [], selectedModels: [],
            offerings: [
              { id: 'consumer-subscription', label: 'Consumer Subscription', kind: 'oauth-subscription', authModes: ['oauth'] },
              { id: 'team-subscription', label: 'Team Subscription', kind: 'oauth-subscription', authModes: ['oauth'] },
            ],
          },
        }}
      />,
    )

    const shortcuts = screen.getByRole('group', { name: 'Consumer Subscription快捷接入' })
    fireEvent.click(within(shortcuts).getByRole('button', { name: '登录' }))
    const consumer = await screen.findByRole('group', { name: 'Consumer Subscription接入操作' })

    expect(await within(consumer).findByText('正在连接')).toBeTruthy()
    const team = screen.getByRole('group', { name: 'Team Subscription快捷接入', hidden: true })
    expect(within(team).getByRole('button', { name: '登录', hidden: true })).toHaveProperty('disabled', true)
  })

  it('shows operational metadata and management links for each offering', async () => {
    render(<AiConnectionsPanel client={client()} selectedProvider="openai"  providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'api-platform', productLabel: 'OpenAI Platform', kind: 'api-platform',
          authModes: ['apiKey'],
          endpoints: [
            { protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
            { protocol: 'chatCompletions', baseUrl: 'https://api.openai.com/v1' },
          ],
          consoleUrl: 'https://platform.openai.com/api-keys',
          subscriptionUrl: 'https://platform.openai.com/billing',
          quota: { strategy: 'providerApi', url: 'https://platform.openai.com/usage' },
          usagePolicyUrl: 'https://openai.com/policies/usage-policies/',
        }],
      },
    }} />)

    fireEvent.click(screen.getByText('接入信息'))
    expect(await screen.findByRole('heading', { name: 'API 平台' })).toBeTruthy()
    expect(screen.queryByText('OpenAI Platform')).toBeNull()
    expect(screen.queryByText(/Responses.*Chat Completions/)).toBeNull()
    expect(screen.queryByText('https://api.openai.com/v1')).toBeNull()
    expect(screen.getByRole('link', { name: '控制台' })).toHaveProperty('href', 'https://platform.openai.com/api-keys')
    expect(screen.getByRole('link', { name: '订阅与账单' })).toHaveProperty('href', 'https://platform.openai.com/billing')
    expect(screen.getByRole('link', { name: '额度与用量' })).toHaveProperty('href', 'https://platform.openai.com/usage')
    expect(screen.getByRole('link', { name: '使用政策' })).toHaveProperty('href', 'https://openai.com/policies/usage-policies/')
  })

  it('renders unavailable offerings without login or API-key actions', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'official-subscription',
          label: 'OpenAI Subscription',
          kind: 'oauth-subscription',
          lifecycle: 'unavailable',
          authModes: ['local'],
        }],
      },
    }} />)

    expect(await screen.findByRole('heading', { name: '账号订阅' })).toBeTruthy()
    expect(screen.getByText('暂不可用：账号订阅需在 Xpod 桌面版中导入本机客户端（如 Codex CLI）的登录态，浏览器中无法完成。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加 API Key' })).toBeNull()
    expect(screen.queryByRole('button', { name: /配置 API Key/ })).toBeNull()
    expect(current.beginConnect).not.toHaveBeenCalled()
    expect(current.createApiKeyCredential).not.toHaveBeenCalled()
  })

  it('connects Ollama locally without asking for an API key and syncs models', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="ollama" providerProducts={{
      ollama: {
        id: 'ollama', name: 'Ollama', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'local', label: '本地 Ollama', kind: 'local', authModes: ['local'],
          endpoints: [{ protocol: 'chatCompletions', baseUrl: 'http://localhost:11434/v1' }],
        }],
      },
    }} />)

    expect(screen.queryByRole('button', { name: /API Key/ })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '本地服务' }))
    await waitFor(() => expect(current.createLocalCredential).toHaveBeenCalledWith('ollama', {
      authorizationMethodId: 'local-service',
      offeringId: 'local',
      label: '本地 Ollama',
      baseUrl: 'http://localhost:11434/v1',
      priority: 10,
    }))
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('ollama', expect.objectContaining({
      offeringId: 'local',
      credentialId: 'ollama-local-new',
    })))
  })


  it('renders every authorization method for one offering without duplicating the quota card', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="kimi" providerProducts={{
      kimi: {
        id: 'kimi', name: 'Kimi', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'subscription-key',
          label: 'Token 套餐',
          productLabel: 'Kimi Coding',
          kind: 'token-plan',
          lifecycle: 'active',
          authModes: ['apiKey', 'deviceCode', 'local'],
          authorizationMethods: [
            { id: 'api-key', authMode: 'apiKey', connectMode: 'browserAssistedApiKey', label: 'API Key', lifecycle: 'active' },
            { id: 'device-code', authMode: 'deviceCode', connectMode: 'deviceCodeOAuth', label: '浏览器登录', lifecycle: 'active' },
            { id: 'local-session-import', authMode: 'local', label: '已有登录态', lifecycle: 'active' },
          ],
          quota: { strategy: 'subscription', url: 'https://kimi.example/usage' },
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '已有登录态' }))
    await waitFor(() => expect(current.createLocalCredential).toHaveBeenCalledWith('kimi', {
      authorizationMethodId: 'local-session-import',
      offeringId: 'subscription-key',
      label: 'Token 套餐',
      priority: 10,
    }))

    openCreateConnection()
    expect(screen.getByLabelText('Kimi API Key 输入')).toBeTruthy()
    expect(screen.queryByText('剩余额度')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(screen.getByRole('button', { name: '浏览器登录' }))
    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledWith('kimi', 'deviceCodeOAuth', {
      offeringId: 'subscription-key',
      authorizationMethodId: 'device-code',
    }))
  })

  it('cancels an active device-code attempt from the offering card', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'pending' as const,
        attemptId: 'attempt-1',
        state: 'state-1',
        signature: 'signature-1',
        authorizationUrl: 'https://provider.example/device',
        intervalSeconds: 30,
      })),
      cancelConnect: vi.fn(async (provider, attempt) => ({
        provider,
        mode: 'deviceCodeOAuth' as const,
        status: 'cancelled' as const,
        attemptId: attempt.attemptId,
        state: attempt.state,
        signature: attempt.signature,
      })),
      pollDevice: vi.fn(async () => {
        throw new Error('poll should have been cancelled')
      }),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai" providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'official-subscription',
          label: 'OpenAI Subscription',
          lifecycle: 'active',
          authModes: ['deviceCode'],
          authorizationMethods: [
            { id: 'device-code', authMode: 'deviceCode', connectMode: 'deviceCodeOAuth', label: '浏览器登录', lifecycle: 'active' },
          ],
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '浏览器登录' }))
    expect(await screen.findByText('正在连接')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消连接' }))

    await waitFor(() => expect(current.cancelConnect).toHaveBeenCalledWith('openai', {
      mode: 'deviceCodeOAuth',
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
    }))
    expect(current.pollDevice).not.toHaveBeenCalled()
  })

  it.each(['deviceCodeOAuth', 'authorizationCodeOAuth'] as const)('preserves %s signed attempt fields across repeated polls and cancellation', async (mode) => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'pending' as const,
        attemptId: 'attempt-1',
        state: 'state-1',
        signature: 'signature-1',
        authorizationUrl: 'https://provider.example/device',
        intervalSeconds: 1,
        offeringId: 'official-subscription',
      })),
      cancelConnect: vi.fn(async (provider, attempt) => ({
        provider,
        mode,
        status: 'cancelled' as const,
        attemptId: attempt.attemptId,
        state: attempt.state,
        signature: attempt.signature,
      })),
      pollDevice: vi.fn(async (provider) => ({
        provider, mode, status: 'authorization_pending' as const,
        attemptId: 'attempt-1', intervalSeconds: 1,
      })),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai" providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'official-subscription',
          label: 'OpenAI Subscription',
          lifecycle: 'active',
          authModes: ['deviceCode'],
          authorizationMethods: [
            { id: mode === 'authorizationCodeOAuth' ? 'browser-oauth' : 'device-code', authMode: 'oauth', connectMode: mode, label: '浏览器登录', lifecycle: 'active' },
          ],
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '浏览器登录' }))
    expect(await screen.findByText('正在连接')).toBeTruthy()
    if (mode === 'authorizationCodeOAuth') {
      expect(screen.getByText('等待网页授权，请在打开的页面完成登录。')).toBeTruthy()
      expect(screen.queryByText(/验证码：/)).toBeNull()
    }
    await waitFor(() => expect(current.pollDevice).toHaveBeenCalledTimes(2), { timeout: 3500 })
    expect(current.pollDevice).toHaveBeenLastCalledWith('openai', expect.objectContaining({
      state: 'state-1', signature: 'signature-1', offeringId: 'official-subscription',
    }))
    fireEvent.click(screen.getByRole('button', { name: '取消连接' }))

    await waitFor(() => expect(current.cancelConnect).toHaveBeenCalledWith('openai', {
      mode,
      attemptId: 'attempt-1',
      state: 'state-1',
      signature: 'signature-1',
      offeringId: 'official-subscription',
    }))
  })

  it('labels OpenAI Subscription honestly as a local-session import', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai" providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'official-subscription',
          label: 'OpenAI Subscription',
          productLabel: 'OpenAI',
          kind: 'oauth-subscription',
          lifecycle: 'active',
          authModes: ['local'],
          modelDiscovery: { strategy: 'unsupported', path: '/models', endpointProtocol: 'responses' },
        }],
      },
    }} />)

    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.queryByRole('button', { name: /API Key/ })).toBeNull()
    expect(screen.getByTitle('导入当前设备已有登录态，不会发起新的浏览器授权。')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '已有登录态' }))
    await waitFor(() => expect(current.createLocalCredential).toHaveBeenCalledWith('openai', {
      authorizationMethodId: 'local-session-import',
      offeringId: 'official-subscription',
      label: 'OpenAI Subscription',
      priority: 10,
    }))
  })

  it('keeps named OAuth accounts distinguishable while masking long email addresses', async () => {
    const current = client()
    render(<AiConnectionsPanel
      client={current}
      selectedProvider="openai"
      providerProducts={{
        openai: {
          id: 'openai', name: 'OpenAI', status: 'available', selectedModels: [],
          offerings: [{ id: 'official-subscription', label: 'OpenAI 账号', authModes: ['oauth'] }],
          credentials: [
            { id: 'astra', label: 'OpenAI astra' },
            { id: 'subscription', label: 'OpenAI subscription' },
            { id: 'email', label: 'alexander@example.com' },
          ].map((credential, index) => ({
            ...credential,
            offeringId: 'official-subscription',
            authMode: 'oauth' as const,
            enabled: true,
            priority: (index + 1) * 10,
            health: 'healthy' as const,
            version: 1,
          })),
        },
      }}
    />)

    expect(await screen.findByText('OpenAI astra')).toBeTruthy()
    expect(screen.getByText('OpenAI subscription')).toBeTruthy()
    expect(screen.getByText('ale***er@example.com')).toBeTruthy()
    expect(screen.queryByText('O***a')).toBeNull()
    expect(screen.queryByText('O***n')).toBeNull()
    expect(screen.queryByText('alexander@example.com')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /OpenAI astra.*移除/ }))
    await waitFor(() => expect(current.disconnect).toHaveBeenCalledWith('openai', 'astra'))
    expect(screen.getByText('OpenAI subscription')).toBeTruthy()
  })

  it('logs out the selected OAuth credential row without showing fake switch actions', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        providerProducts={{
          kimi: {
            id: 'kimi',
            name: 'Kimi',
            status: 'available',
            offerings: [{
              id: 'official-subscription',
              label: 'Kimi 账号',
              authModes: ['oauth'],
            }],
            credentials: [
              {
                id: 'kimi-oauth-primary',
                offeringId: 'official-subscription',
                authMode: 'oauth',
                label: 'alice@example.com',
                enabled: true,
                priority: 10,
                health: 'healthy',
                version: 1,
              },
              {
                id: 'kimi-oauth-backup',
                offeringId: 'official-subscription',
                authMode: 'oauth',
                label: 'bob@example.com',
                enabled: true,
                priority: 20,
                health: 'expired',
                version: 1,
              },
            ],
            selectedModels: [],
          },
        }}
      />,
    )

    expect(await screen.findByText('a***e@example.com')).toBeTruthy()
    expect(screen.getByText('b***b@example.com')).toBeTruthy()
    expect(screen.queryByText('切换')).toBeNull()
    expect(screen.queryByText('重新授权')).toBeNull()
    expect(screen.getByRole('button', { name: '添加账号' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '移除' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /a\*\*\*e@example\.com.*移除/ }))

    await waitFor(() => expect(current.disconnect).toHaveBeenCalledWith('kimi', 'kimi-oauth-primary'))
  })

  it('keeps subscription actions available when imported credentials cannot discover models', async () => {
    const current = client({
      discoverModels: vi.fn(async () => { throw new Error('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。') }),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="kimi" providerProducts={{ kimi: {
      id: 'kimi', name: 'Kimi', status: 'unconfigured', credentials: [], selectedModels: [],
      offerings: [{ id: 'subscription', label: 'Kimi 订阅', kind: 'oauth-subscription',
        authModes: ['oauth', 'local'], authorizationMethods: [
          { id: 'oauth', authMode: 'oauth', connectMode: 'deviceCodeOAuth', label: '浏览器登录', lifecycle: 'active' },
          { id: 'local-session-import', authMode: 'local', label: '重新读取订阅', lifecycle: 'active' },
        ] }],
    } }} />)

    fireEvent.click(screen.getByRole('button', { name: '重新读取订阅' }))
    expect(await screen.findByText('订阅已读取，模型获取失败：密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')).toBeTruthy()
    expect(screen.queryByText('登录未完成')).toBeNull()
    expect(within(screen.getByLabelText('凭据列表')).getByRole('button', { name: 'Kimi 订阅 移除' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '浏览器登录' })).toBeTruthy()
    const reread = screen.getByRole('button', { name: '重新读取订阅' }) as HTMLButtonElement
    expect(reread.disabled).toBe(false)
    fireEvent.click(reread)
    await waitFor(() => expect(current.createLocalCredential).toHaveBeenCalledTimes(2))
  })

  it('shows an authorization failure when starting OAuth throws before an attempt exists', async () => {
    const current = client({ beginConnect: vi.fn(async () => { throw new Error('授权启动失败') }) })
    render(<AiConnectionsPanel client={current} selectedProvider="kimi" providerProducts={{ kimi: {
      id: 'kimi', name: 'Kimi', status: 'unconfigured', credentials: [], selectedModels: [],
      offerings: [{ id: 'subscription', authModes: ['oauth'] }],
    } }} />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('登录未完成')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试登录' }))
    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledTimes(2))
  })

  it('does not classify a provider refresh failure after OAuth completion as login failure', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({ provider, mode, status: 'completed' as const })),
      listProviders: vi.fn(async () => { throw new Error('刷新失败') }),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="kimi" providerProducts={{ kimi: {
      id: 'kimi', name: 'Kimi', status: 'unconfigured', credentials: [], selectedModels: [],
      offerings: [{ id: 'subscription', authModes: ['oauth'] }],
    } }} />)
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(await screen.findByText('账号已连接，连接信息刷新失败：请求未完成。请确认 Xpod 正在运行且登录仍有效，然后重试。')).toBeTruthy()
    expect(screen.queryByText('登录未完成')).toBeNull()
    expect(await screen.findByRole('button', { name: '登录' })).toBeTruthy()
  })

  it('surfaces recoverable OAuth failures without leaking client configuration fields', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'expired' as const,
        message: 'Kimi 账号登录已过期',
      })),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        providerProducts={{
          kimi: {
            id: 'kimi',
            name: 'Kimi',
            status: 'unconfigured',
            offerings: [{
              id: 'official-subscription',
              label: 'Kimi 账号',
              authModes: ['oauth'],
            }],
            credentials: [],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('Kimi 账号登录已过期')).toBeTruthy()
    expect(screen.getByText('连接失败')).toBeTruthy()
    expect(screen.queryByLabelText(/client.?id/i)).toBeNull()
    expect(screen.queryByText('剩余额度')).toBeNull()
    expect(screen.queryByRole('button', { name: /^刷新 .*额度$/ })).toBeNull()
  })

  it('renders an unavailable OAuth deployment as an offering-scoped product state', async () => {
    const internalMessage = 'Requires an Xpod/Moonshot-issued device-code OAuth client id; do not reuse the official Kimi CLI client id.'
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'unsupported' as const,
        message: internalMessage,
      })),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        providerProducts={{
          kimi: {
            id: 'kimi',
            name: 'Kimi',
            status: 'unconfigured',
            offerings: [
              {
                id: 'official-subscription',
                label: 'Kimi 账号',
                kind: 'oauth-subscription',
                authModes: ['oauth'],
              },
              {
                id: 'subscription-key',
                label: 'Token Plan',
                kind: 'token-plan',
                authModes: ['apiKey'],
                endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.kimi.com/coding/v1' }],
              },
              {
                id: 'api-platform',
                label: 'API Platform',
                kind: 'api-platform',
                authModes: ['apiKey'],
                endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.moonshot.ai/v1' }],
              },
            ],
            credentials: [],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('当前部署未启用账号授权')).toBeTruthy()
    expect(screen.queryByText('登录未完成')).toBeNull()
    expect(document.body.textContent).not.toContain(internalMessage)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    const apiDialog = openCreateConnection('api-platform')
    expect(within(apiDialog.querySelector('[data-create-offering="api-platform"]') as HTMLElement).getByLabelText('Kimi API Key 输入')).toBeTruthy()
  })

  it.each(createDefaultProviderRegistry().listProducts().find((product) => product.id === 'bailian')!.offerings)(
    'uses one API key entry point and saves the selected Bailian offering $id',
    async (offering) => {
      const product: AiProviderSummary = {
        ...createDefaultProviderRegistry().listProducts().find((product) => product.id === 'bailian')!,
        status: 'available',
        credentials: [{
          id: 'existing-key', offeringId: offering.id, authMode: 'apiKey',
          enabled: true, priority: 20, health: 'healthy', version: 1,
        }, {
          id: 'other-offering-key', offeringId: offering.id === 'pay-as-you-go' ? 'token-plan' : 'pay-as-you-go',
          authMode: 'apiKey', enabled: true, priority: 90, health: 'healthy', version: 1,
        }],
        selectedModels: [],
      }
      const current = client()
      render(<AiConnectionsPanel client={current} selectedProvider="bailian" providerProducts={{ bailian: product }} />)

      expect(screen.getAllByRole('button', { name: '新建 API Key 连接' })).toHaveLength(1)
      expect(screen.queryByRole('combobox', { name: '百炼 套餐 / 区域' })).toBeNull()
      openCreateConnection()
      const dialog = screen.getByRole('dialog', { name: '新建连接' })
      expect(within(dialog).queryByRole('combobox', { name: '接入方式' })).toBeNull()
      expect(Array.from(dialog.querySelectorAll('[data-create-offering]')).map((item) => item.getAttribute('data-create-offering')))
        .toEqual(product.offerings.map((item) => item.id))
      const form = within(dialog.querySelector(`[data-create-offering="${offering.id}"]`) as HTMLElement)
      fireEvent.change(form.getByLabelText('百炼 API Key 输入'), { target: { value: 'sk-selected-plan' } })
      fireEvent.click(form.getByRole('button', { name: '高级设置' }))
      expect(form.getByLabelText('百炼 Base URL 输入').getAttribute('placeholder'))
        .toBe(offering.endpoints?.find((endpoint) => endpoint.protocol === 'chatCompletions')?.baseUrl)
      fireEvent.click(form.getByRole('button', { name: '保存 百炼 API Key' }))

      await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('bailian', {
        offeringId: offering.id, apiKey: 'sk-selected-plan', label: undefined, baseUrl: undefined, priority: 30,
      }))
      expect(current.updateProviderCredential).not.toHaveBeenCalled()
      await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('bailian', {
        offeringId: offering.id, credentialId: 'bailian-key-new',
      }))
    },
  )

  it('edits an existing key from another offering without changing its offering', async () => {
    const product: AiProviderSummary = {
      ...createDefaultProviderRegistry().listProducts().find((product) => product.id === 'bailian')!,
      status: 'available',
      credentials: [{
        id: 'team-key', offeringId: 'token-plan-team', authMode: 'apiKey', label: 'Team key',
        enabled: true, priority: 20, health: 'healthy', version: 3,
      }],
      selectedModels: [],
    }
    const credential = product.credentials[0]!
    const current = client({
      updateProviderCredential: vi.fn(async (_provider, _id, patch) => ({
        ...credential, ...patch, provider: 'bailian', version: patch.expectedVersion + 1,
      })),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="bailian" providerProducts={{ bailian: product }} />)

    expect(screen.getAllByRole('button', { name: '新建 API Key 连接' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '编辑 Team key' }))
    expect(screen.queryByRole('combobox', { name: '百炼 套餐 / 区域' })).toBeNull()
    fireEvent.change(screen.getByLabelText('百炼 API Key 标签'), { target: { value: 'Team renamed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭证' }))

    await waitFor(() => expect(current.updateProviderCredential).toHaveBeenCalledWith('bailian', 'team-key', {
      expectedVersion: 3, label: 'Team renamed', baseUrl: undefined,
    }))
    expect(current.createApiKeyCredential).not.toHaveBeenCalled()
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('bailian', {
      offeringId: 'token-plan-team', credentialId: 'team-key',
    }))
    expect(await screen.findByText('Team renamed')).toBeTruthy()
  })

  it('creates a token-plan credential with only its key and offering endpoint visible', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        providerProducts={{
          bailian: {
            id: 'bailian',
            name: '百炼',
            status: 'unconfigured',
            offerings: [{
              id: 'token-plan',
              label: 'Token Plan Personal',
              kind: 'token-plan',
              authModes: ['apiKey'],
              endpoints: [{
                protocol: 'chatCompletions',
                baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
              }],
              modelDiscovery: {
                strategy: 'openaiCompatible',
                path: '/models',
                endpointProtocol: 'chatCompletions',
              },
            }],
            credentials: [],
            selectedModels: [],
          },
        }}
      />,
    )

    expect(await screen.findByRole('heading', { name: 'Token 套餐' })).toBeTruthy()
    expect(await screen.findByText('token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')).toBeTruthy()
    openCreateConnection()

    const keyInput = await screen.findByLabelText('百炼 API Key 输入')
    expect(keyInput).toHaveProperty('type', 'password')
    expect(keyInput.getAttribute('autocomplete')).toBe('new-password')
    expect(keyInput.getAttribute('data-lpignore')).toBe('true')
    expect(screen.queryByRole('combobox', { name: '百炼 套餐 / 区域' })).toBeNull()
    expect(screen.queryByLabelText('百炼 API Key 标签')).toBeNull()
    expect(screen.queryByLabelText('百炼 Base URL 输入')).toBeNull()

    fireEvent.change(keyInput, { target: { value: 'sk-token-plan-secret' } })
    fireEvent.click(await screen.findByRole('button', { name: '保存 百炼 API Key' }))

    await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('bailian', {
      offeringId: 'token-plan',
      apiKey: 'sk-token-plan-secret',
      label: undefined,
      baseUrl: undefined,
      priority: 10,
    }))
  })

  it('queries and renders quota independently inside each offering item', async () => {
    const quota = vi.fn(async (_provider, _refresh, input) => ({
      credential: input?.credentialId ?? 'missing',
      status: 'available' as const,
      balance: input?.offeringId === 'pay-as-you-go' ? 42 : undefined,
      windows: input?.offeringId === 'token-plan'
        ? [{ name: 'weekly', limit: 100, remaining: 75 }]
        : [],
      observedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T01:00:00.000Z',
      source: `bailian:${String(input?.offeringId)}`,
    }))
    const current = client({ quota })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        providerProducts={{
          bailian: {
            id: 'bailian',
            name: '百炼',
            status: 'available',
            offerings: [
              { id: 'pay-as-you-go', label: 'PAYG', kind: 'api-platform', authModes: ['apiKey'] },
              { id: 'token-plan', label: 'Token Plan', kind: 'token-plan', authModes: ['apiKey'] },
            ],
            credentials: [
              { id: 'payg-key', offeringId: 'pay-as-you-go', authMode: 'apiKey', enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-...payg', version: 1 },
              { id: 'token-key', offeringId: 'token-plan', authMode: 'apiKey', enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-...plan', version: 1 },
            ],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '刷新 百炼 按量付费 API Key · sk-...payg额度' }))
    await waitFor(() => expect(quota).toHaveBeenCalledWith('bailian', true, {
      offeringId: 'pay-as-you-go',
      credentialId: 'payg-key',
      credentialIri: 'payg-key',
    }))

    fireEvent.click(screen.getByRole('button', { name: '刷新 百炼 Token 套餐 API Key · sk-...plan额度' }))
    await waitFor(() => expect(quota).toHaveBeenCalledWith('bailian', true, {
      offeringId: 'token-plan',
      credentialId: 'token-key',
      credentialIri: 'token-key',
    }))

    const paygItem = screen.getByRole('group', { name: 'API Key · sk-...payg额度' })
    const tokenItem = screen.getByRole('group', { name: 'API Key · sk-...plan额度' })
    expect(await within(paygItem).findByText('余额：42')).toBeTruthy()
    expect(await within(tokenItem).findByText('周限制 · 剩余 75%')).toBeTruthy()
    expect(within(paygItem).queryByText(/周限制/)).toBeNull()
    fireEvent.click(within(paygItem).getByRole('button', { name: /额度详情$/ }))
    expect(within(screen.getByRole('dialog')).getByText('来源：bailian:pay-as-you-go')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    fireEvent.click(within(tokenItem).getByRole('button', { name: /额度详情$/ }))
    expect(within(screen.getByRole('dialog')).getByText('周限制')).toBeTruthy()
    expect(within(screen.getByRole('dialog')).getByText('来源：bailian:token-plan')).toBeTruthy()

  })

  it('retains existing models and reports partial discovery without marking them unavailable', async () => {
    const product = openAiApiPlatformProduct()
    const existing = { id: 'retained-model', displayName: 'Retained model', provider: 'openai' as const, availability: 'available' as const }
    product.selectedModels = [existing]
    const discoverModels = vi.fn(async () => ({ provider: 'openai' as const, credential: 'primary',
      complete: false, models: [{ id: 'new-model', displayName: 'New model' }], observedAt: '', source: 'test' }))
    render(<AiConnectionsPanel client={client({ listModels: vi.fn(async () => [existing]), discoverModels })}
      selectedProvider="openai" providerProducts={{ openai: product }} />)
    fireEvent.click(await screen.findByRole('button', { name: '刷新模型' }))
    expect(await screen.findByText('部分连接同步失败，已保留原有模型目录，可稍后重试。')).toBeTruthy()
    expect(screen.getByText('Retained model')).toBeTruthy()
    expect(screen.getByText(/已失效 0/)).toBeTruthy()
  })

  it('refreshes all enabled credentials independently and retries only the failed row', async () => {
    let finishPrimary!: (value: Awaited<ReturnType<AiConnectionsClient['quota']>>) => void
    const quota = vi.fn((_provider, _refresh, input) => input.credentialId === 'primary'
      ? new Promise<Awaited<ReturnType<AiConnectionsClient['quota']>>>((resolve) => { finishPrimary = resolve })
      : Promise.reject(new Error('backup unavailable')))
    const product = openAiApiPlatformProduct()
    product.credentials = ['primary', 'backup', 'paused'].map((id, priority) => ({
      ...product.credentials[0], id, label: id, priority, enabled: id !== 'paused',
    }))
    render(<AiConnectionsPanel client={client({ quota })} selectedProvider="openai" providerProducts={{ openai: product }} />)
    fireEvent.click(screen.getByRole('button', { name: '刷新全部 OpenAI额度' }))
    await waitFor(() => expect(quota).toHaveBeenCalledTimes(2))
    expect(quota.mock.calls.map((call) => call[2].credentialId)).toEqual(['primary', 'backup'])
    expect(await within(screen.getByRole('group', { name: 'backup额度' })).findByRole('alert')).toBeTruthy()
    finishPrimary({ credential: 'primary', status: 'available', balance: 42, windows: [],
      observedAt: '2026-08-10T00:00:00Z', expiresAt: '2026-08-10T01:00:00Z', source: 'primary' })
    expect(await screen.findByText('余额：42')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API 平台 backup额度' }))
    await waitFor(() => expect(quota).toHaveBeenCalledTimes(3))
    expect(quota.mock.calls[2][2].credentialId).toBe('backup')
    expect(screen.getByText('余额：42')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'primary额度详情' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    render(<AiConnectionsPanel client={client({ quota })} selectedProvider="openai" providerProducts={{ openai: product }} />)
    expect(screen.queryByText('余额：42')).toBeNull()
    expect(quota).toHaveBeenCalledTimes(3)
  })

  it('does not relabel cached quota after the active credential changes within an offering', () => {
    const definition = PROVIDERS.find((provider) => provider.id === 'openai')!

    render(
      <AiCredentialPoolSection
        definition={definition}
        product={{
          id: 'openai',
          name: 'OpenAI',
          status: 'available',
          offerings: [{ id: 'api-platform', label: 'API Platform', kind: 'api-platform', authModes: ['apiKey'] }],
          credentials: [
            { id: 'primary-key', offeringId: 'api-platform', authMode: 'apiKey', label: 'Primary key', enabled: false, priority: 10, health: 'healthy', version: 1 },
            { id: 'backup-key', offeringId: 'api-platform', authMode: 'apiKey', label: 'Backup key', enabled: true, priority: 20, health: 'healthy', version: 1 },
          ],
          selectedModels: [],
        }}
        status="connected"
        apiKey=""
        busy={false}
        quotas={{
          'primary-key': {
            credentialId: 'primary-key',
            busy: false,
            quota: {
              credential: 'primary-key',
              status: 'available',
              balance: 99,
              windows: [],
              observedAt: '2026-08-10T00:00:00.000Z',
              expiresAt: '2026-08-10T01:00:00.000Z',
              source: 'openai:primary-key',
            },
          },
        }}
        onApiKeyChange={() => undefined}
        onBeginApiKey={() => undefined}
        onBeginBrowser={() => undefined}
        onSaveApiKey={() => undefined}
        onDisconnect={() => undefined}
      />,
    )

    expect(screen.getByText('Backup key')).toBeTruthy()
    expect(screen.getByText('尚未检查')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Primary key额度' })).getByText('余额：99')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Backup key额度' })).queryByText('余额：99')).toBeNull()
  })

  it('keeps Kimi subscription, Token Plan, and API Platform endpoints and quota results separate', async () => {
    const quota = vi.fn(async (_provider, _refresh, input) => ({
      credential: input?.credentialId ?? 'missing',
      status: 'available' as const,
      windows: input?.offeringId === 'api-platform'
        ? [{ name: 'available_balance', remaining: 12.5, currency: 'CNY' }]
        : [
            { name: 'five-hour', limit: 50, remaining: 40, resetsAt: '2026-08-10T15:00:00.000Z' },
            { name: 'weekly', limit: 100, remaining: 60, resetsAt: '2026-08-16T00:00:00.000Z' },
          ],
      observedAt: '2026-08-10T10:00:00.000Z',
      expiresAt: '2026-08-10T10:05:00.000Z',
      source: input?.offeringId === 'api-platform' ? 'kimi:/v1/users/me/balance' : 'kimi-code:/usages',
    }))
    render(
      <AiConnectionsPanel
        client={client({ quota })}
        selectedProvider="kimi"
        providerProducts={{
          kimi: {
            id: 'kimi',
            name: 'Kimi',
            status: 'available',
            offerings: [
              {
                id: 'official-subscription', label: 'Official Subscription', kind: 'oauth-subscription', authModes: ['oauth'],
                endpoints: [
                  { protocol: 'chatCompletions', baseUrl: 'https://api.kimi.com/coding/v1' },
                  { protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding/' },
                ],
              },
              {
                id: 'subscription-key', label: 'Token Plan', kind: 'token-plan', authModes: ['apiKey'],
                endpoints: [
                  { protocol: 'chatCompletions', baseUrl: 'https://api.kimi.com/coding/v1' },
                  { protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding/' },
                ],
              },
              {
                id: 'api-platform', label: 'API Platform', kind: 'api-platform', authModes: ['apiKey'],
                endpoints: [{ protocol: 'chatCompletions', baseUrl: 'https://api.moonshot.ai/v1' }],
              },
            ],
            credentials: [
              { id: 'kimi-oauth', offeringId: 'official-subscription', authMode: 'deviceCode', enabled: true, priority: 10, health: 'healthy', version: 1 },
              { id: 'kimi-plan', offeringId: 'subscription-key', authMode: 'apiKey', enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-kimi-...plan', version: 1 },
              { id: 'kimi-platform', offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-...platform', version: 1 },
            ],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(screen.getByText('接入信息'))
    const official = screen.getByRole('heading', { name: '账号订阅' }).closest('section')!
    const tokenPlan = screen.getByRole('heading', { name: 'Token 套餐' }).closest('section')!
    const apiPlatform = screen.getByRole('heading', { name: 'API 平台' }).closest('section')!
    expect(within(official).getByText('api.kimi.com/coding/v1')).toBeTruthy()
    expect(within(official).getByText('api.kimi.com/coding')).toBeTruthy()
    expect(within(official).getByText('Chat API')).toBeTruthy()
    expect(within(official).getByText('Anthropic API')).toBeTruthy()
    expect(within(tokenPlan).getByText('api.kimi.com/coding/v1')).toBeTruthy()
    expect(within(tokenPlan).getByText('api.kimi.com/coding')).toBeTruthy()
    expect(within(apiPlatform).getByText('api.moonshot.ai/v1')).toBeTruthy()

    const tokenQuota = screen.getByRole('group', { name: 'API Key · sk-kimi-...plan额度' })
    const apiQuota = screen.getByRole('group', { name: 'API Key · sk-...platform额度' })
    fireEvent.click(within(tokenQuota).getByRole('button', { name: /^刷新 / }))
    expect(await within(tokenQuota).findByText('5 小时限制 · 剩余 80%')).toBeTruthy()
    expect(within(tokenQuota).getByText('周限制 · 剩余 60%')).toBeTruthy()
    expect(within(apiQuota).queryByText(/5 小时限制/)).toBeNull()

    fireEvent.click(within(apiQuota).getByRole('button', { name: /^刷新 / }))
    expect(await within(apiQuota).findByText('可用余额 · 剩余 12.5 CNY')).toBeTruthy()
    expect(quota).toHaveBeenCalledWith('kimi', true, {
      offeringId: 'subscription-key', credentialId: 'kimi-plan', credentialIri: 'kimi-plan',
    })
    expect(quota).toHaveBeenCalledWith('kimi', true, {
      offeringId: 'api-platform', credentialId: 'kimi-platform', credentialIri: 'kimi-platform',
    })
  })

  it('renders multiple API key credentials as a pool without exposing raw key material', async () => {
    render(
      <AiConnectionsPanel
        client={client()}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai',
            name: 'OpenAI',
            status: 'available',
            offerings: [{
              id: 'api-platform',
              label: 'API Key',
              authModes: ['apiKey'],
            }],
            credentials: [
              {
                id: 'openai-key-primary',
                offeringId: 'api-platform',
                authMode: 'apiKey',
                label: 'Primary key',
                enabled: true,
                priority: 10,
                health: 'healthy',
                maskedHint: 'sk-...prod',
                version: 1,
              },
              {
                id: 'openai-key-backup',
                offeringId: 'api-platform',
                authMode: 'apiKey',
                label: 'Backup key',
                enabled: false,
                priority: 20,
                health: 'unknown',
                maskedHint: 'sk-...back',
                version: 1,
              },
            ],
            selectedModels: [],
          },
        }}
      />,
    )

    expect(await screen.findByText('Primary key')).toBeTruthy()
    expect(screen.getByText('Backup key')).toBeTruthy()
    expect(screen.getByText('sk-...prod')).toBeTruthy()
    expect(screen.getByLabelText('已启用 · 有效')).toBeTruthy()
    expect(screen.getByLabelText('已停用 · 未验证')).toBeTruthy()
    expect(screen.getByRole('button', { name: '停用 Primary key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '启用 Backup key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '测试连接 Primary key' })).toBeTruthy()
    expect(screen.getByText('Backup key').closest('[data-credential-state]')?.getAttribute('data-credential-state')).toBe('disabled')
    expect(document.body.textContent).not.toContain('sk-provider-secret')
  })

  it('adds a second API key without replacing the existing credential', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai',
            name: 'OpenAI',
            status: 'available',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [{
              id: 'openai-key-primary',
              offeringId: 'api-platform',
              authMode: 'apiKey',
              label: 'Primary key',
              enabled: true,
              priority: 10,
              health: 'healthy',
              maskedHint: 'sk-...prod',
              version: 1,
            }],
            selectedModels: [],
          },
        }}
      />,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('OpenAI API Key 输入')).toBeNull()
    openCreateConnection()
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), { target: { value: 'sk-work-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }))
    fireEvent.change(screen.getByLabelText('OpenAI Base URL 输入'), { target: { value: 'https://proxy.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('openai', {
      offeringId: 'api-platform',
      apiKey: 'sk-work-secret',
      label: undefined,
      baseUrl: 'https://proxy.example/v1',
      priority: 20,
    }))
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai', {
      offeringId: 'api-platform',
      credentialId: 'openai-key-new',
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Primary key')).toBeTruthy()
    expect(await screen.findByText('API Key · sk-...new')).toBeTruthy()
    expect(await screen.findByText('openai Model 1')).toBeTruthy()
    expect(document.body.textContent).not.toContain('sk-work-secret')
  })

  it('keeps credential form values available for correction when the Pod write fails', async () => {
    const current = client({
      createApiKeyCredential: vi.fn(async () => {
        throw new Error('Pod write rejected')
      }),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai', name: 'OpenAI', status: 'unconfigured',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [], selectedModels: [],
          },
        }}
      />,
    )

    openCreateConnection()
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), { target: { value: 'sk-correct-me' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    expect(await screen.findAllByText('请求未完成。请确认 Xpod 正在运行且登录仍有效，然后重试。')).not.toHaveLength(0)
    expect(screen.getByRole('dialog', { name: '新建连接' })).toBeTruthy()
    expect((screen.getByLabelText('OpenAI API Key 输入') as HTMLInputElement).value).toBe('sk-correct-me')
    expect(screen.getByRole('button', { name: '保存 OpenAI API Key' })).toBeTruthy()
  })

  it('creates and edits a credential proxy without conflating it with Base URL', async () => {
    const current = client({
      createApiKeyCredential: vi.fn(async (provider, input) => ({
        id: `${provider}-proxy-key`,
        provider,
        offeringId: input.offeringId ?? 'api-platform',
        authMode: 'apiKey' as const,
        label: input.label,
        enabled: true,
        priority: input.priority ?? 10,
        health: 'healthy' as const,
        maskedHint: 'id-...cret',
        baseUrl: input.baseUrl,
        proxyUrl: input.proxyUrl,
        version: 1,
      })),
      updateProviderCredential: vi.fn(async (provider, credentialId, input) => ({
        id: credentialId,
        provider,
        offeringId: 'api-platform',
        authMode: 'apiKey' as const,
        label: 'Proxy key',
        enabled: true,
        priority: 10,
        health: 'healthy' as const,
        maskedHint: 'id-...cret',
        baseUrl: input.baseUrl ?? 'https://api.openai.com/v1',
        proxyUrl: input.proxyUrl,
        version: input.expectedVersion + 1,
      })),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai', name: 'OpenAI', status: 'available',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [], selectedModels: [],
          },
        }}
      />,
    )

    openCreateConnection()
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), { target: { value: 'id.secret-key' } })
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }))
    fireEvent.change(screen.getByLabelText('OpenAI Base URL 输入'), { target: { value: 'https://api.openai.com/v1' } })
    fireEvent.change(screen.getByLabelText('OpenAI Proxy URL 输入'), { target: { value: 'https://proxy.example:8443' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('openai', {
      offeringId: 'api-platform',
      apiKey: 'id.secret-key',
      label: undefined,
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'https://proxy.example:8443',
      priority: 10,
    }))
    expect(await screen.findByText('API Key · id-...cret')).toBeTruthy()
    expect(screen.queryByText('password')).toBeNull()
  })

  it('opens the custom Provider form from the list header and normalizes a bare OpenAI-compatible base URL', async () => {
    const current = client()
    const controller = {
      client: current,
      searchQuery: '',
      setSearchQuery: vi.fn(),
      selectProvider: vi.fn(),
      loadProviders: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as AiConnectionsController

    render(<AiConnectionsHeader controller={controller} />)

    fireEvent.click(screen.getByRole('button', { name: '添加 AI Connection' }))
    expect(screen.getByRole('dialog', { name: '添加自定义 Provider' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Provider 名称'), { target: { value: 'timicc' } })
    fireEvent.change(screen.getByLabelText('兼容协议'), { target: { value: 'openai' } })
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://timicc.com' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-custom-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存自定义 Provider' }))

    await waitFor(() => expect(current.createApiKeyCredential).toHaveBeenCalledWith('custom', {
      offeringId: 'openai-compatible',
      apiKey: 'sk-custom-secret',
      label: 'timicc',
      baseUrl: 'https://timicc.com/v1',
      priority: 10,
      compatibility: 'openai',
    }))
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('custom', {
      offeringId: 'openai-compatible',
      credentialId: 'custom-key-new',
      compatibility: 'openai',
    }))
    expect(controller.selectProvider).toHaveBeenCalledWith('custom', 'custom-key-new')
    expect(controller.loadProviders).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('sk-custom-secret')
  })

  it('renders each custom credential as an independent provider item', () => {
    const controller = {
      selectedProvider: 'custom',
      selectedCredentialId: 'custom-two',
      searchQuery: '',
      providerStates: { custom: 'configured' },
      providerSummaries: {
        custom: {
          id: 'custom', name: 'Custom', status: 'available', offerings: [], selectedModels: [],
          credentials: [
            { id: 'custom-one', offeringId: 'openai-compatible', authMode: 'apiKey', label: 'timicc', enabled: true, priority: 10, health: 'healthy', version: 1 },
            { id: 'custom-two', offeringId: 'openai-compatible', authMode: 'apiKey', label: '备用接口', enabled: true, priority: 20, health: 'healthy', version: 1 },
          ],
        },
      },
      subscribe: vi.fn(() => () => undefined),
      selectProvider: vi.fn(),
    } as unknown as AiConnectionsController

    render(<AiConnectionsList controller={controller} />)

    expect(screen.getByRole('option', { name: /timicc/u })).toBeTruthy()
    expect(screen.getByRole('option', { name: /备用接口/u }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('option', { name: /timicc/u }))
    expect(controller.selectProvider).toHaveBeenCalledWith('custom', 'custom-one')
  })

  it('does not leak legacy or sibling models into a selected custom provider instance', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'legacy-model', provider: 'custom' },
        { id: 'first-model', provider: 'custom', credentialId: 'custom-one' },
        { id: 'second-model', provider: 'custom', credentialId: 'custom-two' },
      ]),
    })
    const controller = {
      client: current,
      selectedProvider: 'custom',
      selectedCredentialId: 'custom-two',
      sessionStatus: 'authenticated',
      podStatus: 'ready',
      searchQuery: '',
      providerStates: { custom: 'configured' },
      providerSummaries: {
        custom: {
          id: 'custom', name: 'Custom', status: 'available',
          offerings: [{ id: 'openai-compatible', label: 'OpenAI compatible', authModes: ['apiKey'] }],
          credentials: [
            { id: 'custom-one', offeringId: 'openai-compatible', authMode: 'apiKey', label: 'timicc', enabled: true, priority: 10, health: 'healthy', version: 1 },
            { id: 'custom-two', offeringId: 'openai-compatible', authMode: 'apiKey', label: '备用接口', enabled: true, priority: 20, health: 'healthy', version: 1 },
          ],
          selectedModels: [],
        },
      },
      loadProviders: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
      setProviderState: vi.fn(),
      loginRoutes: [],
      login: vi.fn(),
    } as unknown as AiConnectionsController

    render(<AiConnectionsMain controller={controller} />)

    expect(await screen.findByText('second-model')).toBeTruthy()
    expect(screen.queryByText('first-model')).toBeNull()
    expect(screen.queryByText('legacy-model')).toBeNull()
    const selectModel = screen.getByRole('checkbox', { name: '选择 second-model' })
    await waitFor(() => expect(selectModel).toHaveProperty('disabled', false))
    fireEvent.click(selectModel)
    await waitFor(() => expect(current.saveModelSelection).toHaveBeenCalledWith(
      'custom',
      [{ id: 'second-model' }],
      'custom-two',
    ))
  })

  it('retains a redacted proxy display when editing a saved credential', async () => {
    const current = client({
      updateProviderCredential: vi.fn(async (provider, credentialId, input) => ({
        id: credentialId, provider, offeringId: 'api-platform', authMode: 'apiKey' as const,
        label: input.label ?? 'Proxy key', enabled: true, priority: 10, health: 'healthy' as const,
        maskedHint: 'sk-...prod', baseUrl: input.baseUrl, proxyUrl: input.proxyUrl, version: input.expectedVersion + 1,
      })),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai', name: 'OpenAI', status: 'available',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [{ id: 'openai-proxy-key', offeringId: 'api-platform', authMode: 'apiKey', label: 'Proxy key',
              enabled: true, priority: 10, health: 'healthy', maskedHint: 'sk-...prod',
              baseUrl: 'https://api.openai.com/v1', proxyUrl: 'https://proxy.example:8443', version: 3 }],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '编辑 Proxy key' }))
    expect(screen.getByLabelText('OpenAI Proxy URL 输入')).toHaveProperty('value', 'https://proxy.example:8443')
    fireEvent.change(screen.getByLabelText('OpenAI Proxy URL 输入'), { target: { value: 'http://proxy.example:8080' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭证' }))
    await waitFor(() => expect(current.updateProviderCredential).toHaveBeenCalledWith('openai', 'openai-proxy-key', {
      expectedVersion: 3,
      label: 'Proxy key',
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'http://proxy.example:8080',
    }))
  })

  it('keeps a saved credential and exposes retry when automatic model sync fails', async () => {
    const current = client({
      discoverModels: vi.fn(async () => {
        throw new Error('模型目录暂时不可用')
      }),
    })
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai',
            name: 'OpenAI',
            status: 'unconfigured',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [],
            selectedModels: [],
          },
        }}
      />,
    )

    openCreateConnection()
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), { target: { value: 'sk-work-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    expect(await screen.findByText('API Key · sk-...new')).toBeTruthy()
    expect(await screen.findByText('请求未完成。请确认 Xpod 正在运行且登录仍有效，然后重试。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '同步模型' })).toBeTruthy()
  })

  it('edits, toggles, deletes, tests, and reorders individual API key credentials', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai',
            name: 'OpenAI',
            status: 'available',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [
              {
                id: 'openai-key-primary',
                offeringId: 'api-platform',
                authMode: 'apiKey',
                label: 'Primary key',
                enabled: true,
                priority: 10,
                health: 'healthy',
                maskedHint: 'sk-...prod',
                baseUrl: 'https://api.openai.com/v1',
                version: 1,
              },
              {
                id: 'openai-key-backup',
                offeringId: 'api-platform',
                authMode: 'apiKey',
                label: 'Backup key',
                enabled: false,
                priority: 20,
                health: 'unknown',
                maskedHint: 'sk-...back',
                version: 2,
              },
            ],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '编辑 Primary key' }))
    fireEvent.change(screen.getByLabelText('OpenAI API Key 标签'), { target: { value: 'Primary renamed' } })
    fireEvent.change(screen.getByLabelText('OpenAI Base URL 输入'), { target: { value: 'https://proxy.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存凭证' }))
    await waitFor(() => expect(current.updateProviderCredential).toHaveBeenCalledWith('openai', 'openai-key-primary', {
      expectedVersion: 1,
      label: 'Primary renamed',
      baseUrl: 'https://proxy.example/v1',
    }))
    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('openai', {
      offeringId: 'api-platform',
      credentialId: 'openai-key-primary',
    }))

    fireEvent.click(screen.getByRole('button', { name: '停用 Primary renamed' }))
    await waitFor(() => expect(current.updateProviderCredential).toHaveBeenCalledWith('openai', 'openai-key-primary', {
      expectedVersion: 2,
      enabled: false,
    }))

    fireEvent.click(screen.getByRole('button', { name: '测试连接 Primary renamed' }))
    await waitFor(() => expect(current.testProviderCredential).toHaveBeenCalledWith('openai', {
      credentialId: 'openai-key-primary',
    }))
    expect(await screen.findByText('测试通过')).toBeTruthy()

    expect(screen.queryByRole('button', { name: '上移 Backup key' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: '拖动排序 Backup key' }), { key: 'ArrowUp' })
    await waitFor(() => expect(current.updateProviderCredential).toHaveBeenCalledWith('openai', 'openai-key-backup', {
      expectedVersion: 2,
      priority: 10,
    }))
    expect(current.updateProviderCredential).toHaveBeenCalledWith('openai', 'openai-key-primary', {
      expectedVersion: 3,
      priority: 20,
    })

    fireEvent.click(screen.getByRole('button', { name: '删除 Backup key' }))
    await waitFor(() => expect(current.deleteProviderCredential).toHaveBeenCalledWith('openai', 'openai-key-backup'))
    expect(screen.queryByText('Backup key')).toBeNull()
  })

  it('updates the credential health badge after a connection test', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerProducts={{
          openai: {
            id: 'openai', name: 'OpenAI', status: 'configured',
            offerings: [{ id: 'api-platform', label: 'API Key', authModes: ['apiKey'] }],
            credentials: [{
              id: 'openai-unverified', offeringId: 'api-platform', authMode: 'apiKey', label: '待验证',
              enabled: true, priority: 10, health: 'unknown', version: 1,
            }],
            selectedModels: [],
          },
        }}
      />,
    )

    expect(screen.getByLabelText('已启用 · 未验证')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '测试连接 待验证' }))
    await waitFor(() => expect(current.testProviderCredential).toHaveBeenCalled())
    expect(await screen.findByLabelText('已启用 · 有效')).toBeTruthy()
  })

  it('verifies a configured provider and merges discovered models into the catalog', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'deepseek-chat', provider: 'deepseek' as const, displayName: 'DeepSeek Chat' },
      ]),
      discoverModels: vi.fn(async (provider) => ({
        provider,
        credential: 'deepseek-credential',
        models: [
          { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
        ],
        observedAt: '2026-08-06T00:00:00.000Z',
        source: 'deepseek:/models',
      })),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '同步模型' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('deepseek'))
    expect(await screen.findByText('连接成功，已同步 2 个模型')).toBeTruthy()
    expect(screen.getByText('DeepSeek Reasoner')).toBeTruthy()
    expect(screen.getAllByText('DeepSeek Chat')).toHaveLength(1)
  })

  it('announces an empty discovery instead of a silent success', async () => {
    const current = client({
      discoverModels: vi.fn(async (provider) => ({
        provider,
        credential: 'deepseek-credential',
        models: [],
        observedAt: '2026-08-06T00:00:00.000Z',
        source: 'deepseek:/models',
      })),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '同步模型' }))

    await waitFor(() => expect(current.discoverModels).toHaveBeenCalledWith('deepseek'))
    expect(await screen.findByText(/服务商未返回任何模型/u)).toBeTruthy()
    expect(screen.getByText('暂无可用模型')).toBeTruthy()
  })

  it('surfaces a failed verification through the provider error slot', async () => {
    const current = client({
      discoverModels: vi.fn(async () => {
        throw new Error('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')
      }),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="deepseek"
        providerSummaries={{
          deepseek: {
            provider: 'deepseek',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: {
              modes: ['browserAssistedApiKey'],
              configured: true,
            },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '同步模型' }))

    expect(await screen.findByText('密钥不可用。请检查密钥是否填写正确，或换一个密钥后重试。')).toBeTruthy()
  })

  it('hides verification for providers without a credential', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  />)

    await waitFor(() => expect(current.listModels).toHaveBeenCalled())

    expect(screen.queryByRole('button', { name: '同步模型' })).toBeNull()
  })

  it('adds a custom model through the editor dialog and refreshes the catalog', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'ft-assistant', provider: 'openai' as const, displayName: 'Assistant', custom: true, inputModalities: ['image'], capabilities: ['tool_call'] },
      ]),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'ft-assistant' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Assistant' } })
    fireEvent.click(screen.getByRole('button', { name: '视觉识别' }))
    fireEvent.click(screen.getByRole('button', { name: '函数调用' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(current.saveProviderModel).toHaveBeenCalledWith('openai', {
      id: 'ft-assistant',
      displayName: 'Assistant',
      inputModalities: ['image'],
      capabilities: ['tool_call'],
    }))
    expect(await screen.findByText('Assistant')).toBeTruthy()
  })

  it('edits and deletes custom models from the catalog rows', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'ft-assistant', provider: 'openai' as const, displayName: 'Assistant', custom: true, inputModalities: ['image'] },
        { id: 'gpt-5', provider: 'openai' as const },
      ]),
    })

    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        providerSummaries={{
          openai: {
            provider: 'openai',
            status: 'connected',
            authMode: 'browserAssistedApiKey',
            connect: { modes: ['browserAssistedApiKey'], configured: true },
          },
        }}
      />,
    )

    expect(await screen.findByText('Assistant')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '删除 gpt-5' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '编辑 Assistant' }))
    expect(screen.getByLabelText('模型 ID')).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Assistant v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(current.saveProviderModel).toHaveBeenCalledWith('openai', {
      id: 'ft-assistant',
      displayName: 'Assistant v2',
      inputModalities: ['image'],
      capabilities: undefined,
    }))

    fireEvent.click(screen.getByRole('button', { name: '删除 Assistant' }))
    await waitFor(() => expect(current.deleteProviderModel).toHaveBeenCalledWith('openai', 'ft-assistant'))
  })

  it('opens browser-assisted key setup and submits the key without rendering it afterwards', async () => {
    const current = client()
    const openExternal = vi.fn()
    render(<AiConnectionsPanel client={current} openExternal={openExternal}  />)

    openCreateConnection()
    await waitFor(() => expect(current.beginConnect).toHaveBeenCalledWith('openai', 'browserAssistedApiKey'))
    expect(openExternal).toHaveBeenCalledWith('https://provider.example/keys')

    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), {
      target: { value: 'sk-provider-secret' },
    })
    fireEvent.change(screen.getByLabelText('OpenAI Base URL 输入'), {
      target: { value: 'https://proxy.example/v1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    await waitFor(() => expect(current.completeApiKey).toHaveBeenCalledWith(
      'openai',
      expect.anything(),
      'sk-provider-secret',
      undefined,
      'https://proxy.example/v1',
    ))
    expect(screen.queryByDisplayValue('sk-provider-secret')).toBeNull()
    expect(screen.queryByText('sk-provider-secret')).toBeNull()
    expect(screen.getByText('已配置')).toBeTruthy()
  })

  it('recovers visibly when a browser-assisted connection expires before API Key entry', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'expired' as const,
        message: '连接已过期，请重新开始',
      })),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  />)

    openCreateConnection()

    expect(await screen.findByText('连接已过期，请重新开始')).toBeTruthy()
    expect(screen.queryByLabelText('OpenAI API Key 输入')).toBeNull()
  })

  it('does not render raw secret material from provider errors', async () => {
    const current = client({
      beginConnect: vi.fn(async () => {
        throw new Error('upstream failed sk-live-secret xpod_once_secret apiKey=secret token=secret Authorization: Bearer secret {"secret":"json-secret"}')
      }),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  />)

    openCreateConnection()

    expect(await screen.findByText('请求未完成。请确认 Xpod 正在运行且登录仍有效，然后重试。')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
  })

  it('does not offer a silent quota refresh before provider credentials are available', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai" />)

    expect(screen.queryByRole('button', { name: /^刷新 .*额度$/ })).toBeNull()
    expect(current.quota).not.toHaveBeenCalled()
    expect(await screen.findByText('尚未添加连接')).toBeTruthy()
  })

  it('shows a visible pending state while the offering quota request is unresolved', async () => {
    const current = client({ quota: vi.fn(() => new Promise(() => {})) })
    render(<AiConnectionsPanel client={current} selectedProvider="openai" providerProducts={{
      openai: openAiApiPlatformProduct(),
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API 平台 API Key额度' }))

    expect(await screen.findByText('正在查询额度…')).toBeTruthy()
    expect((screen.getByRole('button', { name: '刷新 OpenAI API 平台 API Key额度' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('queries quota for an account subscription imported from a local client', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai" providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'available', selectedModels: [],
        offerings: [{ id: 'official-subscription', kind: 'oauth-subscription', authModes: ['local'] }],
        credentials: [{
          id: 'imported-account', offeringId: 'official-subscription', authMode: 'oauth',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI 账号订阅 已授权账号额度' }))

    await waitFor(() => expect(current.quota).toHaveBeenCalledWith('openai', true, {
      offeringId: 'official-subscription', credentialId: 'imported-account', credentialIri: 'imported-account',
    }))
    expect(screen.getByText('官方额度接口不支持')).toBeTruthy()
  })

  it('states unsupported quota honestly', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current}  providerProducts={{
      openai: openAiApiPlatformProduct(),
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API 平台 API Key额度' }))

    await waitFor(() => expect(current.quota).toHaveBeenCalledWith('openai', true, {
      offeringId: 'api-platform',
      credentialId: 'openai-api-key',
      credentialIri: 'openai-api-key',
    }))
    expect(screen.getByText('官方额度接口不支持')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /额度详情$/ }))
    expect(screen.getByText('来源：openai:console-only')).toBeTruthy()
  })

  it('renders subscription remaining percentages and reset times for every quota window', async () => {
    const observedAt = '2026-08-09T00:00:00.000Z'
    const fiveHourReset = '2026-08-09T05:00:00.000Z'
    const weeklyReset = '2026-08-16T00:00:00.000Z'
    const current = client({
      quota: vi.fn(async () => ({
        credential: 'openai-subscription',
        status: 'available' as const,
        windows: [
          { name: 'five-hour', used: 25, limit: 100, remaining: 75, resetsAt: fiveHourReset },
          { name: 'weekly', used: 60, limit: 100, remaining: 40, resetsAt: weeklyReset },
        ],
        observedAt,
        expiresAt: '2026-08-09T00:05:00.000Z',
        source: 'openai:chatgpt-wham',
        stale: true,
      })),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'available', selectedModels: [],
        offerings: [{ id: 'official-subscription', kind: 'oauth-subscription', authModes: ['oauth'] }],
        credentials: [{
          id: 'openai-subscription', offeringId: 'official-subscription', authMode: 'oauth',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI 账号订阅 已授权账号额度' }))

    fireEvent.click(await screen.findByLabelText('已授权账号额度详情'))
    expect(screen.getByText('5 小时限制')).toBeTruthy()
    expect(screen.getByText('剩余 75%')).toBeTruthy()
    expect(screen.getByText('周限制')).toBeTruthy()
    expect(screen.getByText('剩余 40%')).toBeTruthy()
    expect(screen.getByText(`重置：${new Date(fiveHourReset).toLocaleString()}`)).toBeTruthy()
    expect(screen.getByText(`重置：${new Date(weeklyReset).toLocaleString()}`)).toBeTruthy()
    expect(screen.getByText(`更新：${new Date(observedAt).toLocaleString()}`)).toBeTruthy()
    expect(screen.getByText('来源：openai:chatgpt-wham · 数据可能已过期')).toBeTruthy()
  })

  it('renders api-platform balance and currency breakdowns for cash, voucher, and available balances', async () => {
    const current = client({
      quota: vi.fn(async () => ({
        credential: 'openai-api-platform',
        status: 'available' as const,
        balance: 18.75,
        windows: [
          { name: 'cash_balance', remaining: 12.5, currency: 'USD' },
          { name: 'voucher_balance', remaining: 6.25, currency: 'USD' },
          { name: 'available_balance', remaining: 18.75, currency: 'USD' },
        ],
        observedAt: '2026-08-10T00:00:00.000Z',
        expiresAt: '2026-08-10T00:05:00.000Z',
        source: 'openai:api-platform',
      })),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai"  providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'available', selectedModels: [],
        offerings: [{ id: 'api-platform', kind: 'api-platform', authModes: ['apiKey'] }],
        credentials: [{
          id: 'openai-api-platform', offeringId: 'api-platform', authMode: 'apiKey',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API 平台 API Key额度' }))

    expect(await screen.findByText('余额：18.75')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('API Key额度详情'))
    expect(screen.getByText('现金余额')).toBeTruthy()
    expect(screen.getByText('剩余 12.5 USD')).toBeTruthy()
    expect(screen.getByText('赠送余额')).toBeTruthy()
    expect(screen.getByText('剩余 6.25 USD')).toBeTruthy()
    expect(screen.getByText('可用余额')).toBeTruthy()
    expect(screen.getByText('剩余 18.75 USD')).toBeTruthy()
    expect(screen.getByText('来源：openai:api-platform')).toBeTruthy()
  })

  it('renders allowlisted unsupported errors without raw details', async () => {
    const current = client({
      quota: vi.fn(async () => {
        throw new Error('unsupported: Authorization Bearer provider-secret token=provider-secret')
      }),
    })
    render(<AiConnectionsPanel
      client={current}
      selectedProvider="openai"
      providerProducts={{ openai: openAiApiPlatformProduct() }}
    />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API 平台 API Key额度' }))

    expect(await screen.findByText('This AI Connection operation is not supported.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Bearer|token|provider-secret/)
  })

  it('shows only the selected Provider models from the current WebID catalog', async () => {
    const current = client({
      listModels: vi.fn(async () => [
        { id: 'gpt-5.4', provider: 'openai' as const, displayName: 'GPT-5.4' },
        { id: 'claude-sonnet-4-5', provider: 'anthropic' as const, displayName: 'Claude Sonnet 4.5' },
      ]),
    })

    render(<AiConnectionsPanel client={current} selectedProvider="openai"  />)

    expect(await screen.findByText('GPT-5.4')).toBeTruthy()
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull()
    expect(current.listModels).toHaveBeenCalledOnce()
  })

  it('does not open or poll a terminal Kimi device-code attempt', async () => {
    const current = client({
      beginConnect: vi.fn(async (provider, mode) => ({
        provider,
        mode,
        status: 'cancelled' as const,
        authorizationUrl: 'https://provider.example/stale',
        message: '用户已取消连接',
      })),
    })
    const openExternal = vi.fn()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        openExternal={openExternal}
        providerProducts={{
          kimi: {
            id: 'kimi',
            name: 'Kimi',
            status: 'unconfigured',
            offerings: [{
              id: 'official-subscription',
              label: 'Kimi 账号',
              authModes: ['oauth'],
            }],
            credentials: [],
            selectedModels: [],
          },
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect(await screen.findByText('用户已取消连接')).toBeTruthy()
    expect(openExternal).not.toHaveBeenCalled()
    expect(current.pollDevice).not.toHaveBeenCalled()
  })

  it('opens API Key creation from the list without exposing CSS client credential fields', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedSection="keys" />)

    expect(await screen.findByText(/API Key 用于访问 Xpod Gateway/)).toBeTruthy()
    expect(screen.queryByLabelText('API Key 名称')).toBeNull()
    const create = screen.getByRole('button', { name: '新建 API Key' })
    await waitFor(() => expect(create).toHaveProperty('disabled', false))
    fireEvent.click(create)
    expect(screen.getByLabelText('API Key 名称')).toHaveProperty('value', '我的 API Key')
    expect(screen.queryByLabelText('应用到客户端')).toBeNull()
    expect(screen.getByRole('button', { name: '创建 API Key' })).toBeTruthy()
    expect(screen.queryByLabelText('Client ID')).toBeNull()
    expect(screen.queryByLabelText('Client Secret')).toBeNull()
  })
})


describe('credential drag sorting', () => {
  function pointer(target: HTMLElement, type: string, pointerType: string, clientY: number) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { pointerId: 1, pointerType, button: 0, clientY })
    fireEvent(target, event)
  }

  function pool(authMode: 'apiKey' | 'oauth', busy = false, disabled = false) {
    const move = vi.fn()
    const offering = { id: 'pool', label: 'Pool', authModes: [authMode] }
    const credentials = ['First', 'Second', 'Third'].map((label, index) => ({
      id: label, label, offeringId: 'pool', authMode, enabled: true,
      priority: (index + 1) * 10, health: 'unknown' as const, version: 1,
    }))
    render(<AiCredentialPoolSection definition={PROVIDERS.find((p) => p.id === 'openai')!}
      product={{ id: 'openai', name: 'OpenAI', status: 'available', offerings: [offering], credentials, selectedModels: [] }}
      status="configured" apiKey="" busy={busy} disabled={disabled}
      onApiKeyChange={vi.fn()} onBeginApiKey={vi.fn()} onBeginBrowser={vi.fn()}
      onSaveApiKey={vi.fn()} onDisconnect={vi.fn()} onReorderCredentials={move} />)
    return { move, offering, credentials }
  }

  it.each(['apiKey', 'oauth'] as const)('sorts %s with keyboard, including boundaries', (mode) => {
    const { move, offering, credentials } = pool(mode)
    fireEvent.keyDown(screen.getByRole('button', { name: '拖动排序 First' }), { key: 'ArrowUp' })
    expect(move).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: '拖动排序 Third' }), { key: 'Home' })
    expect(move).toHaveBeenCalledWith(offering, credentials, 2, 0)
  })

  it.each(['mouse', 'touch'] as const)('drags only from the handle with %s', (pointerType) => {
    const { move, offering, credentials } = pool('apiKey')
    const handle = screen.getByRole('button', { name: '拖动排序 First' })
    const rows = document.querySelectorAll('[data-sortable-credential]')
    rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      top: index * 60, bottom: (index + 1) * 60, left: 0, right: 500, width: 500, height: 60,
      x: 0, y: index * 60, toJSON() {},
    }))
    pointer(handle, 'pointerdown', pointerType, 30)
    pointer(handle, 'pointermove', pointerType, 150)
    pointer(handle, 'pointerup', pointerType, 150)
    expect(move).toHaveBeenCalledWith(offering, credentials, 0, 2)
  })

  it('keeps mixed subscription and API credentials in one list with inline quotas after cross-type drag saving', async () => {
    const product = openAiApiPlatformProduct()
    product.offerings.push({ id: 'official-subscription', kind: 'oauth-subscription', authModes: ['oauth'] })
    product.credentials = [
      { id: 'subscription', label: 'Personal', offeringId: 'official-subscription', authMode: 'oauth', enabled: true, priority: 10, health: 'healthy', version: 1 },
      { id: 'key', label: 'Work key', offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: 20, health: 'healthy', version: 1 },
    ]
    const updateProviderCredential = vi.fn(async (_provider, id, patch) => ({
      ...product.credentials.find((credential) => credential.id === id)!,
      priority: patch.priority,
      version: patch.expectedVersion + 1,
    }))
    const quota = vi.fn(async (_provider, _refresh, input) => ({
      credential: input.credentialId, status: 'available' as const,
      balance: input.credentialId === 'key' ? 42 : undefined,
      windows: input.credentialId === 'subscription' ? [{ name: 'weekly', limit: 100, remaining: 75 }] : [],
      observedAt: '2026-09-09T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z', source: 'test',
    }))
    render(<AiConnectionsPanel client={client({ updateProviderCredential, quota })}
      selectedProvider="openai" providerProducts={{ openai: product }} />)
    expect(screen.getAllByLabelText('凭据列表')).toHaveLength(1)
    expect(screen.queryByText('剩余额度')).toBeNull()
    const list = screen.getByLabelText('凭据列表')
    const rowIds = () => Array.from(list.querySelectorAll('[data-sortable-credential]')).map((row) => row.getAttribute('data-sortable-credential'))
    expect(rowIds()).toEqual(['subscription', 'key'])
    const rows = list.querySelectorAll<HTMLElement>('[data-sortable-credential]')
    expect(within(rows[0]).getByRole('group', { name: 'Personal额度' })).toBeTruthy()
    expect(within(rows[1]).getByRole('group', { name: 'Work key额度' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '刷新全部 OpenAI额度' }))
    expect(await within(rows[0]).findByText('周限制 · 剩余 75%')).toBeTruthy()
    expect(await within(rows[1]).findByText('余额：42')).toBeTruthy()
    expect(quota.mock.calls.map((call) => call[2].credentialId).sort()).toEqual(['key', 'subscription'])
    expect(within(rows[0]).queryByText('余额：42')).toBeNull()
    rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      top: index * 60, bottom: (index + 1) * 60, left: 0, right: 500, width: 500, height: 60,
      x: 0, y: index * 60, toJSON() {},
    }))
    const handle = screen.getByRole('button', { name: '拖动排序 Personal' })
    pointer(handle, 'pointerdown', 'mouse', 30)
    pointer(handle, 'pointermove', 'mouse', 90)
    pointer(handle, 'pointerup', 'mouse', 90)
    await waitFor(() => expect(rowIds()).toEqual(['key', 'subscription']))
    expect(updateProviderCredential.mock.calls).toEqual([
      ['openai', 'key', { expectedVersion: 1, priority: 10 }],
      ['openai', 'subscription', { expectedVersion: 1, priority: 20 }],
    ])
    expect(new Set(rowIds()).size).toBe(2)
    expect(within(list).getAllByRole('group', { name: /额度$/ })).toHaveLength(2)
    expect(within(screen.getByRole('group', { name: 'Personal额度' })).getByText('周限制 · 剩余 75%')).toBeTruthy()
    expect(within(screen.getByRole('group', { name: 'Work key额度' })).getByText('余额：42')).toBeTruthy()
  })

  it('cancels a gesture without changing priority', () => {
    const { move } = pool('apiKey')
    const handle = screen.getByRole('button', { name: '拖动排序 First' })
    pointer(handle, 'pointerdown', 'touch', 30)
    pointer(handle, 'pointercancel', 'touch', 150)
    pointer(handle, 'pointerup', 'touch', 150)
    expect(move).not.toHaveBeenCalled()
  })

  it.each([[true, false], [false, true]])('prevents sorting while busy=%s disabled=%s', (busy, disabled) => {
    const { move } = pool('oauth', busy, disabled)
    const handle = screen.getByRole('button', { name: '拖动排序 First' })
    expect(handle.hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(move).not.toHaveBeenCalled()
  })
})


it('locks credential mutations until model sync publishes the updated credential versions', async () => {
  const product = openAiApiPlatformProduct()
  product.credentials = [
    { id: 'first', label: 'First sync key', offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: 10, health: 'healthy', version: 1 },
    { id: 'second', label: 'Second sync key', offeringId: 'api-platform', authMode: 'apiKey', enabled: true, priority: 20, health: 'healthy', version: 1 },
  ]
  let completeDiscovery!: () => void
  const discoveryReady = new Promise<void>((resolve) => { completeDiscovery = resolve })
  const persisted = { ...product, credentials: product.credentials.map((item) => ({ ...item, version: 2 })) }
  const updateProviderCredential = vi.fn(async (_provider, id, patch) => {
    const credential = persisted.credentials.find((item) => item.id === id)!
    if (patch.expectedVersion !== credential.version) throw new Error('credential_version_conflict')
    return { ...credential, priority: patch.priority, version: credential.version + 1 }
  })
  render(<AiConnectionsPanel selectedProvider="openai" providerProducts={{ openai: product }} client={client({
    discoverModels: vi.fn(async () => {
      await discoveryReady
      return { provider: 'openai', credential: 'first', models: [], observedAt: '2026-09-10T00:00:00Z', source: 'fixture' }
    }),
    listProviders: vi.fn(async () => [persisted]),
    updateProviderCredential,
  })} />)
  fireEvent.click(screen.getByRole('button', { name: /同步模型|刷新模型/ }))
  const handle = screen.getByRole('button', { name: '拖动排序 Second sync key' })
  expect(handle.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '编辑 First sync key' }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  expect(updateProviderCredential).not.toHaveBeenCalled()
  completeDiscovery()
  await waitFor(() => expect(handle.hasAttribute('disabled')).toBe(false))
  fireEvent.keyDown(handle, { key: 'ArrowUp' })
  await waitFor(() => expect(updateProviderCredential).toHaveBeenCalledTimes(2))
  expect(updateProviderCredential.mock.calls.map((call) => call[2].expectedVersion)).toEqual([2, 2])
  await waitFor(() => expect(document.querySelector('[data-sortable-credential]')?.getAttribute('data-sortable-credential')).toBe('second'))
})

it('keeps account import beside New and shows import failures without opening a dialog', async () => {
  const onCreateLocalCredential = vi.fn(async () => { throw new Error('导入失败，请重试') })
  const props = {
    definition: PROVIDERS.find((provider) => provider.id === 'openai')!,
    product: { ...openAiApiPlatformProduct(), offerings: [
      { id: 'official-subscription', label: '账号订阅', authModes: ['local' as const] },
      { id: 'api-platform', authModes: ['apiKey' as const] },
    ] },
    status: 'configured' as const, apiKey: '', busy: false,
    onApiKeyChange: vi.fn(), onBeginApiKey: vi.fn(), onBeginBrowser: vi.fn(),
    onSaveApiKey: vi.fn(), onDisconnect: vi.fn(), onCreateLocalCredential,
  }
  const { rerender } = render(<AiCredentialPoolSection {...props} />)
  const header = screen.getByRole('heading', { name: '当前连接' }).parentElement!
  expect(within(header).getByRole('button', { name: '新建 API Key 连接' })).toBeTruthy()
  const importButton = within(header).getByRole('button', { name: '已有登录态' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(importButton)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '导入失败，请重试')
  expect(screen.queryByRole('dialog')).toBeNull()
  rerender(<AiCredentialPoolSection {...props} disabled />)
  expect(importButton).toHaveProperty('disabled', true)
  fireEvent.click(importButton)
  expect(onCreateLocalCredential).toHaveBeenCalledTimes(1)
})
