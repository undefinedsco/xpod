// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiConnectionsMain,
  AiCredentialPoolSection,
  AiConnectionsPanel,
  PROVIDERS,
  type AiConnectionsController,
  type AiClientConfigurationBridge,
  type AiConnectionsClient,
  type AiProviderSummary,
} from '../src'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import { createAiConnectionsController } from '../src/controller'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

beforeEach(() => {
  vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
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
      plaintext: 'xpod_once_secret',
      record: {
        id: 'key-1',
        owner: WEB_ID,
        scopes: ['models:read', 'inference:write'],
        createdAt: '2026-07-24T00:00:00.000Z',
        name: input.name,
      },
    })),
    revokeGatewayKey: vi.fn(async () => undefined),
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

describe('AI Connection settings', () => {
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

    expect(screen.getByRole('alert').textContent).toContain('当前 Pod 尚未就绪')
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
        error={{ offeringId: offering.id, message: 'Kimi 账号登录已过期' }}
        onApiKeyChange={() => undefined}
        onBeginApiKey={() => undefined}
        onBeginBrowser={() => undefined}
        onSaveApiKey={() => undefined}
        onDisconnect={() => undefined}
        onBeginOffering={() => undefined}
      />,
    )

    expect(screen.getByText('登录未完成')).toBeTruthy()
  })

  it('describes the current Pod protection accurately before a credential is added', () => {
    render(<AiConnectionsPanel client={client()} selectedProvider="openai" serviceAccessGranted />)

    expect(screen.getByText('Provider 凭证保存在当前 Pod，由 Pod 权限保护。')).toBeTruthy()
    expect(screen.queryByText(/加密保存在当前 Pod/)).toBeNull()
  })
  it('shows one selected Provider without repeating the Applet header or WebID hero', async () => {
    render(<AiConnectionsPanel client={client()} selectedProvider="openai" serviceAccessGranted />)

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
        serviceAccessGranted
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
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy()
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
        serviceAccessGranted
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
    expect(screen.getByRole('button', { name: '更新 API Key' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '更新 API Key' }))
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
        serviceAccessGranted
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
    expect(screen.getByRole('heading', { name: 'API Key' })).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.getByText('a***e@example.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加账号' })).toBeTruthy()
    expect(screen.queryByLabelText(/client.?id/i)).toBeNull()
  })

  it('shows a pending OAuth attempt only in the offering that started it', async () => {
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
        serviceAccessGranted
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

    const consumer = screen.getByRole('heading', { name: 'Consumer Subscription' }).closest('section')!
    const team = screen.getByRole('heading', { name: 'Team Subscription' }).closest('section')!
    fireEvent.click(within(consumer).getByRole('button', { name: '登录' }))

    expect(await within(consumer).findByText('正在连接')).toBeTruthy()
    expect(within(team).queryByText('正在连接')).toBeNull()
    expect(within(team).getByRole('button', { name: '登录' })).toBeTruthy()
  })

  it('shows operational metadata and management links for each offering', async () => {
    render(<AiConnectionsPanel client={client()} selectedProvider="openai" serviceAccessGranted providerProducts={{
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

    expect(await screen.findByText('OpenAI Platform')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'API 平台' })).toBeTruthy()
    expect(screen.queryByText(/Responses.*Chat Completions/)).toBeNull()
    expect(screen.queryByText('https://api.openai.com/v1')).toBeNull()
    expect(screen.getByRole('link', { name: '控制台' })).toHaveProperty('href', 'https://platform.openai.com/api-keys')
    expect(screen.getByRole('link', { name: '订阅与账单' })).toHaveProperty('href', 'https://platform.openai.com/billing')
    expect(screen.getByRole('link', { name: '额度与用量' })).toHaveProperty('href', 'https://platform.openai.com/usage')
    expect(screen.getByRole('link', { name: '使用政策' })).toHaveProperty('href', 'https://openai.com/policies/usage-policies/')
  })

  it('renders unavailable offerings without login or API-key actions', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'unconfigured', credentials: [], selectedModels: [],
        offerings: [{
          id: 'official-subscription',
          label: 'Codex Subscription',
          kind: 'oauth-subscription',
          lifecycle: 'unavailable',
          authModes: ['oauth'],
        }],
      },
    }} />)

    expect(await screen.findByRole('heading', { name: 'Codex Subscription' })).toBeTruthy()
    expect(screen.getByText('暂不可用：该 Offering 尚未提供可用的连接流程。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull()
    expect(screen.queryByRole('button', { name: '添加 API Key' })).toBeNull()
    expect(screen.queryByRole('button', { name: /配置 API Key/ })).toBeNull()
    expect(current.beginConnect).not.toHaveBeenCalled()
    expect(current.createApiKeyCredential).not.toHaveBeenCalled()
  })

  it('logs out the selected OAuth credential row without showing fake switch actions', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="kimi"
        serviceAccessGranted
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

  it('uses the shared Provider OAuth failure view for recoverable auth failures', async () => {
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
        serviceAccessGranted
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

    expect(await screen.findByText('登录未完成')).toBeTruthy()
    expect(screen.getByText('Kimi 账号登录已过期')).toBeTruthy()
    expect(screen.queryByLabelText(/client.?id/i)).toBeNull()
    expect(screen.getAllByText('剩余额度')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '刷新 Kimi Kimi 账号额度' })).toHaveLength(1)
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
        serviceAccessGranted
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
    expect(screen.getAllByRole('button', { name: '添加 API Key' })).toHaveLength(2)
  })

  it('creates a token-plan credential with only its key and offering endpoint visible', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="bailian"
        serviceAccessGranted
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

    expect(await screen.findByRole('heading', { name: 'Token Plan Personal' })).toBeTruthy()
    expect(await screen.findByText('token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '添加 API Key' }))

    const keyInput = screen.getByLabelText('百炼 API Key 输入')
    expect(keyInput).toHaveProperty('type', 'password')
    expect(keyInput.getAttribute('autocomplete')).toBe('new-password')
    expect(keyInput.getAttribute('data-lpignore')).toBe('true')
    expect(screen.queryByLabelText('百炼 API Key 标签')).toBeNull()
    expect(screen.queryByLabelText('百炼 Base URL 输入')).toBeNull()

    fireEvent.change(keyInput, { target: { value: 'sk-token-plan-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 百炼 API Key' }))

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
        serviceAccessGranted
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

    fireEvent.click(await screen.findByRole('button', { name: '刷新 百炼 PAYG额度' }))
    await waitFor(() => expect(quota).toHaveBeenCalledWith('bailian', true, {
      offeringId: 'pay-as-you-go',
      credentialId: 'payg-key',
      credentialIri: 'payg-key',
    }))

    fireEvent.click(screen.getByRole('button', { name: '刷新 百炼 Token Plan额度' }))
    await waitFor(() => expect(quota).toHaveBeenCalledWith('bailian', true, {
      offeringId: 'token-plan',
      credentialId: 'token-key',
      credentialIri: 'token-key',
    }))

    const paygItem = screen.getByRole('heading', { name: 'PAYG' }).closest('section')!
    const tokenItem = screen.getByRole('heading', { name: 'Token Plan' }).closest('section')!
    expect(await within(paygItem).findByText('余额：42')).toBeTruthy()
    expect(within(paygItem).getByText('来源：bailian:pay-as-you-go')).toBeTruthy()
    expect(await within(tokenItem).findByText('周限制')).toBeTruthy()
    expect(within(tokenItem).getByText('来源：bailian:token-plan')).toBeTruthy()
    expect(within(paygItem).queryByText('周限制')).toBeNull()
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
          'api-platform': {
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

    expect(screen.getByText('凭证：Backup key')).toBeTruthy()
    expect(screen.getByText('尚未检查')).toBeTruthy()
    expect(screen.queryByText('余额：99')).toBeNull()
    expect(screen.queryByText('来源：openai:primary-key')).toBeNull()
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
        serviceAccessGranted
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

    const official = screen.getByRole('heading', { name: 'Official Subscription' }).closest('section')!
    const tokenPlan = screen.getByRole('heading', { name: 'Token Plan' }).closest('section')!
    const apiPlatform = screen.getByRole('heading', { name: 'API Platform' }).closest('section')!
    expect(within(official).getByText('api.kimi.com/coding/v1')).toBeTruthy()
    expect(within(official).getByText('api.kimi.com/coding')).toBeTruthy()
    expect(within(official).getByText('Chat API')).toBeTruthy()
    expect(within(official).getByText('Anthropic API')).toBeTruthy()
    expect(within(tokenPlan).getByText('api.kimi.com/coding/v1')).toBeTruthy()
    expect(within(tokenPlan).getByText('api.kimi.com/coding')).toBeTruthy()
    expect(within(apiPlatform).getByText('api.moonshot.ai/v1')).toBeTruthy()

    fireEvent.click(within(tokenPlan).getByRole('button', { name: '刷新 Kimi Token Plan额度' }))
    expect(await within(tokenPlan).findByText('5 小时限制')).toBeTruthy()
    expect(within(tokenPlan).getByText('周限制')).toBeTruthy()
    expect(within(apiPlatform).queryByText('5 小时限制')).toBeNull()

    fireEvent.click(within(apiPlatform).getByRole('button', { name: '刷新 Kimi API Platform额度' }))
    expect(await within(apiPlatform).findByText('可用余额')).toBeTruthy()
    expect(within(apiPlatform).getByText('剩余 12.5 CNY')).toBeTruthy()
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
        serviceAccessGranted
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
    expect(screen.getAllByText('启用').length).toBeGreaterThan(0)
    expect(screen.getByText('有效')).toBeTruthy()
    expect(screen.getAllByText('停用').length).toBeGreaterThan(0)
    expect(screen.getByText('未验证')).toBeTruthy()
    expect(screen.getByRole('button', { name: '停用 Primary key' }).textContent).toContain('停用')
    expect(screen.getByRole('button', { name: '启用 Backup key' }).textContent).toContain('启用')
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
        serviceAccessGranted
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

    fireEvent.click(await screen.findByRole('button', { name: '添加 API Key' }))
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
    expect(screen.getByText('Primary key')).toBeTruthy()
    expect(await screen.findByText('API Key · sk-...new')).toBeTruthy()
    expect(await screen.findByText('openai Model 1')).toBeTruthy()
    expect(document.body.textContent).not.toContain('sk-work-secret')
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
        serviceAccessGranted
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

    fireEvent.click(await screen.findByRole('button', { name: '添加 API Key' }))
    fireEvent.change(screen.getByLabelText('OpenAI API Key 输入'), { target: { value: 'sk-work-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 OpenAI API Key' }))

    expect(await screen.findByText('API Key · sk-...new')).toBeTruthy()
    expect(await screen.findByText('AI Connection request failed. Please try again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '同步模型' })).toBeTruthy()
  })

  it('edits, toggles, deletes, tests, and reorders individual API key credentials', async () => {
    const current = client()
    render(
      <AiConnectionsPanel
        client={current}
        selectedProvider="openai"
        serviceAccessGranted
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

    fireEvent.click(screen.getByRole('button', { name: '上移 Backup key' }))
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
        serviceAccessGranted
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
        serviceAccessGranted
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
    render(<AiConnectionsPanel client={client()} selectedProvider="openai" serviceAccessGranted />)

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
        serviceAccessGranted
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
        serviceAccessGranted
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
    render(<AiConnectionsPanel client={current} openExternal={openExternal} serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
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
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))

    expect(await screen.findByText('连接已过期，请重新开始')).toBeTruthy()
    expect(screen.queryByLabelText('OpenAI API Key 输入')).toBeNull()
  })

  it('does not render raw secret material from provider errors', async () => {
    const current = client({
      beginConnect: vi.fn(async () => {
        throw new Error('upstream failed sk-live-secret xpod_once_secret apiKey=secret token=secret Authorization: Bearer secret {"secret":"json-secret"}')
      }),
    })
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))

    expect(await screen.findByText('AI Connection request failed. Please try again.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/sk-|xpod_|apiKey|token|Bearer|json-secret/)
  })

  it('states unsupported quota honestly', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} serviceAccessGranted providerProducts={{
      openai: openAiApiPlatformProduct(),
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API Key额度' }))

    await waitFor(() => expect(current.quota).toHaveBeenCalledWith('openai', true, {
      offeringId: 'api-platform',
      credentialId: 'openai-api-key',
      credentialIri: 'openai-api-key',
    }))
    expect(screen.getByText('官方额度接口不支持')).toBeTruthy()
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
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'available', selectedModels: [],
        offerings: [{ id: 'official-subscription', kind: 'oauth-subscription', authModes: ['oauth'] }],
        credentials: [{
          id: 'openai-subscription', offeringId: 'official-subscription', authMode: 'oauth',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI 账号订阅额度' }))

    expect(await screen.findByText('5 小时限制')).toBeTruthy()
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
    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted providerProducts={{
      openai: {
        id: 'openai', name: 'OpenAI', status: 'available', selectedModels: [],
        offerings: [{ id: 'api-platform', kind: 'api-platform', authModes: ['apiKey'] }],
        credentials: [{
          id: 'openai-api-platform', offeringId: 'api-platform', authMode: 'apiKey',
          enabled: true, priority: 10, health: 'healthy', version: 1,
        }],
      },
    }} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API 平台额度' }))

    expect(await screen.findByText('余额：18.75')).toBeTruthy()
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
      serviceAccessGranted
      providerProducts={{ openai: openAiApiPlatformProduct() }}
    />)

    fireEvent.click(screen.getByRole('button', { name: '刷新 OpenAI API Key额度' }))

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

    render(<AiConnectionsPanel client={current} selectedProvider="openai" serviceAccessGranted />)

    expect(await screen.findByText('GPT-5.4')).toBeTruthy()
    expect(screen.queryByText('Claude Sonnet 4.5')).toBeNull()
    expect(current.listModels).toHaveBeenCalledOnce()
  })

  it('displays a created Gateway key once and removes it when acknowledged', async () => {
    const current = client()
    render(<AiConnectionsPanel client={current} serviceAccessGranted />)

    fireEvent.change(screen.getByLabelText('客户端凭证名称'), {
      target: { value: 'Codex' },
    })
    fireEvent.click(screen.getByRole('button', { name: '创建客户端凭证' }))

    expect(await screen.findByText('xpod_once_secret')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '我已保存，隐藏密钥' }))
    expect(screen.queryByText('xpod_once_secret')).toBeNull()
    expect(screen.getAllByText('Codex')).toHaveLength(2)
  })

  it('uses client credential terminology throughout the user-facing advanced path', async () => {
    render(<AiConnectionsPanel client={client()} serviceAccessGranted />)
    expect(await screen.findByText('高级：客户端凭证管理')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '客户端凭证管理' })).toBeTruthy()
    expect(screen.getByLabelText('客户端凭证名称')).toBeTruthy()
    expect(screen.getByRole('button', { name: '创建客户端凭证' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('Gateway Key')
  })

  it('creates a managed Gateway key when configuring a client without exposing it', async () => {
    const plan = vi.fn(async () => ({
      planId: 'plan-1',
      client: 'codex' as const,
      changes: [{
        target: '~/.codex/config.toml',
        action: 'update' as const,
        backup: true,
      }],
    }))
    const apply = vi.fn(async () => ({ applied: true as const }))
    const verify = vi.fn(async () => ({ status: 'configured' as const }))
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan,
      apply,
      verify,
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    render(<AiConnectionsPanel client={current} clientConfigurationBridge={bridge} serviceAccessGranted />)

    expect(screen.getByRole('heading', { name: '客户端凭证' })).toBeTruthy()
    expect(screen.getAllByText(/访问 Xpod/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/不是真实的 Provider API Key/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])

    await waitFor(() => expect(plan).toHaveBeenCalledWith({
      client: 'codex',
      endpoint: 'https://pod.example',
    }))
    expect(current.createGatewayKey).not.toHaveBeenCalled()
    expect(screen.getByText('~/.codex/config.toml')).toBeTruthy()
    expect(screen.queryByText(/xpod_once_secret/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '应用 Codex 配置' }))
    await waitFor(() => expect(current.createGatewayKey).toHaveBeenCalledWith({
      name: 'AI Connection · Codex',
    }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      client: 'codex',
      planId: 'plan-1',
      gatewayKey: 'xpod_once_secret',
    }))
    expect(verify).toHaveBeenCalledWith({ client: 'codex', planId: 'plan-1' })
    expect(current.revokeGatewayKey).not.toHaveBeenCalled()
  })

  it('requires explicit replacement confirmation before applying a risky client plan', async () => {
    const plan = vi.fn(async () => ({
      planId: 'plan-pi',
      client: 'pi' as const,
      confirmation: {
        required: true,
        token: 'confirm-plan-pi-target',
        targetHash: 'target-hash-pi',
        message: 'Pi will replace the active default model.',
      },
      changes: [{
        target: '~/.pi/agent/models.json',
        action: 'update' as const,
        backup: true,
      }],
    }))
    const apply = vi.fn(async () => ({ applied: true as const }))
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan,
      apply,
      verify: vi.fn(async () => ({ status: 'configured' as const })),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    render(<AiConnectionsPanel client={current} clientConfigurationBridge={bridge} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[2])
    expect(await screen.findByText('Pi will replace the active default model.')).toBeTruthy()
    expect(screen.getByText('confirm-plan-pi-target')).toBeTruthy()
    expect((screen.getByRole('button', { name: '确认并应用 Pi 配置' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('输入确认码以应用 Pi 配置'), {
      target: { value: 'confirm-plan-pi-target' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认并应用 Pi 配置' }))

    await waitFor(() => expect(apply).toHaveBeenCalledWith({
      client: 'pi',
      planId: 'plan-pi',
      gatewayKey: 'xpod_once_secret',
      confirmation: {
        token: 'confirm-plan-pi-target',
        targetHash: 'target-hash-pi',
      },
    }))
  })

  it('surfaces verification rollback as a distinct failed-and-restored client state', async () => {
    class RestoredError extends Error {
      public readonly code = 'verification_failed_restored'
      public readonly status = 502
      public readonly details = { restored: true }
    }
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan: vi.fn(async () => ({
        planId: 'plan-restored',
        client: 'codex' as const,
        changes: [{
          target: '~/.codex/config.toml',
          action: 'update' as const,
          backup: true,
        }],
      })),
      apply: vi.fn(async () => {
        throw new RestoredError('verification_failed_restored')
      }),
      verify: vi.fn(),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    render(<AiConnectionsPanel client={current} clientConfigurationBridge={bridge} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    fireEvent.click(await screen.findByRole('button', { name: '应用 Codex 配置' }))

    expect(await screen.findByText('配置验证失败，已自动恢复原配置。')).toBeTruthy()
    expect(screen.getByText('已恢复')).toBeTruthy()
  })

  it('revokes a managed Gateway key when native Apply fails', async () => {
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan: vi.fn(async () => ({
        planId: 'plan-failure',
        client: 'codex' as const,
        changes: [],
      })),
      apply: vi.fn(async () => {
        throw new Error('Mock Apply failed')
      }),
      verify: vi.fn(),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client()
    render(<AiConnectionsPanel client={current} clientConfigurationBridge={bridge} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    await screen.findByRole('button', { name: '应用 Codex 配置' })
    fireEvent.click(screen.getByRole('button', { name: '应用 Codex 配置' }))

    await waitFor(() => expect(current.revokeGatewayKey).toHaveBeenCalledWith('key-1'))
    expect(bridge.verify).not.toHaveBeenCalled()
  })

  it('surfaces a manual recovery path when Apply and automatic key revocation both fail', async () => {
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan: vi.fn(async () => ({
        planId: 'plan-double-failure',
        client: 'codex' as const,
        changes: [],
      })),
      apply: vi.fn(async () => {
        throw new Error('Mock Apply failed')
      }),
      verify: vi.fn(),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client({
      revokeGatewayKey: vi.fn(async () => {
        throw new Error('Mock revoke failed')
      }),
    })
    render(<AiConnectionsPanel client={current} clientConfigurationBridge={bridge} serviceAccessGranted />)

    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    fireEvent.click(await screen.findByRole('button', { name: '应用 Codex 配置' }))

    expect(await screen.findByText(/自动撤销客户端凭证失败/)).toBeTruthy()
    expect(screen.getByText(/请在“高级：客户端凭证管理”中手动撤销/)).toBeTruthy()
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
        serviceAccessGranted
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

  it('fails closed by default and does not call mutation APIs before service access is granted', async () => {
    const plan = vi.fn(async () => ({
      planId: 'plan-1',
      client: 'codex' as const,
      changes: [{
        target: '~/.codex/config.toml',
        action: 'update' as const,
        backup: true,
      }],
    }))
    const bridge: AiClientConfigurationBridge = {
      inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
      plan,
      apply: vi.fn(async () => ({ applied: true as const })),
      verify: vi.fn(async () => ({ status: 'configured' as const })),
      restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
    }
    const current = client({
      listGatewayKeys: vi.fn(async () => [{
        id: 'key-1',
        owner: WEB_ID,
        scopes: ['models:read'],
        createdAt: '2026-07-24T00:00:00.000Z',
        name: 'Codex',
      }]),
    })

    render(<AiConnectionsPanel client={current} clientConfigurationBridge={bridge} />)

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI API Key' }))
    fireEvent.click(screen.getByRole('button', { name: '创建客户端凭证' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销 Codex' }))
    fireEvent.click(screen.getAllByRole('button', { name: '配置' })[0])
    await waitFor(() => expect(plan).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '应用 Codex 配置' }))

    expect(current.beginConnect).not.toHaveBeenCalled()
    expect(current.completeApiKey).not.toHaveBeenCalled()
    expect(current.createGatewayKey).not.toHaveBeenCalled()
    expect(current.revokeGatewayKey).not.toHaveBeenCalled()
    expect(bridge.apply).not.toHaveBeenCalled()
    expect(bridge.verify).not.toHaveBeenCalled()
  })
})
