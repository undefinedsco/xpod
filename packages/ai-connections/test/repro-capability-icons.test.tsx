// @vitest-environment jsdom
import './setup-jsdom'
import { render, screen, waitFor } from '@testing-library/react'
import { cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AiConnectionsPanel, type AiConnectionsClient } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

afterEach(() => {
  cleanup()
  document.body.innerHTML = '<div id="root"></div>'
})

function client(overrides: Partial<AiConnectionsClient> = {}): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })) as never,
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => [
      { id: 'glm-4.5', provider: 'zhipu' as const, capabilities: ['tool_call', 'reasoning'] },
    ]),
    ...overrides,
  } as unknown as AiConnectionsClient
}

it('renders capability tags in the model list rows', async () => {
  render(<AiConnectionsPanel client={client()} selectedProvider="zhipu" />)
  await waitFor(() => expect(screen.getByText('glm-4.5')).toBeTruthy())
  expect(screen.queryByRole('button', { name: '函数调用' })).not.toBeNull()
  expect(screen.queryByRole('button', { name: '推理' })).not.toBeNull()
})
