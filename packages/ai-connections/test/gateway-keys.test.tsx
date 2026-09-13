// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { Toaster } from '@undefineds.co/shared-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiGatewayKeysSection } from '../src/AiGatewayKeysSection'
import { AiConnectionsPanel } from '../src/AiConnectionsPanel'
import type { AiConnectionsClient, GatewayKeyRecord } from '../src/ai-connections-client'
import type {
  AiClientConfigurationBridge,
  AiConnectionsClientId,
} from '../src/AiClientConfigurationSection'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const APPLIED: GatewayKeyRecord = {
  id: 'applied-key',
  kind: 'client-credentials',
  clientCredentialId: 'xpod-work-laptop',
  owner: WEB_ID,
  scopes: ['models:read', 'chat:write'],
  createdAt: '2026-08-25T00:00:00.000Z',
  lastUsedAt: '2026-08-26T03:04:05.000Z',
  name: 'Work laptop',
  maskedHint: '********abcd1234',
  appliedTo: 'codex',
  appliedOn: 'desktop',
}
const UNBOUND: GatewayKeyRecord = {
  ...APPLIED,
  id: 'spare-key',
  name: 'Spare',
  lastUsedAt: undefined,
  appliedTo: undefined,
  appliedOn: undefined,
}

describe('Xpod API Keys', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })
  })

  afterEach(() => {
    for (const close of screen.queryAllByRole('button', { name: '关闭通知', hidden: true })) fireEvent.click(close)
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('presents the API Keys page as the Xpod provider page', async () => {
    render(<AiGatewayKeysSection client={client({ listGatewayKeys: vi.fn(async () => []) })} />)
    await screen.findByText('尚未签发 API Key。')

    // Same chrome as AiProviderCard: mark, title, one-line description, status badge.
    expect(screen.getByRole('heading', { name: 'Xpod' })).toBeTruthy()
    expect(screen.getByText('XP')).toBeTruthy()
    expect(screen.getByText(/API Key 用于让客户端把 Xpod 当作 Provider 接入/)).toBeTruthy()
    expect(screen.getByText('未配置')).toBeTruthy()
    // Section chrome mirrors AiCredentialPoolSection: h3 header with the primary action beside it.
    expect(screen.getByRole('heading', { name: '已签发 API Key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建 API Key' })).toBeTruthy()
    // The old intro paragraph and the border-b toolbar row are gone.
    expect(screen.queryByText(/API Key 用于访问 Xpod Gateway/)).toBeNull()
  })

  it('counts the issued keys in the header badge', async () => {
    render(<AiGatewayKeysSection client={client()} />)
    await screen.findByText('Work laptop', { exact: true })
    expect(screen.getByText('已签发 2 个')).toBeTruthy()
  })

  it('records only the purpose, the binding, the last use, and destruction', async () => {
    render(<AiGatewayKeysSection client={client()} />)
    const row = (await screen.findByText('Work laptop', { exact: true })).closest('li')!
    expect(row.getAttribute('data-key-binding')).toBe('bound')
    expect(within(row).getByText('用途')).toBeTruthy()
    expect(within(row).getByText('Codex · desktop')).toBeTruthy()
    expect(within(row).getByText(new Date(APPLIED.lastUsedAt!).toLocaleString())).toBeTruthy()
    expect(within(row).getByRole('button', { name: '销毁 Work laptop' })).toBeTruthy()
  })

  it('shows an unbound key without a call record', async () => {
    render(<AiGatewayKeysSection client={client()} />)
    const row = (await screen.findByText('Spare', { exact: true })).closest('li')!
    expect(row.getAttribute('data-key-binding')).toBe('unbound')
    expect(within(row).getByText('未绑定')).toBeTruthy()
    expect(within(row).getByText('暂无调用记录')).toBeTruthy()
  })

  it('offers no enable, apply, or copy affordance on existing rows', async () => {
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={configurationBridge()} />)
    await screen.findByText('Work laptop', { exact: true })

    expect(screen.queryByRole('button', { name: '停用 Work laptop' })).toBeNull()
    expect(screen.queryByRole('button', { name: '启用 Work laptop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Work laptop 客户端配置' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Work laptop 应用到/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '复制 Work laptop' })).toBeNull()
    expect(screen.queryByRole('button', { name: /刷新 Work laptop 的/ })).toBeNull()
  })

  it('destroys a key from its row and drops it from the list', async () => {
    const current = client()
    render(<AiGatewayKeysSection client={current} />)
    fireEvent.click(await screen.findByRole('button', { name: '销毁 Work laptop' }))
    await waitFor(() => expect(current.deleteGatewayKey).toHaveBeenCalledWith('applied-key'))
    await waitFor(() => expect(screen.queryByText('Work laptop', { exact: true })).toBeNull())
    expect(screen.getByText('Spare', { exact: true })).toBeTruthy()
  })

  it('keeps an unrevocable client credential visible and explains why', async () => {
    const current = client({
      listGatewayKeys: vi.fn(async () => [{ ...APPLIED, clientCredentialId: undefined }]),
    })
    render(<AiGatewayKeysSection client={current} />)
    expect(await screen.findByText('Work laptop', { exact: true })).toBeTruthy()
    expect(screen.getByText('缺少 CSS 凭据标识，无法在此销毁')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '销毁 Work laptop' })).toBeNull()
  })

  it('reports a failed destruction outside the key list without dropping the row', async () => {
    const current = client()
    vi.mocked(current.deleteGatewayKey).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<AiGatewayKeysSection client={current} />)
    await screen.findByText('Work laptop', { exact: true })
    const section = screen.getByRole('region', { name: '已签发 API Key' })
    const originalChildren = Array.from(section.children)
    fireEvent.click(screen.getByRole('button', { name: '销毁 Work laptop' }))
    const notification = await screen.findByText('无法连接配置服务，请检查连接后重试。')
    expect(notification.closest('[role="status"]')).not.toBeNull()
    expect(section.contains(notification)).toBe(false)
    expect(Array.from(section.children)).toEqual(originalChildren)
    expect(screen.getByText('Work laptop', { exact: true })).toBeTruthy()
  })

  it('asks for the purpose and sends it as appliedTo when creating', async () => {
    const current = client()
    render(<AiGatewayKeysSection client={current} />)
    await screen.findByText('Work laptop', { exact: true })

    fireEvent.click(screen.getByRole('button', { name: '新建 API Key' }))
    expect(screen.getByRole('dialog', { name: '新建 API Key' })).toBeTruthy()
    expect(screen.getByLabelText('API Key 名称')).toHaveProperty('value', '我的 API Key')
    expect(screen.queryByLabelText('Client ID')).toBeNull()
    expect(screen.queryByLabelText('Client Secret')).toBeNull()

    const create = screen.getByRole('button', { name: '创建 API Key' })
    expect(create).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('API Key 名称'), { target: { value: 'Laptop' } })
    fireEvent.change(screen.getByLabelText('API Key 用途'), { target: { value: 'claude-code' } })
    expect(create).toHaveProperty('disabled', false)
    fireEvent.click(create)

    await screen.findByRole('dialog', { name: 'API Key 已签发' })
    expect(current.createGatewayKey).toHaveBeenCalledWith({ name: 'Laptop', appliedTo: 'claude-code' })
    expect(screen.getByText('已签发「Laptop」，用途：Claude Code。')).toBeTruthy()
  })

  it('keeps copy and apply inside the creation flow and binds the new row to its purpose', async () => {
    const current = client()
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    await createKey()

    // No copy affordance exists on the row; the wrapper is only offered while the flow is open.
    expect(screen.queryByLabelText('API Key 名称')).toBeNull()
    expect(screen.queryByRole('button', { name: '复制 我的 API Key' })).toBeNull()
    const row = screen.getByText('我的 API Key', { exact: true }).closest('li')!
    expect(within(row).getByText('Codex')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '复制 API Key' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('plain-key'))
    expect(document.body.textContent).not.toContain('plain-key')

    fireEvent.click(screen.getByRole('button', { name: '复制 Codex 配置' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('model_providers.xpod')))

    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))
    await screen.findByText(appliedMessage('Codex'))
    expect(bridge.plan).toHaveBeenCalledWith({ client: 'codex', endpoint: current.apiBase })
    expect(bridge.apply).toHaveBeenCalledWith({ client: 'codex', planId: 'plan', apiKey: 'plain-key' })
    expect(screen.getByText('已应用到 Codex')).toBeTruthy()
    // Copying and applying reuse the in-session wrapper; they never issue another key.
    expect(current.createGatewayKey).toHaveBeenCalledTimes(1)
  })

  it('offers the client configuration copy for the declared purpose', async () => {
    const current = client()
    render(<AiGatewayKeysSection client={current} />)
    await createKey('我的 API Key', 'claude-code')
    fireEvent.click(screen.getByRole('button', { name: '复制 Claude Code 配置' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_AUTH_TOKEN')))
  })

  it('applies immediately with the plan confirmation token', async () => {
    const bridge = configurationBridge()
    vi.mocked(bridge.plan).mockResolvedValueOnce({
      client: 'codex',
      planId: 'confirm-plan',
      changes: [{ target: '~/.codex/config.toml', action: 'update', backup: true }],
      confirmation: { required: true, token: 'CONFIRM', targetHash: 'hash', message: '覆盖现有配置' },
    })
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    await createKey()
    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))
    await screen.findByText(appliedMessage('Codex'))
    expect(screen.queryByLabelText('输入应用确认码')).toBeNull()
    expect(bridge.apply).toHaveBeenCalledWith({
      client: 'codex',
      planId: 'confirm-plan',
      apiKey: 'plain-key',
      confirmation: { token: 'CONFIRM', targetHash: 'hash' },
    })
  })

  it('keeps the failure inside the creation flow so it can be retried', async () => {
    const current = client()
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockRejectedValueOnce(new Error('application failed'))
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    await createKey()

    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'application failed')
    expect(screen.queryByText('已应用到 Codex')).toBeNull()
    expect(current.createGatewayKey).toHaveBeenCalledTimes(1)
    expect(current.deleteGatewayKey).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))
    await screen.findByText(appliedMessage('Codex'))
    expect(bridge.apply).toHaveBeenCalledTimes(2)
  })

  it('refuses to hand out the wrapper once the creating session is gone', async () => {
    const bridge = configurationBridge()
    const view = render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    await screen.findByText('Work laptop', { exact: true })
    await createKey()

    // A new client object means a new session: the cached wrapper must not survive it.
    view.rerender(<><AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} /><Toaster /></>)
    fireEvent.click(screen.getByRole('button', { name: '复制 API Key' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      '这个 API Key 只在创建时可见：请销毁它，然后重新创建并立即复制或应用。',
    )
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('resumes the issued flow after the dialog is closed without reissuing', async () => {
    const current = client()
    render(<AiGatewayKeysSection client={current} />)
    await createKey()
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '新建 API Key' }))
    expect(screen.getByRole('dialog', { name: 'API Key 已签发' })).toBeTruthy()
    expect(current.createGatewayKey).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '再建一个' }))
    expect(screen.getByRole('dialog', { name: '新建 API Key' })).toBeTruthy()
    expect(screen.getByLabelText('API Key 用途')).toHaveProperty('value', '')
  })

  it('does not substitute Pod models when the Gateway catalog is unavailable', async () => {
    const current = client({
      listModels: vi.fn(async () => [{ id: 'unselected-pod-model', provider: 'kimi' as const }]),
      listGatewayModels: vi.fn(() => Promise.reject(new Error('catalog unavailable'))),
    })
    const bridge = configurationBridge()
    renderUi(<AiConnectionsPanel client={current} selectedSection="keys" clientConfigurationBridge={bridge} />)
    await waitFor(() => expect(current.listGatewayModels).toHaveBeenCalledTimes(1))
    await createKey()
    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))
    await screen.findByText(appliedMessage('Codex'))
    expect(bridge.plan).toHaveBeenLastCalledWith({ client: 'codex', endpoint: current.apiBase })
    expect(current.listGatewayModels).toHaveBeenCalledTimes(1)
    expect(current.listModels).toHaveBeenCalledTimes(1)
  })

  it('passes only the preloaded Gateway catalog to Codex without fetching during apply', async () => {
    const gatewayModels = [
      { id: 'kimi-k2.5', provider: 'kimi' as const, displayName: 'Kimi K2.5' },
      { id: 'deepseek-v4-pro', provider: 'deepseek' as const },
    ]
    const current = client({
      listModels: vi.fn(async () => [{ id: 'unselected-pod-model', provider: 'kimi' as const }]),
      listGatewayModels: vi.fn(async () => gatewayModels),
    })
    const bridge = configurationBridge()
    renderUi(<AiConnectionsPanel client={current} selectedSection="keys" clientConfigurationBridge={bridge} />)
    await waitFor(() => expect(current.listGatewayModels).toHaveBeenCalledTimes(1))
    await createKey()
    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))
    await screen.findByText('Codex 配置已应用。')
    expect(bridge.plan).toHaveBeenLastCalledWith({ client: 'codex', endpoint: current.apiBase, activeModels: [
      { id: 'kimi-k2.5', provider: 'kimi', displayName: 'Kimi K2.5' },
      { id: 'deepseek-v4-pro', provider: 'deepseek' },
    ] })
    expect(current.listGatewayModels).toHaveBeenCalledTimes(1)
    expect(current.listModels).toHaveBeenCalledTimes(1)
  })
})

