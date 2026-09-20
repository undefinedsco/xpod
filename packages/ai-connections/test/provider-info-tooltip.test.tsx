// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiConnectionsPanel, PROVIDERS, type AiConnectionsClient, type AiConnectionsProvider } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'
const CREDENTIAL_NOTE = 'Provider 凭证保存在当前 Pod，由 Pod 权限保护。'

afterEach(() => {
  cleanup()
  document.body.innerHTML = '<div id="root"></div>'
})

function client(provider: AiConnectionsProvider): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: vi.fn(async () => ({ status: 'granted' })),
    listProviders: vi.fn(async () => []),
    // A capability-bearing model renders the glyph tooltips that share the
    // header's Radix provider unless each tooltip isolates its own.
    listModels: vi.fn(async () => [{
      id: `${provider}-reasoning`,
      provider,
      displayName: `${provider} reasoning`,
      availability: 'available' as const,
      capabilities: ['reasoning'],
    }]),
    listGatewayKeys: vi.fn(async () => []),
  } as unknown as AiConnectionsClient
}

describe('Provider page ⓘ', () => {
  it.each(PROVIDERS.map((definition) => definition.id))('%s opens on focus with its description', async (id) => {
    const definition = PROVIDERS.find((candidate) => candidate.id === id)!
    render(<AiConnectionsPanel client={client(id)} selectedProvider={id} />)

    const info = await screen.findByRole('button', { name: '提供商说明' })
    expect(info.getAttribute('type')).toBe('button')
    fireEvent.focus(info)

    expect(await screen.findByText(definition.description)).toBeTruthy()
    expect(screen.getByText(CREDENTIAL_NOTE)).toBeTruthy()
  })

  it.each(PROVIDERS.map((definition) => definition.id))(
    '%s still opens on hover after a capability tooltip went in transit',
    async (id) => {
      const definition = PROVIDERS.find((candidate) => candidate.id === id)!
      render(<AiConnectionsPanel client={client(id)} selectedProvider={id} />)

      // Walk the pointer through the model list first: leaving a capability
      // glyph sets Radix's per-provider "pointer in transit" flag, which makes
      // every trigger in the same provider ignore the next pointer move.
      const glyph = await screen.findByRole('button', { name: '推理' })
      fireEvent.pointerMove(glyph, { pointerType: 'mouse', clientX: 10, clientY: 10 })
      expect(await screen.findByText('推理')).toBeTruthy()
      fireEvent.pointerLeave(glyph, { pointerType: 'mouse', clientX: 10, clientY: 10 })

      fireEvent.pointerMove(await screen.findByRole('button', { name: '提供商说明' }), {
        pointerType: 'mouse', clientX: 10, clientY: 10,
      })

      expect(await screen.findByText(definition.description, {}, { timeout: 2000 })).toBeTruthy()
    },
  )
})
