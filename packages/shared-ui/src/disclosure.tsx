import * as React from 'react'
import { interactiveFocusClass } from './focus'
import { cn } from './utils'

/** Native disclosure semantics with the shared precise-pointer target size. */
export const DisclosureSummary = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <summary ref={ref} className={cn('min-h-9 min-w-9 cursor-pointer rounded-md py-1.5 text-sm leading-normal', interactiveFocusClass, className)} {...props} />
  ),
)
DisclosureSummary.displayName = 'DisclosureSummary'
