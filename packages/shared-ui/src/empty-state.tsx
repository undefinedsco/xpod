import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from './utils'

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
}

/** Optional content and actions are supplied by the owning app. */
export function EmptyState({ title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div {...props} className={cn('flex flex-col items-start gap-2 py-6 text-sm text-muted-foreground', className)}>
      {title ? <h3 className="font-medium text-foreground">{title}</h3> : null}
      {description ? <div>{description}</div> : null}
      {action}
    </div>
  )
}
