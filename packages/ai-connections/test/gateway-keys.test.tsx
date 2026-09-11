// @vitest-environment jsdom
import './setup-jsdom'
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { Toaster } from '@undefineds.co/shared-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiGatewayKeysSection } from '../src/AiGatewayKeysSection'
import { AiConnectionsPanel } from '../src/AiConnectionsPanel'
import type { AiConnectionsClient, GatewayKeyRecord } from '../src/ai-connections-client'
import type { AiClientConfigurationBridge, AiClientConfigurationStatus } from '../src/AiClientConfigurationSection'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const active: GatewayKeyRecord = {
  id: 'active-key',
  owner: WEB_ID,
  scopes: ['models:read', 'chat:write'],
  createdAt: '2026-08-25T00:00:00.000Z',
  name: 'Work laptop',
  maskedHint: '********abcd1234',
  plaintextAvailable: true,
  appliedClients: ['codex'],
}
const disabled: GatewayKeyRecord = {
  ...active,
  id: 'disabled-key',
  name: 'Paused client',
  disabledAt: '2026-08-25T01:00:00.000Z',
  appliedClients: [],
}

describe('Xpod API Keys', () => {
  it('passes only the preloaded Gateway catalog to Codex without fetching during apply or refresh', async () => {
    const gatewayModels = [{ id: 'kimi-k2.5', provider: 'kimi' as const, displayName: 'Kimi K2.5' }, { id: 'deepseek-v4-pro', provider: 'deepseek' as const }]
    const current = client({
      listModels: vi.fn(async () => [{ id: 'unselected-pod-model', provider: 'kimi' as const }]),
      listGatewayModels: vi.fn(async () => gatewayModels),
    })
    const bridge = configurationBridge()
    renderUi(<AiConnectionsPanel client={current} selectedSection="keys" clientConfigurationBridge={bridge} />)
    await waitFor(() => expect(current.listGatewayModels).toHaveBeenCalledTimes(1))
    fireEvent.click(await clientCheckbox())
    await screen.findByText('Codex 配置已应用。')
    expect(bridge.plan).toHaveBeenLastCalledWith({ client: 'codex', endpoint: current.apiBase, activeModels: [
      { id: 'kimi-k2.5', provider: 'kimi', displayName: 'Kimi K2.5' }, { id: 'deepseek-v4-pro', provider: 'deepseek' },
    ] })
    fireEvent.click(screen.getByRole('button', { name: '刷新 Work laptop 的 Codex endpoint' }))
    await screen.findByText('Codex endpoint 已刷新。')
    expect(current.listGatewayModels).toHaveBeenCalledTimes(1)
    expect(current.listModels).toHaveBeenCalledTimes(1)
    fireEvent.click(await clientCheckbox('Work laptop', 'Claude Code'))
    await screen.findByText('Claude Code 配置已应用。')
    expect(bridge.plan).toHaveBeenLastCalledWith({ client: 'claude-code', endpoint: current.apiBase })
  })

  it.each(['pending', 'failed'] as const)('does not substitute Pod models when the Gateway catalog is %s', async (state) => {
    const current = client({
      listModels: vi.fn(async () => [{ id: 'unselected-pod-model', provider: 'kimi' as const }]),
      listGatewayModels: vi.fn(() => state === 'pending' ? new Promise(() => undefined) : Promise.reject(new Error('catalog unavailable'))),
    })
    const bridge = configurationBridge()
    renderUi(<AiConnectionsPanel client={current} selectedSection="keys" clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox())
    await screen.findByText(appliedMessage('Codex'))
    expect(bridge.plan).toHaveBeenLastCalledWith({ client: 'codex', endpoint: current.apiBase })
    expect(current.listGatewayModels).toHaveBeenCalledTimes(1)
    expect(current.listModels).toHaveBeenCalledTimes(1)
  })

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

  it('creates only and keeps the secret out of the page', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => []) })
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    await screen.findByText('尚未创建 API Key。')
    expect(screen.queryByLabelText('API Key 名称')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '新建 API Key' }))
    expect(screen.getByRole('dialog', { name: '新建 API Key' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建 API Key' }))
    await screen.findByText('API Key 已创建，可在列表中复制或应用配置。')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(current.createGatewayKey).toHaveBeenCalledWith({ name: '我的 API Key' })
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(bridge.apply).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('plain-key')
  })

  it('copies and applies an existing key using the row client and discovered endpoint', async () => {
    const current = client()
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    await screen.findByText('Work laptop', { exact: true })
    await openClientMenu()
    fireEvent.click(await copyButton('Work laptop', 'Claude Code'))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_AUTH_TOKEN')))
    fireEvent.click(await clientCheckbox('Work laptop', 'Claude Code'))
    await screen.findByText('Claude Code 配置已应用。')
    expect(bridge.plan).toHaveBeenCalledWith({ client: 'claude-code', endpoint: current.apiBase })
    expect(bridge.apply).toHaveBeenCalledWith({ client: 'claude-code', planId: 'plan', apiKey: 'plain-key' })
    expect(bridge.verify).not.toHaveBeenCalled()
    expect(current.createGatewayKey).not.toHaveBeenCalled()
  })

  it('shows copy success only beside the copied key and clears it automatically', async () => {
    render(<AiGatewayKeysSection client={client()} />)
    const copy = await copyButton()
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(copy) })
    expect(copy).toHaveProperty('title', '已复制')
    expect(screen.getByRole('button', { name: '复制 Work laptop 的 Claude Code 配置' }).title).not.toBe('已复制')
    expect(copy.parentElement?.textContent).toContain('已复制')
    expect(screen.queryByText('配置已复制。')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(copy.title).not.toBe('已复制')
    expect(screen.queryByText('已复制')).toBeNull()
  })

  it('copies each menu client format without applying any client', async () => {
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    const copy = await copyButton()
    await act(async () => { fireEvent.click(copy) })
    expect(copy).toHaveProperty('title', '已复制')
    fireEvent.click(await copyButton('Work laptop', 'Claude Code'))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('ANTHROPIC_AUTH_TOKEN')))
    expect(copy.title).not.toBe('已复制')
    expect(await copyButton('Work laptop', 'Claude Code')).toHaveProperty('title', '已复制')
    expect(await clientCheckbox()).toHaveProperty('checked', false)
    expect(await clientCheckbox('Work laptop', 'Claude Code')).toHaveProperty('checked', false)
    expect(bridge.apply).not.toHaveBeenCalled()
    expect(bridge.restore).not.toHaveBeenCalled()
  })

  it('keeps restore retry available after failures and preserves the key after successful restore', async () => {
    const current = client()
    const bridge = configurationBridge()
    vi.mocked(bridge.restore).mockRejectedValueOnce(new Error('restore failed'))
      .mockResolvedValueOnce({ status: 'drifted', message: 'still drifted' })
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText(appliedMessage('Codex'))
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText('restore failed')
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText('still drifted')
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText('Codex 配置已撤回，API Key 已保留。')
    expect(await clientCheckbox('Work laptop')).toHaveProperty('checked', false)
    expect(await clientCheckbox('Work laptop')).toHaveProperty('disabled', false)
    expect(screen.getByText('Work laptop', { exact: true })).toBeTruthy()
    expect(current.deleteGatewayKey).not.toHaveBeenCalled()
  })

  it.each(['Codex', 'Claude Code', 'Pi', 'CodeBuddy'])('moves %s ownership to the latest key and prevents duplicate application', async (target) => {
    const current = client({ listGatewayKeys: vi.fn(async () => [active, { ...disabled, disabledAt: undefined }]) })
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Work laptop', target))
    await screen.findByText(appliedMessage(target))
    expect(screen.queryByRole('button', { name: '应用 Work laptop 配置' })).toBeNull()
    expect(await clientCheckbox('Work laptop', target)).toHaveProperty('checked', true)
    fireEvent.click(await clientCheckbox('Paused client', target))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: `Paused client 应用到 ${target}` })).toHaveProperty('checked', true))
    expect(await clientCheckbox('Work laptop', target)).toHaveProperty('checked', false)
    expect(await clientCheckbox('Work laptop', target)).toHaveProperty('disabled', false)
    expect(bridge.apply).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['codex', 'Codex'],
    ['claude-code', 'Claude Code'],
    ['pi', 'Pi'],
    ['codebuddy', 'CodeBuddy'],
  ] as const)('refreshes the %s endpoint with the same key only after application', async (clientId, target) => {
    const current = client()
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    const checkbox = await clientCheckbox('Work laptop', target)
    const refresh = screen.getByRole('button', { name: `刷新 Work laptop 的 ${target} endpoint` })
    expect(refresh).toHaveProperty('disabled', true)
    fireEvent.click(refresh)
    expect(bridge.plan).not.toHaveBeenCalled()
    fireEvent.click(checkbox)
    await screen.findByText(appliedMessage(target))
    expect(refresh).toHaveProperty('disabled', false)

    Object.defineProperty(current, 'apiBase', { value: 'https://new-gateway.example' })
    fireEvent.click(refresh)
    await screen.findByText(target === 'Codex' ? appliedMessage(target) : `${target} endpoint 已刷新。`)
    expect(bridge.plan).toHaveBeenLastCalledWith({ client: clientId, endpoint: current.apiBase })
    expect(bridge.apply).toHaveBeenCalledTimes(2)
    expect(bridge.apply).toHaveBeenLastCalledWith({ client: clientId, planId: 'plan', apiKey: 'plain-key' })
    expect(current.revealGatewayKey).toHaveBeenNthCalledWith(1, active.id)
    expect(current.revealGatewayKey).toHaveBeenNthCalledWith(2, active.id)
    expect(checkbox).toHaveProperty('checked', true)
    expect(refresh).toHaveProperty('disabled', false)
    expect(bridge.restore).not.toHaveBeenCalled()
    expect(current.createGatewayKey).not.toHaveBeenCalled()
  })

  it.each(['Codex', 'Claude Code', 'Pi', 'CodeBuddy'])('keeps the %s key checked when endpoint refresh fails', async (target) => {
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockResolvedValueOnce({ applied: true }).mockRejectedValueOnce(new Error('刷新写入失败'))
    const current = client()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    const checkbox = await clientCheckbox('Work laptop', target)
    fireEvent.click(checkbox)
    await screen.findByText(appliedMessage(target))
    const refresh = screen.getByRole('button', { name: `刷新 Work laptop 的 ${target} endpoint` })
    Object.defineProperty(current, 'apiBase', { value: 'https://new-gateway.example' })
    fireEvent.click(refresh)
    await screen.findByText('刷新写入失败')
    expect(checkbox).toHaveProperty('checked', true)
    expect(refresh).toHaveProperty('disabled', false)
    expect(screen.queryByText(target === 'Codex' ? appliedMessage(target) : `${target} endpoint 已刷新。`)).toBeNull()
    expect(bridge.restore).not.toHaveBeenCalled()
    expect(current.createGatewayKey).not.toHaveBeenCalled()
  })

  it('applies immediately with the plan confirmation token and target hash', async () => {
    const current = client()
    const bridge = configurationBridge()
    vi.mocked(bridge.plan).mockResolvedValueOnce({ client: 'codex', planId: 'confirm-plan', changes: [{ target: '~/.codex/config.toml', action: 'update', backup: true }], confirmation: { required: true, token: 'CONFIRM', targetHash: 'hash', message: '覆盖现有配置' } })
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText(appliedMessage('Codex'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('输入应用确认码')).toBeNull()
    expect(bridge.apply).toHaveBeenCalledWith({ client: 'codex', planId: 'confirm-plan', apiKey: 'plain-key', confirmation: { token: 'CONFIRM', targetHash: 'hash' } })
    expect(screen.getByRole('button', { name: 'Work laptop 客户端配置' }).textContent).toBe('应用')
    expect(screen.getByRole('img', { name: 'Codex 已应用' }).getAttribute('title')).toBe('Codex 已应用')
    fireEvent.click(await clientCheckbox())
    await screen.findByText('Codex 配置已撤回，API Key 已保留。')
    expect(screen.queryByRole('img', { name: 'Codex 已应用' })).toBeNull()
  })

  it('copies the complete key with temporary accessible feedback without rendering the secret', async () => {
    const current = client()
    render(<AiGatewayKeysSection client={current} />)
    const copy = await screen.findByRole('button', { name: '复制 Work laptop' })
    vi.useFakeTimers()
    await act(async () => { fireEvent.click(copy) })
    expect(current.revealGatewayKey).toHaveBeenCalledWith(active.id)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('plain-key')
    expect(document.body.textContent).not.toContain('plain-key')
    expect(copy.title).toBe('已复制')
    expect(screen.getByText('API Key 已复制').getAttribute('role')).toBe('status')
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    expect(copy.title).toBe('复制 API Key')
    expect(screen.queryByText('API Key 已复制')).toBeNull()
  })

  it.each([
    ['success', appliedMessage('Codex')],
    ['failure', 'application failed'],
  ] as const)('renders an application %s notification outside the key list', async (outcome, message) => {
    const bridge = configurationBridge()
    if (outcome === 'failure') vi.mocked(bridge.apply).mockRejectedValueOnce(new Error(message))
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    const checkbox = await clientCheckbox()
    const section = screen.getByRole('region', { name: 'API Keys' })
    const originalChildren = Array.from(section.children)
    fireEvent.click(checkbox)
    const notification = await screen.findByText(message)
    expect(notification.closest('[role="status"]')).not.toBeNull()
    expect(section.contains(notification)).toBe(false)
    expect(Array.from(section.children)).toEqual(originalChildren)
    expect(within(section).queryByRole('alert')).toBeNull()
    expect(within(section).queryByText(message)).toBeNull()
  })

  it('restores one selected client without changing another client on the same key', async () => {
    const bridge = configurationBridge()
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox())
    await screen.findByText(appliedMessage('Codex'))
    fireEvent.click(await clientCheckbox('Work laptop', 'Claude Code'))
    await screen.findByText('Claude Code 配置已应用。')
    expect(await clientCheckbox()).toHaveProperty('checked', true)
    expect(await clientCheckbox('Work laptop', 'Claude Code')).toHaveProperty('checked', true)
    fireEvent.click(await clientCheckbox())
    await screen.findByText('Codex 配置已撤回，API Key 已保留。')
    expect(await clientCheckbox()).toHaveProperty('checked', false)
    expect(await clientCheckbox('Work laptop', 'Claude Code')).toHaveProperty('checked', true)
    expect(bridge.restore).toHaveBeenCalledTimes(1)
    expect(bridge.restore).toHaveBeenCalledWith('codex')
  })

  it('keeps deletion disabled until every client using the key has been restored', async () => {
    const current = client()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={configurationBridge()} />)
    fireEvent.click(await clientCheckbox())
    await screen.findByText(appliedMessage('Codex'))
    fireEvent.click(await clientCheckbox('Work laptop', 'Claude Code'))
    await screen.findByText('Claude Code 配置已应用。')
    fireEvent.click(await clientCheckbox())
    await screen.findByText('Codex 配置已撤回，API Key 已保留。')
    const remove = screen.getByRole('button', { name: '删除 Work laptop' })
    expect(remove).toHaveProperty('disabled', true)
    fireEvent.click(remove)
    expect(current.deleteGatewayKey).not.toHaveBeenCalled()
    fireEvent.click(await clientCheckbox('Work laptop', 'Claude Code'))
    await screen.findByText('Claude Code 配置已撤回，API Key 已保留。')
    expect(remove).toHaveProperty('disabled', false)
  })

  it('applies and restores file configuration without requesting model or network verification', async () => {
    const current = client({ listModels: vi.fn(async () => { throw new Error('model catalog unavailable') }) })
    const bridge = configurationBridge()
    vi.mocked(bridge.verify).mockImplementation(async () => { throw new Error('network verification must not run') })
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox())
    await screen.findByText(appliedMessage('Codex'))
    expect(await clientCheckbox()).toHaveProperty('checked', true)
    fireEvent.click(await copyButton())
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('plain-key')))
    fireEvent.click(await clientCheckbox())
    await screen.findByText('Codex 配置已撤回，API Key 已保留。')
    expect(bridge.restore).toHaveBeenCalledWith('codex')
    expect(bridge.verify).not.toHaveBeenCalled()
    expect(current.listModels).not.toHaveBeenCalled()
  })

  it('leaves an existing key available for retry when application fails', async () => {
    const current = client()
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockRejectedValueOnce(new Error('application failed'))
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText('application failed')
    expect(current.createGatewayKey).not.toHaveBeenCalled()
    expect(current.deleteGatewayKey).not.toHaveBeenCalled()
    expect(bridge.verify).not.toHaveBeenCalled()
    expect(await clientCheckbox('Work laptop')).toHaveProperty('checked', false)
    fireEvent.click(await clientCheckbox('Work laptop'))
    await screen.findByText(appliedMessage('Codex'))
    expect(bridge.apply).toHaveBeenCalledTimes(2)
  })

  it.each(['Codex', 'Claude Code', 'Pi', 'CodeBuddy'])('preserves the previous %s key owner when applying a replacement key fails', async (target) => {
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockResolvedValueOnce({ applied: true }).mockRejectedValueOnce(new Error('文件写入失败'))
    render(<AiGatewayKeysSection client={client({ listGatewayKeys: vi.fn(async () => [active, { ...disabled, disabledAt: undefined }]) })} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Work laptop', target))
    await screen.findByText(appliedMessage(target))
    fireEvent.click(await clientCheckbox('Paused client', target))
    await screen.findByText('文件写入失败')
    expect(await clientCheckbox('Paused client', target)).toHaveProperty('checked', false)
    expect(await clientCheckbox('Work laptop', target)).toHaveProperty('checked', true)
  })

  it('replaces a failed operation notification with one actionable Chinese message on retry', async () => {
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new Error('EACCES: permission denied'))
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox())
    await screen.findByText('无法连接配置服务，请检查连接后重试。')
    fireEvent.click(await clientCheckbox())
    await screen.findByText('没有权限写入配置文件，请检查文件权限后重试。')
    expect(screen.queryByText('无法连接配置服务，请检查连接后重试。')).toBeNull()
    expect(screen.getAllByRole('button', { name: '关闭通知' })).toHaveLength(1)
    expect(screen.queryByText(/Failed to fetch|EACCES/)).toBeNull()
  })

  it.each([
    ['AI client configuration request failed. Please try again.', 'API Key 操作失败，请重试。'],
    ['Client configuration could not be verified locally.', '配置文件写入后的本地检查未通过，请检查文件内容和权限后重试。'],
    ['配置文件已被其他程序修改，请重新预览。', '配置文件已被其他程序修改，请重新预览。'],
  ])('presents the actionable file operation error for %s', async (failure, message) => {
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockRejectedValueOnce(new Error(failure))
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox())
    await screen.findByText(message)
    expect(screen.getAllByRole('button', { name: '关闭通知' })).toHaveLength(1)
    expect(await clientCheckbox()).toHaveProperty('checked', false)
  })

  it('keeps unavailable background inspection silent and leaves file application available', async () => {
    const bridge = configurationBridge()
    vi.mocked(bridge.inspect).mockRejectedValue(new TypeError('Failed to fetch'))
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    await waitFor(() => expect(bridge.inspect).toHaveBeenCalledTimes(4))
    expect(await clientCheckbox()).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: '关闭通知' })).toBeNull()
    expect(screen.queryByText(/Failed to fetch|无法连接/)).toBeNull()
  })

  it('finishes applying as soon as the configuration file write succeeds', async () => {
    let finishApply!: (value: { applied: true }) => void
    const applying = new Promise<{ applied: true }>((resolve) => { finishApply = resolve })
    const bridge = configurationBridge()
    vi.mocked(bridge.apply).mockReturnValueOnce(applying)
    vi.mocked(bridge.verify).mockReturnValue(new Promise(() => undefined))
    render(<AiGatewayKeysSection client={client()} clientConfigurationBridge={bridge} />)
    const checkbox = await clientCheckbox()
    fireEvent.click(checkbox)
    expect(screen.getByText('应用中…').closest('[role="status"]')).not.toBeNull()
    expect(checkbox).toHaveProperty('disabled', true)
    await act(async () => { finishApply({ applied: true }); await applying })
    expect(screen.queryByText('应用中…')).toBeNull()
    expect(screen.queryByText('验证中…')).toBeNull()
    expect(checkbox).toHaveProperty('disabled', false)
    expect(checkbox).toHaveProperty('checked', true)
    expect(bridge.verify).not.toHaveBeenCalled()
  })

  it('does not offer unsupported pause for client credentials', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => [{ ...active, kind: 'client-credentials' as const }]) })
    render(<AiGatewayKeysSection client={current} />)
    await screen.findByText('Work laptop', { exact: true })
    expect(screen.queryByRole('button', { name: '停用 Work laptop' })).toBeNull()
    expect(screen.getByRole('button', { name: '删除 Work laptop' })).toBeTruthy()
  })

  it('restores row ownership after reload only from a verified matching fingerprint', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => [{ ...active, fingerprint: 'fingerprint' }]) })
    const bridge = configurationBridge()
    vi.mocked(bridge.inspect).mockImplementation(async (target) => target === 'claude-code'
      ? { status: 'configured', appliedKeyFingerprint: 'fingerprint' }
      : { status: 'notConfigured' })
    const view = render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    expect(await clientCheckbox('Work laptop', 'Claude Code')).toHaveProperty('checked', true)
    view.unmount()
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Work laptop', 'Claude Code'))
    await screen.findByText('Claude Code 配置已撤回，API Key 已保留。')
    expect(bridge.restore).toHaveBeenCalledWith('claude-code')
    expect(current.revealGatewayKey).not.toHaveBeenCalled()
  })

  it('does not infer ownership from missing fingerprints or drifted configuration', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => [{ ...active, fingerprint: 'fingerprint' }]) })
    const bridge = configurationBridge()
    vi.mocked(bridge.inspect).mockImplementation(async (target) => target === 'codex'
      ? { status: 'configured' }
      : { status: 'drifted', appliedKeyFingerprint: 'fingerprint' })
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    await waitFor(() => expect(bridge.inspect).toHaveBeenCalledTimes(4))
    expect(await clientCheckbox('Work laptop')).toHaveProperty('checked', false)
  })

  it('ignores stale inspection after a different key is applied and restored', async () => {
    let finishInspection!: (status: AiClientConfigurationStatus) => void
    const inspection = new Promise<AiClientConfigurationStatus>((resolve) => { finishInspection = resolve })
    const current = client({ listGatewayKeys: vi.fn(async () => [{ ...active, fingerprint: 'old-fingerprint' }, { ...disabled, disabledAt: undefined, fingerprint: 'new-fingerprint' }]) })
    const bridge = configurationBridge()
    vi.mocked(bridge.inspect).mockImplementation(async (target) => target === 'codex' ? inspection : { status: 'notConfigured' })
    render(<AiGatewayKeysSection client={current} clientConfigurationBridge={bridge} />)
    fireEvent.click(await clientCheckbox('Paused client'))
    await screen.findByText(appliedMessage('Codex'))
    fireEvent.click(await clientCheckbox('Paused client'))
    await screen.findByText('Codex 配置已撤回，API Key 已保留。')
    await act(async () => {
      finishInspection({ status: 'configured', appliedKeyFingerprint: 'old-fingerprint' })
      await inspection
    })
    await waitFor(() => expect(bridge.inspect).toHaveBeenCalledTimes(4))
    expect(await clientCheckbox('Work laptop')).toHaveProperty('checked', false)
    expect(await clientCheckbox('Paused client')).toHaveProperty('checked', false)
  })

  it('uses power controls as paired enable actions, reveals config, and removes deleted rows', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => [active, disabled]) })
    render(<AiGatewayKeysSection client={current} />)

    expect(await screen.findByText('Work laptop', { exact: true })).toBeTruthy()
    expect(screen.getByText('Paused client', { exact: true })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '停用 Work laptop' }))
    await waitFor(() => expect(current.updateGatewayKey).toHaveBeenCalledWith('active-key', { enabled: false }))

    fireEvent.click(screen.getByRole('button', { name: '启用 Paused client' }))
    await waitFor(() => expect(current.updateGatewayKey).toHaveBeenCalledWith('disabled-key', { enabled: true }))

    fireEvent.click(await copyButton())
    await waitFor(() => expect(current.revealGatewayKey).toHaveBeenCalledWith('active-key'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('plain-key'))

    fireEvent.click(screen.getByRole('button', { name: '删除 Work laptop' }))
    await waitFor(() => expect(current.deleteGatewayKey).toHaveBeenCalledWith('active-key'))
    expect(screen.queryByText('Work laptop', { exact: true })).toBeNull()
  })
})

