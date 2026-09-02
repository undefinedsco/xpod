// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiGatewayKeysSection,
  type AiConnectionsClient,
  type GatewayKeyRecord,
} from '../src'

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
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('creates a named key and copies client-specific configuration', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => []) })
    render(<AiGatewayKeysSection client={current} />)

    await waitFor(() => expect(current.listGatewayKeys).toHaveBeenCalled())
    expect(screen.getByLabelText('API Key 名称')).toHaveProperty('value', '我的 API Key')

    fireEvent.change(screen.getByLabelText('应用到客户端'), { target: { value: 'codex' } })
    expect(screen.getByText('当前 Web 环境不支持自动写入，将复制 Codex 配置。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '创建 API Key' }))

    await waitFor(() => expect(current.createGatewayKey).toHaveBeenCalledWith({
      name: '我的 API Key',
      appliedClient: 'codex',
    }))
    expect(screen.getByLabelText('新创建的 API Key').textContent).toContain('plain-key')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY'))
  })

  it('uses stop/play as paired enable actions, reveals config, and removes deleted rows', async () => {
    const current = client({ listGatewayKeys: vi.fn(async () => [active, disabled]) })
    render(<AiGatewayKeysSection client={current} />)

    expect(await screen.findByText('Work laptop', { exact: true })).toBeTruthy()
    expect(screen.getByText('Paused client', { exact: true })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '停用 Work laptop' }))
    await waitFor(() => expect(current.updateGatewayKey).toHaveBeenCalledWith('active-key', { enabled: false }))

    fireEvent.click(screen.getByRole('button', { name: '启用 Paused client' }))
    await waitFor(() => expect(current.updateGatewayKey).toHaveBeenCalledWith('disabled-key', { enabled: true }))

    fireEvent.click(screen.getByRole('button', { name: '复制 Work laptop 配置' }))
    await waitFor(() => expect(current.revealGatewayKey).toHaveBeenCalledWith('active-key'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('plain-key'))

    fireEvent.click(screen.getByRole('button', { name: '删除 Work laptop' }))
    await waitFor(() => expect(current.deleteGatewayKey).toHaveBeenCalledWith('active-key'))
    expect(screen.queryByText('Work laptop', { exact: true })).toBeNull()
  })
})

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
