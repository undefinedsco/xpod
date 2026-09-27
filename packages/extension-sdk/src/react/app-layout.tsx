import { type ReactNode } from 'react'
import { cn } from '@undefineds.co/shared-ui'

export interface AppLayoutProps {
  navigation: ReactNode
  children: ReactNode
  className?: string
}

export function AppLayout({
  navigation,
  children,
  className,
}: AppLayoutProps) {
  return (
    <section
      className={cn(
        // §8.3：≥768px（Tailwind md）为 184px 文字导航 + 内容；<768px 仍走紧凑任务栏
        'grid h-screen min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_64px] bg-background md:grid-cols-[184px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]',
        className,
      )}
      data-app-layout="workspace"
    >
      <aside
        className="row-start-2 min-h-0 overflow-x-auto overflow-y-hidden border-t border-border/50 bg-layout-sidebar md:col-start-1 md:row-start-1 md:overflow-hidden md:border-r md:border-t-0"
        data-app-layout-navigation
      >
        {navigation}
      </aside>
      <div
        className="col-start-1 row-start-1 min-h-0 min-w-0 overflow-hidden bg-layout-content md:col-start-2"
        data-app-layout-content
      >
        {children}
      </div>
    </section>
  )
}
