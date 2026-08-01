import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from 'react'
import { cn } from '@undefineds.co/shared-ui'
import {
  WorkspaceLayoutContext,
  type WorkspaceLayoutMode,
  type WorkspaceLayoutNavigation,
  type WorkspaceLayoutPane,
} from './layout-context'

export type TwoPaneLayoutMode = 'auto' | WorkspaceLayoutMode

export interface TwoPaneLayoutProps {
  header?: ReactNode
  list: ReactNode
  main: ReactNode
  mode?: TwoPaneLayoutMode
  history?: WorkspaceLayoutHistoryAdapter
  className?: string
}

export interface SinglePaneLayoutProps {
  header?: ReactNode
  main: ReactNode
  className?: string
}

export interface ThreePaneLayoutContextConfig {
  collapsible?: boolean
  initiallyCollapsed?: boolean
}

export interface ThreePaneLayoutProps {
  header?: ReactNode
  list: ReactNode
  main: ReactNode
  context: ReactNode
  mode?: TwoPaneLayoutMode
  history?: WorkspaceLayoutHistoryAdapter
  contextConfig?: ThreePaneLayoutContextConfig
  className?: string
}

export interface WorkspaceLayoutHistoryAdapter {
  push(pane: WorkspaceLayoutPane): void
  subscribe(listener: (pane: WorkspaceLayoutPane) => void): () => void
}

const stackMediaQuery = '(max-width: 767px)'
const twoPaneGridStyle = {
  gridTemplateColumns: '210px minmax(0, 1fr)',
} satisfies CSSProperties
const threePaneGridStyle = {
  gridTemplateColumns: '210px minmax(0, 1fr) minmax(240px, 320px)',
} satisfies CSSProperties

function mapContextPaneToMain(pane: WorkspaceLayoutPane): WorkspaceLayoutPane {
  return pane === 'context' ? 'main' : pane
}

function subscribeToStackModeChange(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined
  }

  const media = window.matchMedia(stackMediaQuery)
  media.addEventListener('change', onStoreChange)
  return () => media.removeEventListener('change', onStoreChange)
}

function getAutoModeSnapshot(): WorkspaceLayoutMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'split'
  }

  return window.matchMedia(stackMediaQuery).matches ? 'stack' : 'split'
}

function getServerAutoModeSnapshot(): WorkspaceLayoutMode {
  return 'split'
}

function useResolvedMode(mode: TwoPaneLayoutMode): WorkspaceLayoutMode {
  const autoMode = useSyncExternalStore(
    subscribeToStackModeChange,
    getAutoModeSnapshot,
    getServerAutoModeSnapshot,
  )

  return mode === 'auto' ? autoMode : mode
}

function useStackNavigation({
  resolvedMode,
  history,
  resolvePane,
}: {
  resolvedMode: WorkspaceLayoutMode
  history?: WorkspaceLayoutHistoryAdapter
  resolvePane?: (pane: WorkspaceLayoutPane) => WorkspaceLayoutPane
}) {
  const [activePane, setActivePane] = useState<WorkspaceLayoutPane>('list')
  const focusPaneRef = useRef<WorkspaceLayoutPane | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const contextRef = useRef<HTMLElement>(null)
  const paneRefs = useMemo<Record<WorkspaceLayoutPane, RefObject<HTMLElement | null>>>(() => ({
    list: listRef,
    main: mainRef,
    context: contextRef,
  }), [])
  const navigate = useCallback((
    requestedPane: WorkspaceLayoutPane,
    options: { fromHistory?: boolean } = {},
  ) => {
    const nextPane = resolvePane?.(requestedPane) ?? requestedPane
    setActivePane(nextPane)
    if (resolvedMode !== 'stack') {
      return
    }
    focusPaneRef.current = nextPane
    if (!options.fromHistory) {
      history?.push(nextPane)
    }
  }, [history, resolvePane, resolvedMode])
  const openList = useCallback(() => navigate('list'), [navigate])
  const openMain = useCallback(() => navigate('main'), [navigate])
  const openContext = useCallback(() => navigate('context'), [navigate])

  useLayoutEffect(() => {
    if (resolvedMode !== 'stack') {
      focusPaneRef.current = null
      return
    }
    const pane = focusPaneRef.current
    if (!pane) {
      return
    }
    focusPaneRef.current = null
    paneRefs[pane].current?.focus()
  }, [activePane, paneRefs, resolvedMode])

  useLayoutEffect(() => {
    if (resolvedMode !== 'stack' || !history) {
      return undefined
    }

    return history.subscribe((pane) => {
      navigate(pane, { fromHistory: true })
    })
  }, [history, navigate, resolvedMode])

  return {
    activePane,
    paneRefs,
    openList,
    openMain,
    openContext,
  }
}

