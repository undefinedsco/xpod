import { Slot } from '@radix-ui/react-slot'
import * as React from 'react'
import { cn } from './utils'

export type ListSurfaceProps = React.HTMLAttributes<HTMLDivElement>

/**
 * Bordered, divided container for a group of rows. Presentation only: it adds
 * no list role, navigation or focus behaviour of its own.
 */
export const ListSurface = React.forwardRef<HTMLDivElement, ListSurfaceProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('divide-y rounded-xl border border-border bg-card', className)} {...props} />
  ),
)
ListSurface.displayName = 'ListSurface'

export interface ListRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  leading?: React.ReactNode
  title?: React.ReactNode
  description?: React.ReactNode
  trailing?: React.ReactNode
  /**
   * Render the row as the single child element (e.g. an actual `button` or
   * `a`) so native role, keyboard and focus behaviour are preserved. Slots are
   * ignored when `asChild` is set.
   */
  asChild?: boolean
}

/**
 * Pure row composition. A non-interactive row is a semantic container; nested
 * controls stay legal. Interactive rows must pass a real control via `asChild`
 * so no `role="button"` is synthesised on a `div`.
 */
export const ListRow = React.forwardRef<HTMLDivElement, ListRowProps>(
  ({ className, leading, title, description, trailing, asChild = false, children, ...props }, ref) => {
    const rowClassName = cn('flex flex-wrap items-center gap-3 p-4 text-sm leading-normal', className)
    const Component = asChild ? Slot : 'div'
    return (
      <Component ref={ref} className={rowClassName} {...props}>
        {asChild ? (
          children
        ) : (
          <>
            {leading ? <span className="shrink-0">{leading}</span> : null}
            <div className="min-w-0 flex-1 break-words">
              {title ? <div>{title}</div> : null}
              {description ? <p className="mt-0.5 text-xs leading-normal text-muted-foreground">{description}</p> : null}
            </div>
            {trailing ? <span className="shrink-0">{trailing}</span> : null}
            {children ? <div className="w-full min-w-0 break-words">{children}</div> : null}
          </>
        )}
      </Component>
    )
  },
)
ListRow.displayName = 'ListRow'
