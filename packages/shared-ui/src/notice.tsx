import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import * as React from 'react'
import { cn } from './utils'

/**
 * Shared semantic tones for inline notices. `neutral` keeps the plain bordered
 * treatment for callers that must not invent a severity.
 */
export type NoticeTone = 'info' | 'success' | 'warning' | 'destructive' | 'neutral'

const noticeToneClass: Record<NoticeTone, string> = {
  info: 'border-primary/30 bg-primary/10 text-foreground',
  success: 'border-success/30 bg-success/10 text-foreground',
  warning: 'border-warning/30 bg-warning/10 text-foreground',
  destructive: 'border-destructive/30 bg-destructive/10 text-foreground',
  neutral: 'border-border bg-muted/30 text-foreground',
}

const noticeIconToneClass: Record<NoticeTone, string> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  neutral: 'text-muted-foreground',
}

const defaultIcons: Record<NoticeTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
  neutral: Info,
}

export interface InlineNoticeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: NoticeTone
  /** Optional heading rendered above the body copy. */
  title?: React.ReactNode
  /** Replaces the neutral default icon; always treated as decorative. */
  icon?: React.ReactNode
  /** Trailing action slot, e.g. a retry button. */
  action?: React.ReactNode
  /**
   * Live-region role. The caller owns it: pass `alert` for errors that must
   * interrupt, and leave the default `status` for polite updates.
   */
  role?: 'status' | 'alert'
}

/**
 * Inline feedback row: icon + copy with an optional action. Pure presentation;
 * the caller supplies copy, the action and the live-region role.
 */
export function InlineNotice({
  tone = 'info',
  title,
  icon,
  action,
  role = 'status',
  className,
  children,
  ...props
}: InlineNoticeProps) {
  const Icon = defaultIcons[tone]
  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm leading-normal',
        noticeToneClass[tone],
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className={cn('mt-0.5 shrink-0', noticeIconToneClass[tone])}>
        {icon ?? <Icon className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
