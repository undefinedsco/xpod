import { useState, type ReactNode } from 'react'
import { ArrowLeft, Menu } from 'lucide-react'
import {
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@undefineds.co/shared-ui'

export interface AppLayoutProps {
  navigation: ReactNode
  children: ReactNode
  className?: string
  /** 窄窗任务栏的标题（spec §8.3）。宽窗由页面自己的标题承担。 */
  narrowTitle?: ReactNode
  /** 提供时，窄窗任务栏显示返回按钮。 */
  onNarrowBack?: () => void
  narrowBackLabel?: string
  /** 导航按钮与抽屉的名字；抽屉复用同一棵导航树。 */
  navigationLabel?: string
}

/**
 * 工作区布局（spec §8.3）：
 * - ≥768px（Tailwind `md`，与 `XPOD_LAYOUT_BREAKPOINTS.narrow` 对齐）：184px 文字导航 + 内容；
 * - <768px：48px 顶部任务栏（返回、标题、有名称的导航按钮）+ 单面板，导航树放进抽屉，不强制底部 Tab。
 */
export function AppLayout({
  navigation,
  children,
  className,
  narrowTitle,
  onNarrowBack,
  narrowBackLabel = '返回',
  navigationLabel = '导航',
}: AppLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <section
      className={cn(
        'grid h-screen min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] bg-background md:grid-cols-[184px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]',
        className,
      )}
      data-app-layout="workspace"
    >
      <header
        className="col-start-1 row-start-1 flex h-12 min-w-0 items-center gap-1 border-b border-border/50 bg-layout-sidebar px-1 md:hidden"
        data-app-layout-header
      >
        {onNarrowBack ? (
          <button
            type="button"
            onClick={onNarrowBack}
            aria-label={narrowBackLabel}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-foreground hover:bg-accent focus:outline-none focus-visible:bg-accent"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium" data-app-layout-title>
          {narrowTitle}
        </div>
        <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DialogTrigger asChild>
            <button
              type="button"
              className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm text-foreground hover:bg-accent focus:outline-none focus-visible:bg-accent"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
              {navigationLabel}
            </button>
          </DialogTrigger>
          <DialogContent variant="sheet-left" aria-describedby={undefined}>
            <DialogTitle className="sr-only">{navigationLabel}</DialogTitle>
            {navigation}
          </DialogContent>
        </Dialog>
      </header>
      <aside
        className="row-start-2 hidden min-h-0 overflow-hidden border-border/50 bg-layout-sidebar md:row-start-1 md:block md:border-r"
        data-app-layout-navigation
      >
        {navigation}
      </aside>
      <div
        className="col-start-1 row-start-2 min-h-0 min-w-0 overflow-hidden bg-layout-content md:col-start-2 md:row-start-1"
        data-app-layout-content
      >
        {children}
      </div>
    </section>
  )
}
