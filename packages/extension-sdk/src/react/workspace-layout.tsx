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
  resolveAppletPanePlan,
  XPOD_LAYOUT_BREAKPOINTS,
  XPOD_LAYOUT_RAIL_WIDTH,
  type AppletPageType,
} from '../layout'
import {
  WorkspaceLayoutContext,
  type WorkspaceLayoutMode,
  type WorkspaceLayoutNavigation,
  type WorkspaceLayoutPane,
} from './layout-context'

export type TwoPaneLayoutMode = 'auto' | WorkspaceLayoutMode

export interface WorkspacePageTypeProps {
  /**
   * §8.3 页型。概览、固定配置、诊断不会渲染对象列；只有 `collection` 且确有集合才在宽断点出现。
   * 默认保持旧行为（集合页 + 有集合），新页面应显式声明。
   */
  pageType?: AppletPageType
  hasObjectCollection?: boolean
}

export interface TwoPaneLayoutProps extends WorkspacePageTypeProps {
  listHeader: ReactNode
  list: ReactNode
  mainHeader: ReactNode
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

export interface ThreePaneLayoutProps extends WorkspacePageTypeProps {
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

/**
 * 对象列的可用宽度媒体查询：§8.3 的 1100px 是**内容**宽度，宽窗口还有一个 184px 导航列，
 * 所以视口阈值要加上它。
 */
const objectColumnMediaQuery = `(min-width: ${XPOD_LAYOUT_BREAKPOINTS.wideObjects + XPOD_LAYOUT_RAIL_WIDTH}px)`

/**
 * 是否够放对象列。
 *
 * 没有 `matchMedia` 的环境（服务端渲染、旧测试环境）按宽窗口处理——与 `getServerAutoModeSnapshot`
 * 的既有默认一致：产品主要跑在桌面壳里，未知环境不应把已有的两栏布局变成堆叠。
 */
function useRoomForObjectColumn(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined
      }
      const media = window.matchMedia(objectColumnMediaQuery)
      media.addEventListener('change', onStoreChange)
      return () => media.removeEventListener('change', onStoreChange)
    },
    () => (typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia(objectColumnMediaQuery).matches),
    () => true,
  )
}

/**
 * 把 §8.3 的页型、宽度与集合事实落到布局上：复用 `resolveAppletPanePlan` 作为唯一判断处，
 * 概览/固定配置/诊断在任何宽度都不出现对象列，集合页在 1100px 以下改为堆叠。
 */