function appliedMessage(target: string) {
  return target === 'Codex' ? 'Codex 连接配置已应用，模型目录尚未加载，请稍后刷新配置。' : `${target} 配置已应用。`
}

function render(ui: ReactElement) {
  return renderUi(<>{ui}<Toaster /></>)
}

async function createKey(name = '我的 API Key', purpose: AiConnectionsClientId = 'codex') {
  await screen.findByText('Work laptop', { exact: true })
  fireEvent.click(screen.getByRole('button', { name: '新建 API Key' }))
  fireEvent.change(screen.getByLabelText('API Key 名称'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('API Key 用途'), { target: { value: purpose } })
  fireEvent.click(screen.getByRole('button', { name: '创建 API Key' }))
  await screen.findByRole('dialog', { name: 'API Key 已签发' })
}

function client(overrides: Partial<AiConnectionsClient> = {}): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    listGatewayKeys: vi.fn(async () => [APPLIED, UNBOUND]),
    // The server records the declared purpose with the credential and echoes it.
    createGatewayKey: vi.fn(async (input: { name: string; appliedTo?: string }) => ({
      plaintext: 'plain-key',
      record: {
        ...APPLIED,
        id: 'created-key',
        name: input.name,
        appliedTo: input.appliedTo,
        appliedOn: undefined,
        lastUsedAt: undefined,
      },
    })),
    updateGatewayKey: vi.fn(),
    deleteGatewayKey: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AiConnectionsClient
}

function configurationBridge(): AiClientConfigurationBridge {
  return {
    inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
    plan: vi.fn(async ({ client }) => ({ client, planId: 'plan', changes: [] })),
    apply: vi.fn(async () => ({ applied: true as const })),
    verify: vi.fn(async () => ({ status: 'configured' as const })),
    restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
  }
}
