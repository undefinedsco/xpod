// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, render, waitFor } from '@testing-library/react'
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
