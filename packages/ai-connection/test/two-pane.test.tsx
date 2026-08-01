// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import type { WebExtensionSolidCapability } from '@undefineds.co/extension-sdk/web'
import { mountTwoPaneApplet } from '@undefineds.co/extension-sdk/web'
import { aiConnectionApplet } from '../src'

function readySolid(): WebExtensionSolidCapability {
  return {
    session: {
      fetch: async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      getSnapshot: () => ({
        status: 'authenticated',
        webId: 'https://pod.example/alice/profile/card#me',
      }),
      subscribe: () => () => undefined,
    },
    pod: {
      status: 'ready',
      current: {
        webId: 'https://pod.example/alice/profile/card#me',
        podUrl: 'https://pod.example',
        database: { id: 'db' },
        collections: 'ready',
      },
    },
    requireLogin: async () => undefined,
  }
}

describe('AI Connection two-pane contribution', () => {
  afterEach(cleanup)

  it('exposes only the two-pane slot contract', () => {
    expect(aiConnectionApplet.manifest.layout).toBe('two-pane')
    expect('mount' in aiConnectionApplet).toBe(false)
    expect(Object.keys(aiConnectionApplet.slots).sort()).toEqual(['header', 'list', 'main'])
  })

  it('puts Provider search in the header and only Providers in list navigation', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.header}{mounted.list}{mounted.main}</>)

    expect(screen.getByRole('searchbox', { name: '搜索 Provider' })).toBeTruthy()
    for (const name of ['OpenAI', 'Anthropic', 'Kimi', '百炼', 'DeepSeek']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'Gateway Keys' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编码客户端' })).toBeNull()
  })

  it('filters Providers from the header search', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.header}{mounted.list}</>)
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 Provider' }), {
      target: { value: 'kimi' },
    })

    expect(screen.getByRole('button', { name: 'Kimi' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'OpenAI' })).toBeNull()
  })

  it('updates the main region when a Provider is selected', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.list}{mounted.main}</>)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'AI 服务' })).getByRole('button', { name: 'Kimi' }))

    expect(screen.getByRole('region', { name: 'Kimi 详情' })).toBeTruthy()
  })
})
