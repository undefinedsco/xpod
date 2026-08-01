import { type CSSProperties, type ReactNode } from 'react'
import { cn } from '@undefineds.co/shared-ui'

export interface AppLayoutProps {
  navigation: ReactNode
  children: ReactNode
  className?: string
}

const appLayoutGridStyle = {
  gridTemplateColumns: '60px minmax(0, 1fr)',
} satisfies CSSProperties

export function AppLayout({
  navigation,
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
      <aside className="min-h-0 overflow-hidden border-r border-border/50 bg-layout-sidebar">
        {navigation}
      </aside>
      <div className="min-h-0 min-w-0 overflow-hidden bg-layout-content">
        {children}
      </div>
    </section>
  )
}
