// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { Toaster } from '@undefineds.co/shared-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiGatewayKeysSection } from '../src/AiGatewayKeysSection'
import { AiConnectionsPanel } from '../src/AiConnectionsPanel'
import type { AiConnectionsClient, AiGatewayModel, GatewayKeyRecord } from '@undefineds.co/ai-connections-core/client'
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
const GATEWAY_MODELS: AiGatewayModel[] = [
  { id: 'kimi-k2.5', provider: 'kimi', displayName: 'Kimi K2.5', availability: 'available', capabilities: ['tool_call'] },
  { id: 'deepseek-v4-pro', provider: 'deepseek', availability: 'available' },
  { id: 'glm-4.6', provider: 'zhipu', displayName: 'GLM 4.6', availability: 'unavailable' },
]

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

  it('presents the API Keys page with the provider page skeleton', async () => {
    render(<AiGatewayKeysSection client={client({ listGatewayKeys: vi.fn(async () => []) })} />)
    await screen.findByText('尚未签发 API Key')

    // Header row: mark, name, explanation affordance, link line, status badge.
    expect(screen.getByRole('heading', { name: 'Xpod' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Xpod 说明' })).toBeTruthy()
    const link = screen.getByRole('link', { name: /访问 Xpod/ })
    expect(link.getAttribute('href')).toBe('https://pod.example')
    expect(screen.getByText('未配置')).toBeTruthy()
    // The explanation moved into the ⓘ tooltip; no loose paragraph is left behind.
    expect(screen.queryByText(/把已接入的 Provider 模型统一发布给编码客户端/)).toBeNull()
    // Xpod is the product name users see; the internal "Gateway" wording is gone.
    expect(document.body.textContent).not.toContain('Gateway')

    // First section: heading with the provider-style ＋ API Key action, empty state, 接入信息.
    expect(screen.getByRole('heading', { name: '当前连接' })).toBeTruthy()
    const create = screen.getByRole('button', { name: '新建 API Key' })
    expect(create.textContent).toBe('API Key')
    expect(screen.getByText('接入信息')).toBeTruthy()

    // Second section: the models the Xpod publishes, in the provider model-list anatomy.
    expect(screen.getByRole('heading', { name: '可用模型' })).toBeTruthy()
    expect(screen.getByPlaceholderText('搜索模型...')).toBeTruthy()
    expect(screen.getByText('Xpod 模型目录尚未就绪')).toBeTruthy()
  })

  it('lists every protocol Xpod accepts, each copying its own address', async () => {
    render(<AiGatewayKeysSection client={client()} />)
    await screen.findByText('Work laptop', { exact: true })

    const access = screen.getByRole('region', { name: 'Xpod 接入信息' })
    // One chip per accepted protocol, named the way the client's own docs name
    // it. The two OpenAI protocols share the /v1 base, so the address says less
    // here than the protocol does and is only carried by the copy affordance.
    expect(within(access).getByText('OpenAI Chat 兼容')).toBeTruthy()
    expect(within(access).getByText('OpenAI Responses 兼容')).toBeTruthy()
    expect(within(access).getByText('Anthropic Messages 兼容')).toBeTruthy()
    expect(within(access).queryByText('https://pod.example/v1')).toBeNull()

    fireEvent.click(within(access).getByRole('button', { name: '复制 OpenAI Chat 兼容 地址' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://pod.example/v1'))
    expect(within(access).getByRole('button', { name: '复制 OpenAI Chat 兼容 地址' }).textContent).toContain('已复制')

    fireEvent.click(within(access).getByRole('button', { name: '复制 Anthropic Messages 兼容 地址' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('https://pod.example'))
  })

  it('explains what these keys are through the header affordance', async () => {
    render(<AiGatewayKeysSection client={client({ listGatewayKeys: vi.fn(async () => []) })} />)
    const explanation = screen.getByRole('button', { name: 'Xpod 说明' })
    fireEvent.focus(explanation)
    expect(await screen.findByText(/把已接入的 Provider 模型统一发布给编码客户端/)).toBeTruthy()
    expect(screen.getByText(/Xpod 不保存明文/)).toBeTruthy()
    // Same line shape as the Provider pages: what it is, then how it is protected.
    expect(screen.getByText('API Key 保存在当前 Pod，由 Pod 权限保护；Xpod 不保存明文。')).toBeTruthy()
  })

  it('still opens the ⓘ on hover after a capability tooltip in the model list went in transit', async () => {
    render(<AiGatewayKeysSection client={client()} gatewayModels={GATEWAY_MODELS} />)
    await screen.findByText('Kimi K2.5')

    // Entering the model list and leaving a capability glyph sets Radix's
    // per-provider "pointer in transit" flag; it must not swallow the ⓘ hover.
    const glyph = screen.getByRole('button', { name: '函数调用' })
    fireEvent.pointerMove(glyph, { pointerType: 'mouse', clientX: 10, clientY: 10 })
    expect(await screen.findByText('函数调用')).toBeTruthy()
    fireEvent.pointerLeave(glyph, { pointerType: 'mouse', clientX: 10, clientY: 10 })

    fireEvent.pointerMove(screen.getByRole('button', { name: 'Xpod 说明' }), {
      pointerType: 'mouse', clientX: 10, clientY: 10,
    })
    expect(await screen.findByText(/把已接入的 Provider 模型统一发布给编码客户端/, {}, { timeout: 2000 })).toBeTruthy()
  })

  it('lists the models the Gateway publishes to clients without offering selection', async () => {
    render(<AiGatewayKeysSection client={client()} gatewayModels={GATEWAY_MODELS} />)
    await screen.findByText('Work laptop', { exact: true })
    const models = screen.getByRole('region', { name: '可用模型' })

    expect(within(models).getByText('共 3 · 已失效 1')).toBeTruthy()
    // The provider pages' name-over-id tile, so one model reads the same on
    // both pages: the display name first, its id muted underneath.
    expect(within(models).getByText('Kimi K2.5')).toBeTruthy()
    expect(within(models).getByText('kimi-k2.5')).toBeTruthy()
    expect(within(models).getByText('GLM 4.6')).toBeTruthy()
    expect(within(models).getByText('glm-4.6')).toBeTruthy()
    expect(within(models).getByText('deepseek-v4-pro')).toBeTruthy()
    expect(within(models).getByText('已失效')).toBeTruthy()
    // A model without a display name keeps its single id line.
    expect(within(models).getAllByText('deepseek-v4-pro')).toHaveLength(1)
    // Selection belongs to the provider pages; this list is read-only.
    // Read-only list: it has no enable toggle unless the host passes a selection.
    expect(within(models).queryByRole('button', { name: /^(启用|停用) / })).toBeNull()
    expect(within(models).queryByText('全选当前结果')).toBeNull()
    // The provider badge is provider-page chrome; the tile stays identical to
    // the provider page, which lists one provider and carries no such badge.
    expect(within(models).queryByText('Kimi', { exact: true })).toBeNull()
    expect(within(models).queryByText('DeepSeek', { exact: true })).toBeNull()
  })

  it('filters the published models and falls back to the dashed panel', async () => {
    render(<AiGatewayKeysSection client={client()} gatewayModels={GATEWAY_MODELS} />)
    await screen.findByText('Work laptop', { exact: true })

    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: 'glm' } })
    expect(screen.getByText('GLM 4.6')).toBeTruthy()
    expect(screen.queryByText('Kimi K2.5')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('搜索模型...'), { target: { value: '没有这个模型' } })
    expect(screen.getByText('未找到匹配的模型')).toBeTruthy()
  })

  it('renders the models area even when the gateway publishes nothing', async () => {
    const view = render(<AiGatewayKeysSection client={client()} gatewayModels={[]} />)
    await screen.findByText('Work laptop', { exact: true })
    expect(screen.getByRole('heading', { name: '可用模型' })).toBeTruthy()
    expect(screen.getByText('暂无可用模型')).toBeTruthy()

    view.rerender(<><AiGatewayKeysSection client={client()} /><Toaster /></>)
    expect(await screen.findByText('Xpod 模型目录尚未就绪')).toBeTruthy()
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
    const section = screen.getByRole('region', { name: '当前连接' })
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

describe('Xpod model list selection', () => {
  it('withdraws and republishes a model through the same selection the provider pages write', async () => {
    const saveModelSelection = vi.fn(async () => undefined)
    render(
      <AiConnectionsPanel
        client={client({
          saveModelSelection,
          // The projection names the model by id; the Pod stores the selection
          // as the model's resource, so both sides have to key on the same one.
          listModels: vi.fn(async () => [{ id: 'gpt-5', provider: 'openai' as const, resourceId: 'openai.ttl#gpt-5' }]),
          listGatewayModels: vi.fn(async () => [{ id: 'gpt-5', provider: 'openai' as const, displayName: 'GPT-5' }]),
        })}
        selectedSection="keys"
        providerProducts={{
          openai: {
            id: 'openai',
            name: 'OpenAI',
            status: 'available',
            offerings: [],
            credentials: [],
            selectedModels: [{ id: 'gpt-5', provider: 'openai', resourceId: 'openai.ttl#gpt-5' }],
          },
        }}
      />,
    )

    // 停用 withdraws it from the models list endpoint, which is the account's
    // selection; 启用 puts it back.
    const disable = await screen.findByRole('button', { name: '停用 GPT-5' })
    fireEvent.click(disable)
    await waitFor(() => expect(saveModelSelection).toHaveBeenLastCalledWith('openai', []))

    const enable = await screen.findByRole('button', { name: '启用 GPT-5' })
    fireEvent.click(enable)
    await waitFor(() => expect(saveModelSelection).toHaveBeenLastCalledWith(
      'openai',
      [{ id: 'gpt-5', resourceId: 'openai.ttl#gpt-5' }],
    ))
  })
})
