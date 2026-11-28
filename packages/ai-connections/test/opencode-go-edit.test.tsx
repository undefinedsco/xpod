// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
import { AiApiKeyPool } from '../src/AiApiKeyPool'
import { CUSTOM_DEFAULT_OFFERINGS } from '../src/contract/provider-catalog'
import { PROVIDERS } from '../src/controller'
afterEach(cleanup)
it('offers explicit Go migration while preserving the existing key and inference endpoint', async () => {
  const definition = PROVIDERS.find((provider) => provider.id === 'custom')!
  const credential = { id: 'credentials.ttl#custom-kept', provider: 'custom' as const, offeringId: 'openai-compatible', authMode: 'apiKey' as const, label: 'Kept', enabled: true, priority: 7, health: 'healthy' as const, version: 4, baseUrl: 'https://opencode.ai/inference/go/openai/v1' }
  const update = vi.fn(async () => undefined)
  render(<AiApiKeyPool definition={definition} offering={CUSTOM_DEFAULT_OFFERINGS[0]!} createOfferings={CUSTOM_DEFAULT_OFFERINGS} status="configured" credentials={[credential]} initialEditing={credential} apiKey="" baseUrl="" busy={false} disabled={false} onApiKeyChange={vi.fn()} onBeginApiKey={vi.fn()} onBeginBrowser={vi.fn()} onSaveApiKey={vi.fn()} onDisconnect={vi.fn()} onUpdateCredential={update} onCloseEdit={vi.fn()} />)
  const select = screen.getByRole('combobox')
  expect(screen.getByRole('option', { name: 'OpenCode Go' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: /Anthropic/ })).toBeNull()
  fireEvent.change(select, { target: { value: 'opencode-go' } })
  fireEvent.click(screen.getByRole('button', { name: '保存凭证' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith(credential, { offeringId: 'opencode-go', label: 'Kept', baseUrl: credential.baseUrl }))
})
