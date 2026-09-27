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
    expect(listPane.classList.contains('hidden')).toBe(false)
    expect(mainPane.classList.contains('hidden')).toBe(true)
    expect(contextPane.hidden).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '打开模型' }))

    expect(listPane.hidden).toBe(true)
    expect(mainPane.hidden).toBe(false)
    expect(contextPane.hidden).toBe(true)
    expect(listPane.classList.contains('hidden')).toBe(true)
    expect(mainPane.classList.contains('hidden')).toBe(false)
    expect(contextPane.classList.contains('hidden')).toBe(true)

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
    expect(listPane.classList.contains('hidden')).toBe(false)
    expect(mainPane.classList.contains('hidden')).toBe(true)
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
        listHeader={<div>Search providers</div>}
        list={<nav aria-label="Provider list">List content</nav>}
        mainHeader={<h1>Providers</h1>}
        main={<section aria-label="Provider details">Main content</section>}
      />,
    )

    const listPane = screen.getByTestId('workspace-list-pane')
    const mainPane = screen.getByTestId('workspace-main-pane')
    const grid = listPane.parentElement

    expect(screen.getByText('Providers')).toBeTruthy()
    const listHeader = screen.getByText('Search providers').closest('[data-workspace-list-header]')
    const mainHeader = screen.getByText('Providers').closest('[data-workspace-main-header]')
    expect(listHeader?.className).toContain('h-12')
    expect(mainHeader?.className).toContain('h-12')
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
    expect(listPane.classList.contains('hidden')).toBe(true)
    expect(mainPane.classList.contains('hidden')).toBe(false)
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

/**
 * 模拟视口宽度。
 *
 * 过去用一个布尔表示"是否窄窗"。布局现在按 §8.3 分别查询 767px（堆叠）与 1284px
 * （1100 内容 + 184 导航列，够放对象列），所以这里模拟的是宽度：
 * `setMatches(true)` 等价于窄窗 640px，`setMatches(false)` 等价于宽窗 1440px。
 */
function mockWorkspaceMedia(initialMatches: boolean) {
  let viewportWidth = initialMatches ? 640 : 1440
  const lists = new Set<{ query: string; listeners: Set<EventListenerOrEventListenerObject>; legacy: Set<(this: MediaQueryList, event: MediaQueryListEvent) => void>; emit(): void }>()

  const evaluate = (query: string): boolean => {
    const max = /max-width:\s*(\d+)px/u.exec(query)
    if (max) return viewportWidth <= Number(max[1])
    const min = /min-width:\s*(\d+)px/u.exec(query)
    if (min) return viewportWidth >= Number(min[1])
    return false
  }

  const emitAll = (): void => {
    for (const list of lists) list.emit()
  }

  window.matchMedia = ((query: string) => {
    const entry = {
      query,
      listeners: new Set<EventListenerOrEventListenerObject>(),
      legacy: new Set<(this: MediaQueryList, event: MediaQueryListEvent) => void>(),
      emit: () => undefined,
    }
    const media = {
      get matches() {
        return evaluate(query)
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (listener) entry.listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (listener) entry.listeners.delete(listener)
      },
      addListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) => {
        if (listener) entry.legacy.add(listener)
      },
      removeListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) => {
        if (listener) entry.legacy.delete(listener)
      },
      dispatchEvent: () => true,
    } as MediaQueryList
    entry.emit = () => {
      if (typeof media.onchange === 'function') {
        media.onchange.call(media, new Event('change') as MediaQueryListEvent)
      }
      for (const listener of entry.listeners) {
        if (typeof listener === 'function') listener.call(media, new Event('change'))
        else listener.handleEvent(new Event('change'))
      }
      for (const listener of entry.legacy) {
        listener.call(media, new Event('change') as MediaQueryListEvent)
      }
    }
    lists.add(entry)
    return media
  }) as typeof window.matchMedia

  return {
    setMatches: (nextMatches: boolean) => {
      viewportWidth = nextMatches ? 640 : 1440
      emitAll()
    },
    setWidth: (nextWidth: number) => {
      viewportWidth = nextWidth
      emitAll()
    },
  }
}

describe('workspace object column follows the §8.3 page plan', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    cleanup()
    window.matchMedia = originalMatchMedia
  })

  it('never renders an object column for overview, configuration or diagnostics', () => {
    const media = mockWorkspaceMedia(false)
    for (const pageType of ['overview', 'configuration', 'diagnostics'] as const) {
      cleanup()
      render(
        <TwoPaneLayout
          pageType={pageType}
          listHeader={<span>列表</span>}
          list={<span>对象</span>}
          mainHeader={<span>详情</span>}
          main={<span>内容</span>}
        />,
      )
      const listPane = screen.getByTestId('workspace-list-pane')
      expect(listPane.hidden, pageType).toBe(true)
      expect(document.querySelector('[data-workspace-object-column]')?.getAttribute('data-workspace-object-column'))
        .toBe('hidden')
    }
    media.setWidth(1600)
  })

  it('stacks a real collection below the §8.3 wide breakpoint and splits above it', () => {
    const media = mockWorkspaceMedia(false)
    render(
      <TwoPaneLayout
        pageType="collection"
        hasObjectCollection
        listHeader={<span>列表</span>}
        list={<span>对象</span>}
        mainHeader={<span>详情</span>}
        main={<span>内容</span>}
      />,
    )
    expect(document.querySelector('[data-workspace-mode]')?.getAttribute('data-workspace-mode')).toBe('split')

    act(() => media.setWidth(1024))
    expect(document.querySelector('[data-workspace-mode]')?.getAttribute('data-workspace-mode')).toBe('stack')

    act(() => media.setWidth(1440))
    expect(document.querySelector('[data-workspace-mode]')?.getAttribute('data-workspace-mode')).toBe('split')
  })

  it('drops the object column when the view has no real collection', () => {
    mockWorkspaceMedia(false)
    render(
      <TwoPaneLayout
        pageType="collection"
        hasObjectCollection={false}
        listHeader={<span>列表</span>}
        list={<span>对象</span>}
        mainHeader={<span>详情</span>}
        main={<span>内容</span>}
      />,
    )
    expect(screen.getByTestId('workspace-list-pane').hidden).toBe(true)
  })
})