export function TwoPaneLayout({
  header,
  list,
  main,
  mode = 'auto',
  history,
  className,
}: TwoPaneLayoutProps) {
  const resolvedMode = useResolvedMode(mode)
  const {
    activePane,
    paneRefs,
    openList,
    openMain,
    openContext,
  } = useStackNavigation({
    resolvedMode,
    history,
    resolvePane: mapContextPaneToMain,
  })
  const navigation = useMemo<WorkspaceLayoutNavigation>(() => ({
    mode: resolvedMode,
    activePane,
    openList,
    openMain,
    openContext,
  }), [activePane, openContext, openList, openMain, resolvedMode])
  const isStack = resolvedMode === 'stack'
  const listHidden = isStack && activePane !== 'list'
  const mainHidden = isStack && activePane !== 'main'

  return (
    <WorkspaceLayoutContext.Provider value={navigation}>
      <section
        className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
        data-workspace-layout="two-pane"
        data-workspace-mode={resolvedMode}
      >
        {header ? (
          <header className="h-16 shrink-0 border-b border-border bg-layout-content">
            {header}
          </header>
        ) : null}
        <div
          className={cn(
            'grid min-h-0 flex-1',
            isStack ? 'grid-cols-1' : null,
          )}
          style={isStack ? undefined : twoPaneGridStyle}
          data-workspace-layout-mode={mode}
          data-workspace-active-pane={activePane}
        >
          <aside
            ref={paneRefs.list}
            className={cn(
              'min-h-0 overflow-y-auto bg-layout-list-item @container',
              isStack ? 'border-r-0' : 'border-r border-border',
            )}
            data-testid="workspace-list-pane"
            data-workspace-pane="list"
            hidden={listHidden}
            tabIndex={isStack ? -1 : undefined}
          >
            {list}
          </aside>
          <main
            ref={paneRefs.main}
            className="min-h-0 overflow-y-auto bg-layout-content @container"
            data-testid="workspace-main-pane"
            data-workspace-pane="main"
            hidden={mainHidden}
            tabIndex={isStack ? -1 : undefined}
          >
            {isStack ? (
              <button
                type="button"
                className="inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground"
                onClick={openList}
              >
                返回列表
              </button>
            ) : null}
            {main}
          </main>
        </div>
      </section>
    </WorkspaceLayoutContext.Provider>
  )
}

export function SinglePaneLayout({
  header,
  main,
  className,
}: SinglePaneLayoutProps) {
  return (
    <section
      className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
      data-workspace-layout="single-pane"
    >
      {header ? (
        <header className="h-16 shrink-0 border-b border-border bg-layout-content">
          {header}
        </header>
      ) : null}
      <main
        className="min-h-0 flex-1 overflow-y-auto bg-layout-content @container"
        data-testid="workspace-content-pane"
        data-workspace-pane="content"
      >
        {main}
      </main>
    </section>
  )
}

export function ThreePaneLayout({
  header,
  list,
  main,
  context,
  mode = 'auto',
  history,
  contextConfig,
  className,
}: ThreePaneLayoutProps) {
  const resolvedMode = useResolvedMode(mode)
  const [contextCollapsed, setContextCollapsed] = useState(
    contextConfig?.initiallyCollapsed ?? false,
  )
  const {
    activePane,
    paneRefs,
    openList,
    openMain,
    openContext,
  } = useStackNavigation({ resolvedMode, history })
  const toggleContextCollapsed = useCallback(() => {
    setContextCollapsed((collapsed) => !collapsed)
  }, [])
  const navigation = useMemo<WorkspaceLayoutNavigation>(() => ({
    mode: resolvedMode,
    activePane,
    openList,
    openMain,
    openContext,
  }), [activePane, openContext, openList, openMain, resolvedMode])
  const isStack = resolvedMode === 'stack'
  const listHidden = isStack && activePane !== 'list'
  const mainHidden = isStack && activePane !== 'main'
  const contextHidden = isStack
    ? activePane !== 'context'
    : Boolean(contextConfig?.collapsible && contextCollapsed)

  return (
    <WorkspaceLayoutContext.Provider value={navigation}>
      <section
        className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
        data-workspace-layout="three-pane"
        data-workspace-mode={resolvedMode}
      >
        {header ? (
          <header className="h-16 shrink-0 border-b border-border bg-layout-content">
            {header}
          </header>
        ) : null}
        {contextConfig?.collapsible && !isStack ? (
          <div className="shrink-0 border-b border-border bg-layout-content px-3 py-2">
            <button
              type="button"
              aria-expanded={!contextCollapsed}
              className="inline-flex items-center rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={toggleContextCollapsed}
            >
              {contextCollapsed ? '展开上下文面板' : '折叠上下文面板'}
            </button>
          </div>
        ) : null}
        <div
          className={cn(
            'grid min-h-0 flex-1',
            isStack ? 'grid-cols-1' : null,
          )}
          style={isStack ? undefined : threePaneGridStyle}
          data-workspace-layout-mode={mode}
          data-workspace-active-pane={activePane}
        >
          <aside
            ref={paneRefs.list}
            className={cn(
              'min-h-0 overflow-y-auto bg-layout-list-item @container',
              isStack ? 'border-r-0' : 'border-r border-border',
            )}
            data-testid="workspace-list-pane"
            data-workspace-pane="list"
            hidden={listHidden}
            tabIndex={isStack ? -1 : undefined}
          >
            {list}
          </aside>
          <main
            ref={paneRefs.main}
            className="min-h-0 overflow-y-auto bg-layout-content @container"
            data-testid="workspace-main-pane"
            data-workspace-pane="main"
            hidden={mainHidden}
            tabIndex={isStack ? -1 : undefined}
          >
            {isStack ? (
              <button
                type="button"
                className="inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground"
                onClick={openList}
              >
                返回列表
              </button>
            ) : null}
            {main}
          </main>
          <aside
            ref={paneRefs.context}
            className={cn(
              'min-h-0 overflow-y-auto bg-layout-content @container',
              isStack ? 'border-l-0' : 'border-l border-border',
            )}
            data-testid="workspace-context-pane"
            data-workspace-pane="context"
            hidden={contextHidden}
            tabIndex={isStack ? -1 : undefined}
          >
            {isStack ? (
              <button
                type="button"
                className="inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground"
                onClick={openMain}
              >
                返回主区域
              </button>
            ) : null}
            {context}
          </aside>
        </div>
      </section>
    </WorkspaceLayoutContext.Provider>
  )
}
