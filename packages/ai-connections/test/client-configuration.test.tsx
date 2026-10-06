// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AiClientConfigurationSection, type AiClientConfigurationBridge } from '../src/AiClientConfigurationSection'

afterEach(cleanup)

it('completes legacy client configuration after file application without network verification', async () => {
  const revoke = vi.fn(async () => undefined)
  const onComplete = vi.fn()
  const bridge: AiClientConfigurationBridge = {
    inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
    plan: vi.fn(async () => ({ client: 'codex' as const, planId: 'plan', changes: [] })),
    apply: vi.fn(async () => ({ applied: true as const })),
    verify: vi.fn(() => new Promise(() => undefined)),
    restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
  }
  render(<AiClientConfigurationSection bridge={bridge} client="codex" endpoint="https://pod.example" autoApply
    createClientCredential={async () => ({ apiKey: 'private-key', revoke })} onComplete={onComplete} />)
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
  expect(bridge.verify).not.toHaveBeenCalled()
  expect(revoke).not.toHaveBeenCalled()
})

it('keeps the created key when the write fails, then retries only the write', async () => {
  const revoke = vi.fn(async () => undefined)
  const createClientCredential = vi.fn(async () => ({ apiKey: 'private-key', revoke }))
  const apply = vi.fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({ applied: true as const })
  const bridge: AiClientConfigurationBridge = {
    inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
    plan: vi.fn(async () => ({ client: 'codex' as const, planId: 'plan', changes: [] })),
    apply,
    verify: vi.fn(() => new Promise(() => undefined)),
    restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
  }
  render(<AiClientConfigurationSection bridge={bridge} client="codex" endpoint="https://pod.example"
    autoApply compact createClientCredential={createClientCredential} />)

  // 第一次应用：写入失败
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(document.querySelector('[data-testid="client-setup-stages"]')).not.toBeNull())
  const rows = () => Array.from(document.querySelectorAll('[data-testid="client-setup-stage"]'))
  expect(rows().map((row) => row.getAttribute('data-stage'))).toEqual(['key', 'write', 'gateway', 'client'])
  await waitFor(() => expect(
    document.querySelector('[data-stage="write"]')?.getAttribute('data-stage-state'),
  ).toBe('failed'))
  // §7.3：写入失败不撤销 Key，也不重复建 Key
  expect(revoke).not.toHaveBeenCalled()
  expect(createClientCredential).toHaveBeenCalledTimes(1)

  // 重试：只重写配置
  const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('重试'))
  expect(retry).toBeTruthy()
  retry!.click()
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
  expect(createClientCredential).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(
    document.querySelector('[data-stage="write"]')?.getAttribute('data-stage-state'),
  ).toBe('ok'))
})

it('withdraws the applied client configuration through the real bridge contract', async () => {
  const restore = vi.fn(async () => ({ status: 'notConfigured' as const }))
  const bridge: AiClientConfigurationBridge = {
    inspect: vi.fn(async () => ({ status: 'configured' as const })),
    plan: vi.fn(async () => ({ client: 'codex' as const, planId: 'plan', changes: [] })),
    apply: vi.fn(async () => ({ applied: true as const })),
    verify: vi.fn(() => new Promise(() => undefined)),
    restore,
  }
  render(<AiClientConfigurationSection bridge={bridge} client="codex" endpoint="https://pod.example"
    createClientCredential={async () => ({ apiKey: 'private-key', revoke: vi.fn(async () => undefined) })} />)

  await waitFor(() => expect(screen.getByText('已配置')).toBeTruthy())
  const restoreButton = screen.getByRole('button', { name: '恢复 Codex 配置' })
  expect(restoreButton.hasAttribute('disabled')).toBe(false)
  restoreButton.click()
  await waitFor(() => expect(restore).toHaveBeenCalledWith('codex'))
  await waitFor(() => expect(screen.getByText('未配置')).toBeTruthy())
  // The Key is Account-owned: withdrawing the local client config must never
  // re-apply it or revoke the credential itself.
  expect(bridge.apply).not.toHaveBeenCalled()
})

it('lets the user choose an existing key without minting a new one', async () => {
  const createClientCredential = vi.fn(async () => ({ apiKey: 'private-key', revoke: vi.fn(async () => undefined) }))
  const bridge: AiClientConfigurationBridge = {
    inspect: vi.fn(async () => ({ status: 'notConfigured' as const })),
    plan: vi.fn(async () => ({ client: 'codex' as const, planId: 'plan', changes: [] })),
    apply: vi.fn(async () => ({ applied: true as const })),
    verify: vi.fn(() => new Promise(() => undefined)),
    restore: vi.fn(async () => ({ status: 'notConfigured' as const })),
  }
  render(<AiClientConfigurationSection bridge={bridge} client="codex" endpoint="https://pod.example"
    createClientCredential={createClientCredential} />)

  // §7.3 第 3 步：明确选择 Key 来源，并说明共用影响
  const chooser = await screen.findByRole('tablist', { name: 'Codex 的 Key 来源' })
  const existing = within(chooser).getByTestId('client-key-source-existing')
  existing.click()
  await waitFor(() => expect(existing.getAttribute('aria-selected')).toBe('true'))
  expect(screen.getByText(/停用它会影响所有使用它的客户端/u)).toBeTruthy()

  // 选择已有 Key 后不再申请新凭据
  expect(createClientCredential).not.toHaveBeenCalled()
  expect(bridge.apply).not.toHaveBeenCalled()
})
