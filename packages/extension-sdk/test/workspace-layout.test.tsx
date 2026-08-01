// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SinglePaneLayout,
  ThreePaneLayout,
  TwoPaneLayout,
  useWorkspaceLayout,
} from '../src/react'

describe('SinglePaneLayout', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows an optional header and a scrollable content pane', () => {
    render(
      <SinglePaneLayout
        header={<h1>Models</h1>}
        main={<section aria-label="Model workspace">Content</section>}
        className="sdk-shell"
      />,
    )

    const layout = screen.getByText('Models').closest('[data-workspace-layout]')
    const contentPane = screen.getByTestId('workspace-content-pane')

    expect(layout?.getAttribute('data-workspace-layout')).toBe('single-pane')
    expect(layout?.className).toContain('sdk-shell')
    expect(contentPane.getAttribute('data-workspace-pane')).toBe('content')
    expect(screen.getByRole('heading', { name: 'Models' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Model workspace' })).toBeTruthy()
  })
})

describe('ThreePaneLayout', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    cleanup()
    window.matchMedia = originalMatchMedia
  })

  it('shows list, main, and context panes together in split mode', () => {
    render(
      <ThreePaneLayout
        mode="split"
        list={<nav aria-label="Model list">List</nav>}
        main={<section aria-label="Model detail">Main</section>}
        context={<aside aria-label="Model tools">Context</aside>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')
    const contextPane = screen.getByTestId('workspace-context-pane')
    const grid = listPane.parentElement

    expect(listPane.getAttribute('data-workspace-pane')).toBe('list')
    expect(mainPane.getAttribute('data-workspace-pane')).toBe('main')
    expect(contextPane.getAttribute('data-workspace-pane')).toBe('context')
    expect(grid?.getAttribute('style')).toContain(
      'grid-template-columns: 210px minmax(0, 1fr) minmax(240px, 320px)',
    )
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(false)
    expect(contextPane.hidden).toBe(false)
    expect(screen.getByRole('navigation', { name: 'Model list' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Model detail' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Model tools' })).toBeTruthy()
  })

  it('stacks panes and navigates list to main to context and back to main', () => {
    function ListContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openMain}>
          打开模型
        </button>
      )
    }

    function MainContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openContext}>
          打开上下文
        </button>
      )
    }

    render(
      <ThreePaneLayout
        mode="stack"
        list={<ListContent />}
        main={<MainContent />}
        context={<section aria-label="上下文">Context</section>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')
    const contextPane = screen.getByTestId('workspace-context-pane')

    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)
    expect(contextPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开模型' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)
    expect(contextPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开上下文' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(true)
    expect(contextPane.hidden).toBe(false)
    expect(screen.getByRole('region', { name: '上下文' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '返回主区域' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)
    expect(contextPane.hidden).toBe(true)
  })

  it('lets a collapsible context pane start collapsed and toggle accessibly', () => {
    render(
      <ThreePaneLayout
        mode="split"
        list={<nav aria-label="Model list">List</nav>}
        main={<section aria-label="Model detail">Main</section>}
        context={<aside aria-label="Model tools">Context</aside>}
        contextConfig={{ collapsible: true, initiallyCollapsed: true }}
      />,
    )

    const contextPane = screen.getByTestId('workspace-context-pane')
    const toggle = screen.getByRole('button', { name: '展开上下文面板' })

    expect(contextPane.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)

    expect(contextPane.hidden).toBe(false)
    expect(screen.getByRole('button', { name: '折叠上下文面板' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('hides the context collapse toggle in stack mode because navigation controls visibility', () => {
    function ListContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openContext}>
          打开上下文
        </button>
      )
    }

    render(
      <ThreePaneLayout
        mode="stack"
        list={<ListContent />}
        main={<section aria-label="Model detail">Main</section>}
        context={<section aria-label="上下文">Context</section>}
        contextConfig={{ collapsible: true, initiallyCollapsed: true }}
      />,
    )

    const contextPane = screen.getByTestId('workspace-context-pane')

    expect(screen.queryByRole('button', { name: '展开上下文面板' })).toBeNull()
    expect(contextPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开上下文' }))

    expect(contextPane.hidden).toBe(false)
    expect(screen.getByRole('region', { name: '上下文' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '折叠上下文面板' })).toBeNull()
  })

  it('resolves auto mode with the shared stack media query behavior', () => {
    const media = mockWorkspaceMedia(true)

    render(
      <ThreePaneLayout
        mode="auto"
        list={<nav aria-label="Model list">List</nav>}
        main={<section aria-label="Model detail">Main</section>}
        context={<aside aria-label="Model tools">Context</aside>}
      />,
    )

    const layout = screen.getByTestId('workspace-list-pane').closest('[data-workspace-layout]')
    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')
    const contextPane = screen.getByTestId('workspace-context-pane')

    expect(layout?.getAttribute('data-workspace-mode')).toBe('stack')
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)
    expect(contextPane.hidden).toBe(true)

    act(() => media.setMatches(false))

    expect(layout?.getAttribute('data-workspace-mode')).toBe('split')
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(false)
    expect(contextPane.hidden).toBe(false)
  })
})

describe('TwoPaneLayout', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    cleanup()
    window.matchMedia = originalMatchMedia
  })

  it('shows list and main panes together in split mode', () => {
    render(
      <TwoPaneLayout
        mode="split"
        header={<h1>Providers</h1>}
        list={<nav aria-label="Provider list">List content</nav>}
        main={<section aria-label="Provider details">Main content</section>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')
    const grid = listPane.parentElement

    expect(screen.getByText('Providers')).toBeTruthy()
    expect(listPane.getAttribute('data-workspace-pane')).toBe('list')
    expect(mainPane.getAttribute('data-workspace-pane')).toBe('main')
    expect(grid?.getAttribute('style')).toContain(
      'grid-template-columns: 210px minmax(0, 1fr)',
    )
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(false)
    expect(screen.getByRole('navigation', { name: 'Provider list' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Provider details' })).toBeTruthy()
  })

  it('stacks panes and lets list content navigate to detail and back', () => {
    function ListContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openMain}>
          打开详情
        </button>
      )
    }

    render(
      <TwoPaneLayout
        mode="stack"
        list={<ListContent />}
        main={<section aria-label="详情">Detail content</section>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')

    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开详情' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))

    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)
  })

  it('moves focus and delegates stack history to a host adapter', () => {
    let historyListener: ((pane: 'list' | 'main' | 'context') => void) | undefined
    const history = {
      push: vi.fn(),
      subscribe: (listener: (pane: 'list' | 'main' | 'context') => void) => {
        historyListener = listener
        return () => {
          historyListener = undefined
        }
      },
    }

    function ListContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openMain}>
          打开详情
        </button>
      )
    }

    render(
      <TwoPaneLayout
        mode="stack"
        history={history}
        list={<ListContent />}
        main={<section aria-label="详情">Detail content</section>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')

    fireEvent.click(screen.getByRole('button', { name: '打开详情' }))

    expect(history.push).toHaveBeenCalledWith('main')
    expect(mainPane.hidden).toBe(false)
    expect(document.activeElement).toBe(mainPane)

    act(() => historyListener?.('list'))

    expect(listPane.hidden).toBe(false)
    expect(history.push).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(listPane)
  })

  it('maps context navigation to the main pane in stack mode', () => {
    function ListContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openContext}>
          打开上下文
        </button>
      )
    }

    render(
      <TwoPaneLayout
        mode="stack"
        list={<ListContent />}
        main={<section aria-label="上下文详情">Context content</section>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')

    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开上下文' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)
    expect(screen.getByRole('region', { name: '上下文详情' })).toBeTruthy()
  })

  it('resolves auto mode to split for wide media', () => {
    mockWorkspaceMedia(false)

    render(
      <TwoPaneLayout
        mode="auto"
        list={<nav aria-label="Provider list">List content</nav>}
        main={<section aria-label="Provider details">Main content</section>}
      />,
    )

    const layout = screen.getByTestId('workspace-list-pane').closest('[data-workspace-layout]')
    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')

    expect(layout?.getAttribute('data-workspace-mode')).toBe('split')
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(false)
  })

  it('resolves auto mode to stack for narrow media and preserves navigation on resize', () => {
    function ListContent() {
      const workspace = useWorkspaceLayout()
      return (
        <button type="button" onClick={workspace.openMain}>
          打开详情
        </button>
      )
    }

    const media = mockWorkspaceMedia(true)

    render(
      <TwoPaneLayout
        mode="auto"
        list={<ListContent />}
        main={<section aria-label="详情">Detail content</section>}
      />,
    )

    const layout = screen.getByTestId('workspace-list-pane').closest('[data-workspace-layout]')
    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')

    expect(layout?.getAttribute('data-workspace-mode')).toBe('stack')
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开详情' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)

    act(() => media.setMatches(false))

    expect(layout?.getAttribute('data-workspace-mode')).toBe('split')
    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(false)

    act(() => media.setMatches(true))

    expect(layout?.getAttribute('data-workspace-mode')).toBe('stack')
    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '返回列表' }))

    expect(listPane.hidden).toBe(false)
    expect(mainPane.hidden).toBe(true)
  })

  it('fails with a stable error outside the workspace provider', () => {
    function HookProbe() {
      useWorkspaceLayout()
      return null
    }

    expect(() => render(<HookProbe />)).toThrow(
      'useWorkspaceLayout must be used inside TwoPaneLayout',
    )
  })
})

function mockWorkspaceMedia(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const legacyListeners = new Set<(this: MediaQueryList, event: MediaQueryListEvent) => void>()
  const media = {
    get matches() {
      return matches
    },
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) {
        listeners.add(listener)
      }
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (listener) {
        listeners.delete(listener)
      }
    },
    addListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) => {
      if (listener) {
        legacyListeners.add(listener)
      }
    },
    removeListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) => {
      if (listener) {
        legacyListeners.delete(listener)
      }
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners) {
        if (typeof listener === 'function') {
          listener.call(media, event)
        } else {
          listener.handleEvent(event)
        }
      }
      for (const listener of legacyListeners) {
        listener.call(media, event as MediaQueryListEvent)
      }
      return true
    },
    setMatches: (nextMatches: boolean) => {
      matches = nextMatches
      const event = new Event('change') as MediaQueryListEvent
      Object.defineProperties(event, {
        matches: { value: matches },
        media: { value: '(max-width: 767px)' },
      })
      media.dispatchEvent(event)
    },
  } as MediaQueryList & { setMatches(nextMatches: boolean): void }

  window.matchMedia = () => media
  return media
}
