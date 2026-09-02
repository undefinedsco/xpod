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
        'grid h-screen min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_64px] bg-background sm:grid-cols-[60px_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)]',
        className,
      )}
      data-app-layout="workspace"
    >
      <aside
        className="row-start-2 min-h-0 overflow-x-auto overflow-y-hidden border-t border-border/50 bg-layout-sidebar sm:col-start-1 sm:row-start-1 sm:overflow-hidden sm:border-r sm:border-t-0"
        data-app-layout-navigation
      >
        {navigation}
      </aside>
      <div
        className="col-start-1 row-start-1 min-h-0 min-w-0 overflow-hidden bg-layout-content sm:col-start-2"
        data-app-layout-content
      >
        {children}
      </div>
    </section>
  )
}
