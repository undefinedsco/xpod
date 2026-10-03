// @vitest-environment jsdom
import './setup-jsdom'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockWebExtensionHost } from '@undefineds.co/extension-sdk/testing'
import { TwoPaneLayout, WorkspaceDrawerContext } from '@undefineds.co/extension-sdk/react'
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

  it('pins the connect-client workspace above API Keys and Providers', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.listHeader}{mounted.list}<div data-testid="main-header">{mounted.mainHeader}</div>{mounted.main}</>)

    expect(screen.getByRole('searchbox', { name: '搜索服务商' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加 AI Connection' })).toBeTruthy()
    // §7.3：入口以连接客户端开场，API KEYS 紧随其后
    expect(within(screen.getByTestId('main-header')).getByRole('heading', { name: 'Xpod' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '连接客户端' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: '选择客户端' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'AI Connection' })).toBeNull()
    // 切到 API KEYS 分组后，它仍是唯一的已签发凭据表面
    fireEvent.click(screen.getByRole('option', { name: 'Xpod' }))
    const pinned = screen.getByRole('option', { name: 'Xpod' })
    expect(pinned.getAttribute('aria-selected')).toBe('true')
    // The pinned issued-credential surface carries the Xpod provider mark; jsdom
    // never loads the image, so the initials fallback is what renders here (the
    // mark itself is asserted in provider-visuals.test.ts).
    expect(within(pinned).getByText('XP')).toBeTruthy()
    expect(screen.getAllByRole('heading', { name: 'Xpod' })).toHaveLength(2)
    expect(screen.queryByText('出口')).toBeNull()
    expect(screen.queryByRole('option', { name: '客户端接入' })).toBeNull()
    expect(screen.queryByRole('option', { name: '虚拟密钥' })).toBeNull()
    for (const name of ['OpenAI', 'Anthropic', 'Kimi', '百炼', 'DeepSeek']) {
      expect(screen.getByRole('option', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'Client Credentials' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Developer Access' })).toBeNull()
  })

  it('renders only the Providers the deployment reports', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/ai/providers')) {
        return new Response(JSON.stringify({
          data: [
            { id: 'openai', name: 'OpenAI', status: 'unconfigured', offerings: [], credentials: [], selectedModels: [] },
            { id: 'bailian', name: '百炼', status: 'unconfigured', offerings: [], credentials: [], selectedModels: [] },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const solid = readySolid()
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: { ...solid, session: { ...solid.session, fetch: fetchImpl } },
      }),
    )

    render(<>{mounted.listHeader}{mounted.list}{mounted.main}</>)

    // The server list arrives asynchronously; until then every Provider renders.
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Ollama' })).toBeNull())
    expect(screen.getByRole('option', { name: 'OpenAI' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '百炼' })).toBeTruthy()
    // Providers the deployment does not offer never reach the settings surface.
    for (const name of ['Custom', 'Anthropic', 'Kimi', 'DeepSeek']) {
      expect(screen.queryByRole('option', { name })).toBeNull()
    }
  })

  it('filters Providers from the header search', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({
        solid: readySolid(),
      }),
    )

    render(<>{mounted.listHeader}{mounted.list}</>)
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索服务商' }), {
      target: { value: 'kimi' },
    })

    expect(screen.getByRole('option', { name: 'Xpod' })).toBeTruthy()
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

  it('opens the main pane when the current API Keys workspace is reactivated in stack mode', () => {
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

    fireEvent.click(screen.getByRole('option', { name: 'Xpod' }))

    const mainPane = screen.getByTestId('workspace-main-pane')
    expect(mainPane).not.toHaveProperty('hidden', true)
    expect(document.activeElement).toBe(mainPane)
  })

  it('gates the provider list through the host drawer in stack mode and opens main on selection', () => {
    const mounted = mountTwoPaneApplet(
      aiConnectionApplet,
      createMockWebExtensionHost({ solid: readySolid() }),
    )

    const tree = (open: boolean) => (
      <WorkspaceDrawerContext.Provider value={{ open }}>
        <TwoPaneLayout
          mode="stack"
          listHeader={mounted.listHeader}
          list={mounted.list}
          mainHeader={mounted.mainHeader}
          main={mounted.main}
        />
      </WorkspaceDrawerContext.Provider>
    )

    const { rerender } = render(tree(false))

    // A host drawer owns the workspace list: while it is closed the list pane is
    // hidden and Playwright's role query cannot reach the AI listbox.
    expect(screen.getByTestId('workspace-list-pane').hidden).toBe(true)
    expect(screen.queryByRole('listbox', { name: 'AI 服务' })).toBeNull()

    // The RC narrow acceptance opens the drawer first, then selects a Provider.
    rerender(tree(true))
    expect(screen.getByTestId('workspace-list-pane').hidden).toBe(false)
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI', exact: true }))

    expect(document.querySelector('[data-workspace-active-pane]')?.getAttribute('data-workspace-active-pane')).toBe('main')
    expect(screen.getByRole('region', { name: 'OpenAI 详情' })).toBeTruthy()
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

    expect(screen.getByRole('dialog', { name: '添加自定义服务商' })).toBeTruthy()
  })
})
