import * as React from 'react'
import { cn } from './utils'

/**
 * Canonical semantic tones shared by the visual feedback primitives.
 * Callers map their own domain states onto these names; the components never
 * branch on provider or business vocabulary.
 */
export type StatusTone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral'

const dotToneClass: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  // No dedicated `--info` token exists; `info` intentionally maps to `--primary`.
  info: 'bg-primary',
  neutral: 'border border-muted-foreground bg-transparent',
}

const dotSizeClass = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
} as const

export interface StatusDotProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone: StatusTone
  /**
   * Accessible name for a standalone dot. Omit it when adjacent visible text
   * already names the status so the meaning is not announced twice.
   */
  label?: string
  size?: keyof typeof dotSizeClass
}

/**
 * A small colour dot that never relies on colour alone: either it carries a
 * `label`, or it is decorative next to visible text.
 */
export function StatusDot({ tone, label, size = 'md', className, 'aria-label': ariaLabel, ...props }: StatusDotProps) {
  const accessibleName = label ?? ariaLabel
  const accessibleProps = accessibleName
    ? { role: 'img' as const, 'aria-label': accessibleName, title: accessibleName }
    : { 'aria-hidden': true as const }
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', dotSizeClass[size], dotToneClass[tone], className)}
      {...props}
      {...accessibleProps}
    />
  )
}

export interface StatusLineProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone
  /** Visible status text; it is the accessible name for the line. */
  children: React.ReactNode
  /** Dot size; defaults to the denser `sm` used by inline status rows. */
  dotSize?: keyof typeof dotSizeClass
}

/** Dot + visible status word. The dot is decorative so nothing is announced twice. */
export function StatusLine({ tone, children, dotSize = 'sm', className, ...props }: StatusLineProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} {...props}>
      <StatusDot tone={tone} size={dotSize} />
      <span>{children}</span>
    </span>
  )
}
