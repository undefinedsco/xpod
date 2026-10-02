import * as React from 'react'
import { cn } from './utils'

export interface SectionHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  level?: 2 | 3 | 4
  titleClassName?: string
}

/**
 * Pure section heading composition. The owning app supplies every label and
 * action; `level` keeps the original document outline (h2/h3/h4).
 */
export function SectionHeader({
  title,
  description,
  actions,
  level = 2,
  titleClassName,
  className,
  ...props
}: SectionHeaderProps) {
  const headingClassName = cn('text-sm leading-normal text-foreground', titleClassName)
  return (
    <div {...props} className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {level === 3 ? (
          <h3 className={headingClassName}>{title}</h3>
        ) : level === 4 ? (
          <h4 className={headingClassName}>{title}</h4>
        ) : (
          <h2 className={headingClassName}>{title}</h2>
        )}
        {description ? <p className="mt-1 text-xs leading-normal text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