function useObjectColumn(input: {
  mode: TwoPaneLayoutMode
  pageType: AppletPageType
  hasObjectCollection: boolean
}): { resolvedMode: WorkspaceLayoutMode; showObjectColumn: boolean } {
  const narrow = useSyncExternalStore(
    subscribeToStackModeChange,
    getAutoModeSnapshot,
    getServerAutoModeSnapshot,
  ) === 'stack'
  const roomForObjects = useRoomForObjectColumn()
  // 只需要区分三个区间，因此给 plan 一个能代表当前区间的宽度
  const contentWidth = roomForObjects
    ? XPOD_LAYOUT_BREAKPOINTS.wideObjects
    : narrow
      ? XPOD_LAYOUT_BREAKPOINTS.narrow - 1
      : XPOD_LAYOUT_BREAKPOINTS.narrow
  const plan = resolveAppletPanePlan({
    pageType: input.pageType,
    contentWidth,
    hasObjectCollection: input.hasObjectCollection,
  })
  // §8.3：只有真正的集合列出现时才是并排；其余（含窄窗的集合页）都走 list→detail 的堆叠
  const autoMode: WorkspaceLayoutMode = plan.panes === 'list-detail' ? 'split' : 'stack'
  return {
    resolvedMode: input.mode === 'auto' ? autoMode : input.mode,
    showObjectColumn: plan.showObjectColumn,
  }
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
  listHeader,
  list,
  mainHeader,
  main,
  mode = 'auto',
  history,
  className,
  pageType = 'collection',
  hasObjectCollection = true,
}: TwoPaneLayoutProps) {
  const { resolvedMode } = useObjectColumn({ mode, pageType, hasObjectCollection })
  // §8.3：非集合页不渲染对象列；集合页只有宽断点才显示
  // §8.3：只有集合页才有对象列表；宽度决定它是并排的对象列还是堆叠的第一屏
  const showList = pageType === 'collection' && hasObjectCollection
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
  const stacked = showList && isStack
  const listHidden = !showList || (stacked && activePane !== 'list')
  const mainHidden = stacked && activePane !== 'main'

  return (
    <WorkspaceLayoutContext.Provider value={navigation}>
      <section
        className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
        data-workspace-layout="two-pane"
        data-workspace-mode={resolvedMode}
      >
        <div
          className={cn(
            'grid min-h-0 flex-1',
            stacked || !showList ? 'grid-cols-1' : null,
          )}
          style={stacked || !showList ? undefined : twoPaneGridStyle}
          data-workspace-layout-mode={mode}
          data-workspace-object-column={showList && resolvedMode === 'split' ? 'shown' : 'hidden'}
          data-workspace-active-pane={activePane}
        >
          <aside
            ref={paneRefs.list}
            className={cn(
              'min-h-0 flex-col overflow-hidden bg-layout-list-item @container',
              listHidden ? 'hidden' : 'flex',
              stacked ? 'border-r-0' : 'border-r border-border',
            )}
            data-testid="workspace-list-pane"
            data-workspace-pane="list"
            hidden={listHidden}
            tabIndex={stacked ? -1 : undefined}
          >
            <header
              className="h-12 shrink-0 border-b border-border bg-layout-list-header"
              data-workspace-list-header="true"
            >
              {listHeader}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {list}
            </div>
          </aside>
          <main
            ref={paneRefs.main}
            className={cn(
              'min-h-0 flex-col overflow-hidden bg-layout-content @container',
              mainHidden ? 'hidden' : 'flex',
            )}
            data-testid="workspace-main-pane"
            data-workspace-pane="main"
            hidden={mainHidden}
            tabIndex={stacked ? -1 : undefined}
          >
            <header
              className="h-12 shrink-0 border-b border-border bg-layout-content"
              data-workspace-main-header="true"
            >
              {mainHeader}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {stacked ? (
                <button
                  type="button"
                  className="inline-flex items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground"
                  onClick={openList}
                >
                  返回列表
                </button>
              ) : null}
              {main}
            </div>
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
  pageType = 'collection',
  hasObjectCollection = true,
}: ThreePaneLayoutProps) {
  const { resolvedMode } = useObjectColumn({ mode, pageType, hasObjectCollection })
  // §8.3：非集合页不渲染对象列
  // §8.3：只有集合页才有对象列表；宽度决定它是并排的对象列还是堆叠的第一屏
  const showList = pageType === 'collection' && hasObjectCollection
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
  const stacked = showList && isStack
  const listHidden = !showList || (stacked && activePane !== 'list')
  const mainHidden = stacked && activePane !== 'main'
  const contextHidden = stacked
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
        {contextConfig?.collapsible && !stacked ? (
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
            stacked ? 'grid-cols-1' : null,
          )}
          style={stacked || !showList ? undefined : threePaneGridStyle}
          data-workspace-layout-mode={mode}
          data-workspace-active-pane={activePane}
        >
          <aside
            ref={paneRefs.list}
            className={cn(
              'min-h-0 overflow-y-auto bg-layout-list-item @container',
              listHidden ? 'hidden' : null,
              stacked ? 'border-r-0' : 'border-r border-border',
            )}
            data-testid="workspace-list-pane"
            data-workspace-pane="list"
            hidden={listHidden}
            tabIndex={stacked ? -1 : undefined}
          >
            {list}
          </aside>
          <main
            ref={paneRefs.main}
            className={cn(
              'min-h-0 overflow-y-auto bg-layout-content @container',
              mainHidden ? 'hidden' : null,
            )}
            data-testid="workspace-main-pane"
            data-workspace-pane="main"
            hidden={mainHidden}
            tabIndex={stacked ? -1 : undefined}
          >
            {stacked ? (
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
              contextHidden ? 'hidden' : null,
              stacked ? 'border-l-0' : 'border-l border-border',
            )}
            data-testid="workspace-context-pane"
            data-workspace-pane="context"
            hidden={contextHidden}
            tabIndex={stacked ? -1 : undefined}
          >
            {stacked ? (
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