function appliedMessage(target: string) {
  return target === 'Codex' ? 'Codex 连接配置已应用，模型目录尚未加载，请稍后刷新配置。' : `${target} 配置已应用。`
}

function render(ui: ReactElement) {
  return renderUi(<>{ui}<Toaster /></>)
}

async function openClientMenu(label = 'Work laptop') {
  const trigger = await screen.findByRole('button', { name: `${label} 客户端配置` })
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
}

async function clientCheckbox(label = 'Work laptop', target = 'Codex') {
  await openClientMenu(label)
  return screen.getByRole('checkbox', { name: `${label} 应用到 ${target}` }) as HTMLInputElement
}

async function copyButton(label = 'Work laptop', target = 'Codex') {
  await openClientMenu(label)
  return screen.getByRole('button', { name: `复制 ${label} 的 ${target} 配置` })
}

function client(overrides: Partial<AiConnectionsClient> = {}): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    listGatewayKeys: vi.fn(async () => [active, disabled]),
    createGatewayKey: vi.fn(async () => ({ plaintext: 'plain-key', record: active })),
    revealGatewayKey: vi.fn(async () => 'plain-key'),
    updateGatewayKey: vi.fn(async (id, input) => ({
      ...(id === active.id ? active : disabled),
      disabledAt: input.enabled ? undefined : '2026-08-25T02:00:00.000Z',
    })),
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
