import { Loader2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '../avatar'
import { Button, type ButtonProps } from '../button'
import { cn } from '../utils'
import { FormField, type FormFieldProps } from '../form-field'
import { Checkbox } from '../checkbox'
import { StorageBadge } from './StorageBadge'
import type { StorageLocation } from './types'

/** Screen-level controls leave room for readable text and touch targets. */
export const primaryButtonClass = 'h-auto min-h-12 w-full whitespace-normal break-normal rounded-lg py-2 text-base font-medium leading-snug'
export const outlineButtonClass = primaryButtonClass
export const textButtonClass = 'h-9 rounded-lg px-2 text-sm font-medium'

export const fieldClass =
  'h-12 w-full rounded-lg border border-input bg-card px-4 text-base text-foreground placeholder:text-muted-foreground disabled:opacity-60'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={cn('h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none', className)} />
}

/** Button that shows a spinner and disables itself while `busy` (no separate "verifying" screen). */
export function ActionButton({
  busy = false,
  children,
  disabled,
  ...props
}: ButtonProps & { busy?: boolean }) {
  return (
    <Button type="button" {...props} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <Spinner className="mr-2" /> : null}
      {children}
    </Button>
  )
}

/** One-line source mark: 24px icon and 13px name. It is not a heading. */
export function SourceMark({ icon, name }: { icon?: ReactNode; name: string }) {
  return (
    <div data-pod-sign-in="source" className="flex h-6 items-center gap-2 text-[0.8125rem] text-muted-foreground">
      {icon ? <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md">{icon}</span> : null}
      <span className="truncate">{name}</span>
    </div>
  )
}

export function Hostname({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs text-muted-foreground', className)}>{children}</span>
}

export function PodAvatar({
  name,
  avatarUrl,
  storage,
  size = 56,
}: {
  name: string
  avatarUrl?: string
  storage?: StorageLocation
  size?: number
}) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} data-pod-sign-in="avatar">
      <Avatar className="h-full w-full rounded-full" aria-hidden="true">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
        <AvatarFallback className="text-base">{Array.from(name.trim())[0]?.toUpperCase() ?? '?'}</AvatarFallback>
      </Avatar>
      {storage ? (
        <span className="absolute -bottom-0.5 -right-0.5">
          <StorageBadge kind={storage.kind} label={storage.label} />
        </span>
      ) : null}
    </span>
  )
}

/** Login-specific density marker; field semantics belong to FormField. */
export function Field(props: FormFieldProps) {
  return <FormField {...props} data-pod-sign-in="field" />
}

/** Secondary information stays folded until asked for (spec §4). */
export function Disclosure({ summary, children, className }: { summary: string; children: ReactNode; className?: string }) {
  return (
    <details className={cn('text-[0.8125rem] text-muted-foreground', className)}>
      <summary className="cursor-pointer select-none rounded py-1 text-[0.8125rem] font-medium text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {summary}
      </summary>
      <div className="pt-1 leading-5">{children}</div>
    </details>
  )
}

export function CheckboxRow({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange(value: boolean): void
  label: string
  disabled?: boolean
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-foreground">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

/** Fires `open` after `delayMs`; used so fast restores show no intermediate UI. */
export function usePastDelay(delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [delayMs])
  return elapsed
}

/**
 * One screen: an optional top bar, a scrolling main area, and an action area
 * pinned to the bottom so the primary action and errors are always visible.
 * Pass `onSubmit` to make the whole screen one form (actions submit it).
 */
export function ScreenLayout({
  chrome,
  children,
  actions,
  onSubmit,
  mainClassName,
  ...state
}: {
  chrome?: ReactNode
  children: ReactNode
  actions?: ReactNode
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void
  mainClassName?: string
  'data-pod-sign-in-state'?: string
}) {
  const inner = (
    <>
      {chrome}
      <div data-pod-sign-in="main" className={cn('flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 pb-3 pt-7 min-[400px]:px-8 min-[400px]:pt-8', mainClassName)}>
        {children}
      </div>
      {actions ? <div data-pod-sign-in="actions" className="flex shrink-0 flex-col gap-4 px-6 pb-7 pt-5 min-[400px]:px-8 min-[400px]:pb-8">{actions}</div> : null}
    </>
  )
  const className = 'flex min-h-0 flex-1 flex-col'
  return onSubmit
    ? <form {...state} onSubmit={onSubmit} className={className} noValidate>{inner}</form>
    : <div {...state} className={className}>{inner}</div>
}
