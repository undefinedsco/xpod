// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react'
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
    expect(Object.keys(aiConnectionApplet.slots).sort()).toEqual([
      'list', 'listHeader', 'main', 'mainHeader',
    ])
  })

  it('puts Provider search in the header and only Providers in list navigation', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.listHeader}{mounted.list}<div data-testid="main-header">{mounted.mainHeader}</div>{mounted.main}</>)

    expect(screen.getByRole('searchbox', { name: '搜索 Provider' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加 AI Connection' })).toBeTruthy()
    expect(within(screen.getByTestId('main-header')).getByRole('heading', { name: 'OpenAI' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'AI Connection' })).toBeNull()
    for (const name of ['OpenAI', 'Anthropic', 'Kimi', '百炼', 'DeepSeek']) {
      expect(screen.getByRole('option', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'Client Credentials' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Developer Access' })).toBeNull()
  })

  it('filters Providers from the header search', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.listHeader}{mounted.list}</>)
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索 Provider' }), {
      target: { value: 'kimi' },
    })

    expect(screen.getByRole('option', { name: 'Kimi' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'OpenAI' })).toBeNull()
  })

  it('updates the main region when a Provider is selected', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.list}<div data-testid="main-header">{mounted.mainHeader}</div>{mounted.main}</>)
    fireEvent.click(within(screen.getByRole('listbox', { name: 'AI 服务' })).getByRole('option', { name: 'Kimi' }))

    expect(screen.getByRole('region', { name: 'Kimi 详情' })).toBeTruthy()
    expect(within(screen.getByTestId('main-header')).getByRole('heading', { name: 'Kimi' })).toBeTruthy()
  })

  it('opens the main pane when a Provider is activated in stack mode', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(
      <TwoPaneLayout
        mode="stack"
        listHeader={mounted.listHeader}
        list={mounted.list}
        mainHeader={mounted.mainHeader}
        main={mounted.main}
      />,
    )

    const kimi = screen.getByRole('option', { name: 'Kimi' })
    fireEvent.click(kimi)

    const mainPane = screen.getByTestId('workspace-main-pane')
    expect(mainPane).not.toHaveProperty('hidden', true)
    expect(document.activeElement).toBe(mainPane)

    fireEvent.click(within(mainPane).getByRole('button', { name: '返回列表' }))
    const anthropic = screen.getByRole('option', { name: 'Anthropic' })
    anthropic.focus()
    fireEvent.keyDown(anthropic, { key: 'Enter' })
    expect(mainPane).not.toHaveProperty('hidden', true)
    expect(document.activeElement).toBe(mainPane)
  })

  it('uses Add to open the custom Provider form', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({ solid: readySolid() }),
    )
    mounted.controller.setProviderState('openai', 'configured')
    mounted.controller.setProviderState('anthropic', 'unconfigured')

    render(<>{mounted.listHeader}<div data-testid="main-header">{mounted.mainHeader}</div></>)
    fireEvent.click(screen.getByRole('button', { name: '添加 AI Connection' }))

    expect(screen.getByRole('dialog', { name: '添加自定义 Provider' })).toBeTruthy()
  })
})
