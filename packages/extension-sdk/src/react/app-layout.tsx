import { type CSSProperties, type ReactNode } from 'react'
import { cn } from '@undefineds.co/shared-ui'

export interface AppLayoutProps {
  navigation: ReactNode
  header?: ReactNode
  children: ReactNode
  className?: string
}

const appLayoutGridStyle = {
  gridTemplateColumns: '240px minmax(0, 1fr)',
} satisfies CSSProperties

export function AppLayout({
  navigation,
  header,
  children,
  className,
}: AppLayoutProps) {
  return (
    <section
      className={cn(
        'grid h-screen min-h-0 bg-background',
        className,
      )}
      style={appLayoutGridStyle}
      data-app-layout="workspace"
    >
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-layout-list-item">
        {navigation}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-col bg-layout-content">
        {header ? (
          <header className="h-16 shrink-0 border-b border-border">
            {header}
          </header>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </section>
  )
}
