import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react'
import { interactiveFocusClass } from './focus'
import { cn } from './utils'

interface WorkspaceNavigation {
  mode: 'split' | 'stack'
  activePane: 'list' | 'main'
  mobilePane: 'list' | 'main'
  showMain(): void
  showList(): void
  openMain(): void
  backToList(): void
}

const WorkspaceNavigationContext = createContext<WorkspaceNavigation | null>(null)

export function TwoPaneWorkspace({
  header,
  list,
  main,
  className,
  layoutMode = 'auto',
}: {
  header: ReactNode
  list: ReactNode
  main: ReactNode
  className?: string
  layoutMode?: 'auto' | 'wide' | 'narrow'
}) {
  const [mobilePane, setMobilePane] = useState<'list' | 'main'>('list')
  const showMain = () => setMobilePane('main')
  const showList = () => setMobilePane('list')
  const navigation: WorkspaceNavigation = {
    mode: layoutMode === 'narrow' ? 'stack' : 'split',
    activePane: mobilePane,
    mobilePane,
    showMain,
    showList,
    openMain: showMain,
    backToList: showList,
  }

  return (
    <WorkspaceNavigationContext.Provider value={navigation}>
      <div
        className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}
        data-applet-layout="two-pane"
      >
        <header
          className="h-16 shrink-0 border-b border-border bg-layout-content"
          data-testid="applet-header-pane"
        >
          {header}
        </header>
        <div
        className={cn(
          'grid min-h-0 flex-1',
          layoutMode === 'narrow'
            ? 'grid-cols-1'
            : 'grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)]',
          layoutMode === 'auto' && 'max-md:grid-cols-1',
        )}
        data-layout-mode={layoutMode}
        data-mobile-pane={mobilePane}
      >
        <aside
          className={cn(
          'min-h-0 overflow-y-auto border-r bg-card @container',
          layoutMode !== 'wide' && 'max-md:border-r-0',
          layoutMode === 'narrow' && mobilePane === 'main' && 'hidden',
          layoutMode === 'auto' && mobilePane === 'main' && 'max-md:hidden',
          )}
          data-applet-pane="list"
          data-testid="applet-list-pane"
        >
          {list}
        </aside>
        <div className={cn(
          'min-h-0 overflow-y-auto bg-background @container',
          layoutMode === 'narrow' && mobilePane === 'list' && 'hidden',
          layoutMode === 'auto' && mobilePane === 'list' && 'max-md:hidden',
        )} data-applet-pane="main" data-testid="applet-main-pane">
          <button
            type="button"
            className={cn(
              'items-center px-4 py-3 text-sm text-muted-foreground hover:text-foreground',
              interactiveFocusClass,
              layoutMode === 'narrow' ? 'inline-flex' : 'hidden',
              layoutMode === 'auto' && 'max-md:inline-flex',
            )}
            onClick={navigation.showList}
          >
            ← 返回列表
          </button>
          {main}
        </div>
        </div>
      </div>
    </WorkspaceNavigationContext.Provider>
  )
}

export function useAppletLayout(): Pick<
  WorkspaceNavigation,
  'mode' | 'activePane' | 'openMain' | 'backToList'
> {
  const navigation = useContext(WorkspaceNavigationContext)
  if (!navigation) {
    throw new Error('useAppletLayout must be used inside TwoPaneWorkspace')
  }
  return navigation
}

export function AppletList(props: ComponentProps<'nav'>) {
  return <nav className={cn('space-y-1 p-3', props.className)} {...props} />
}

export function AppletListItem({
  selected,
  className,
  onClick,
  ...props
}: ComponentProps<'button'> & { selected?: boolean }) {
  const navigation = useContext(WorkspaceNavigationContext)

  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium',
        interactiveFocusClass,
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        navigation?.showMain()
      }}
      {...props}
    />
  )
}
