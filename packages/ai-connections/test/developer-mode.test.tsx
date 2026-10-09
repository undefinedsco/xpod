// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiConnectionsPanel } from '../src'
import type { AiConnectionsClient } from '../src/contract/ai-connections-client'
import { catalogProvider } from './fixtures'

// The real OpenAI subscription declares this Codex backend. Design §4.1 line 127
// keeps read-only interface addresses out of the normal UI; only developer mode
// may reveal them.
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex'
// `AiEndpointList` renders the compact form; assert both the visible text and the
// full address on the row's title attribute.
const CODEX_DISPLAY = 'chatgpt.com/backend-api/codex'
const SUBSCRIPTION_TITLE = 'OpenAI Subscription'

afterEach(() => {
  cleanup()
  document.body.innerHTML = '<div id="root"></div>'
})

function client(): AiConnectionsClient {
  return {
    webId: 'https://pod.example/alice/profile/card#me',
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => []),
    listModels: vi.fn(async () => []),
    listGatewayKeys: vi.fn(async () => []),
  } as unknown as AiConnectionsClient
}

function panelProps(developerMode?: boolean) {
  return {
    client: client(),
    selectedProvider: 'openai' as const,
    providerProducts: { openai: catalogProvider('openai') },
    ...(developerMode === undefined ? {} : { developerMode }),
  }
}

function expectEndpointHidden() {
  expect(screen.queryByTitle(CODEX_ENDPOINT)).toBeNull()
  expect(screen.queryByText(CODEX_DISPLAY)).toBeNull()
}

describe('provider read-only endpoint addresses are developer-mode only', () => {
  it('hides the real unavailable offering endpoint by default and keeps its official links', async () => {
    render(<AiConnectionsPanel {...panelProps()} />)
    expect(await screen.findByRole('heading', { name: SUBSCRIPTION_TITLE })).toBeTruthy()
    expectEndpointHidden()
    expect(screen.getByRole('link', { name: '订阅与账单' })).toBeTruthy()
  })

  it('stays hidden when developerMode is explicitly false', async () => {
    render(<AiConnectionsPanel {...panelProps(false)} />)
    expect(await screen.findByRole('heading', { name: SUBSCRIPTION_TITLE })).toBeTruthy()
    expectEndpointHidden()
  })

  it('reveals the endpoint only when developerMode is true, and hides it again when turned off', async () => {
    const view = render(<AiConnectionsPanel {...panelProps(true)} />)
    expect(await screen.findByRole('heading', { name: SUBSCRIPTION_TITLE })).toBeTruthy()
    expect(await screen.findByTitle(CODEX_ENDPOINT)).toBeTruthy()
    expect(screen.getByText(CODEX_DISPLAY)).toBeTruthy()
    view.rerender(<AiConnectionsPanel {...panelProps(false)} />)
    await waitFor(() => expectEndpointHidden())
  })
})
