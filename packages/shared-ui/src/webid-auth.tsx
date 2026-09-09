import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from './badge'
import { Button } from './button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card'
import { ScrollArea } from './scroll-area'
import { cn } from './utils'

export interface WebIdLoginRouteOption {
  id: string
  label: string
  description?: string
  badge?: { label: string; tone: 'neutral' | 'primary' | 'success' | 'warning' | 'danger' }
  availability?: 'ready' | 'starting' | 'unavailable'
  unavailableReason?: string
  identityProvider?: { url: string; label: string }
  storageProvider?: { url: string; label: string }
}

export interface RememberedWebIdLoginOption {
  displayName: string
  avatarUrl?: string
  webId?: string
  routeId: string
}

export type WebIdAuthPresentationState =
  | { status: 'anonymous'; remembered?: RememberedWebIdLoginOption }
  | { status: 'remembered'; remembered: RememberedWebIdLoginOption }
  | { status: 'restoring'; remembered?: RememberedWebIdLoginOption }
  | { status: 'connecting' }
  | { status: 'authenticated'; webId: string }
  | { status: 'expired'; remembered?: RememberedWebIdLoginOption }
  | { status: 'retry'; message?: string }
  | { status: 'cancel'; message?: string }
  | { status: 'storage-conflict'; message: string }
  | { status: 'failure'; message: string }
  | { status: 'error'; message: string }

export interface WebIdLoginRouteCopy {
  title: string
  description?: string
  startLabel: string
  restoringLabel: string
  connectingLabel: string
  rememberedLabel: string
  expiredTitle: string
  retryLabel: string
  cancelLabel: string
  storageConflictTitle: string
  failureTitle: string
  switchAccountLabel?: string
}

export interface WebIdLoginRouteViewProps {
  route: WebIdLoginRouteOption
  state: WebIdAuthPresentationState | WebIdAuthPresentationState['status']
  copy: WebIdLoginRouteCopy
  onStart?: (routeId: string) => void | Promise<void>
  onConnect?: (routeId: string) => void | Promise<void>
  onRouteAction?: (routeId: string) => void | Promise<void>
  onSelectRoute?: (routeId: string) => void | Promise<void>
  onRetry?: (routeId: string) => void | Promise<void>
  onCancel?: () => void | Promise<void>
  onSwitchAccount?: () => void | Promise<void>
  pending?: boolean
  /**
   * `false` 时去掉自身卡片边框/圆角/阴影，用于嵌套在 AuthSurface 等
   * 已提供外框的宿主内，避免双层卡片。独立使用时保持默认 `true`。
   */
  framed?: boolean
}

export interface WebIdLoginEntryCopy {
  title: string
  description?: string
  startLabel: string
  pendingLabel: string
}

export interface WebIdLoginEntryViewProps {
  copy: WebIdLoginEntryCopy
  logo?: ReactNode
  pending?: boolean
  error?: string
  onStart: () => void | Promise<void>
}

/**
 * Frame-free presentation for hosts that expose exactly one WebID route.
 * Provider discovery, issuer validation, redirects, and session ownership all
 * stay in the host controller; this view only renders the one public action.
 */
export function WebIdLoginEntryView({
  copy,
  logo,
  pending = false,
  error,
  onStart,
}: WebIdLoginEntryViewProps) {
  return (
    <div data-testid="webid-login-entry" className="flex h-full min-h-0 flex-1 flex-col px-5 pb-5 pt-7">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 text-center">
        {logo ? <div className="flex items-center justify-center">{logo}</div> : null}
        {copy.title || copy.description ? <div className="space-y-1.5">
          {copy.title ? <h2 className="text-lg font-semibold text-foreground">{copy.title}</h2> : null}
          {copy.description ? (
            <p className="text-xs leading-5 text-muted-foreground">{copy.description}</p>
          ) : null}
        </div> : null}
        {error ? (
          <p role="alert" className="max-w-[15rem] text-sm leading-5 text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        className="h-10 w-full shrink-0 rounded-xl"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void onStart()}
      >
        {pending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
        {pending ? copy.pendingLabel : copy.startLabel}
      </Button>
    </div>
  )
}

const badgeVariants = {
  neutral: 'outline',
  primary: 'default',
  success: 'default',
  warning: 'secondary',
  danger: 'destructive',
} as const

function normalizeState(
  state: WebIdLoginRouteViewProps['state'],
): WebIdAuthPresentationState {
  return typeof state === 'string' ? { status: state } as WebIdAuthPresentationState : state
}

function rememberedName(state: WebIdAuthPresentationState): string | undefined {
  if ('remembered' in state) return state.remembered?.displayName
  return undefined
}

function stateMessage(state: WebIdAuthPresentationState): string | undefined {
  return 'message' in state ? state.message : undefined
}

export function WebIdLoginRouteView({
  route,
  state: stateInput,
  copy,
  onStart,
  onConnect,
  onRouteAction,
  onSelectRoute,
  onRetry,
  onCancel,
  onSwitchAccount,
  pending = false,
  framed = true,
}: WebIdLoginRouteViewProps) {
  const state = normalizeState(stateInput)
  const start = onStart ?? onConnect ?? onRouteAction ?? onSelectRoute
  const routeAvailable = route.availability !== 'unavailable'
  const routePending = pending || route.availability === 'starting'
  const hasError = state.status === 'storage-conflict' || state.status === 'failure' || state.status === 'error'
  const message = stateMessage(state)

  return (
    <Card className={cn(
      'w-full text-card-foreground',
      framed ? 'border-border bg-card' : 'rounded-none border-0 bg-transparent shadow-none',
    )}>
      <ScrollArea data-testid="webid-login-route-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
      {copy.title || copy.description ? (
        <CardHeader>
          {copy.title ? <CardTitle>{copy.title}</CardTitle> : null}
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn('space-y-4', !framed && 'px-4 pb-4 pt-0')}>
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 p-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{route.label}</p>
            {route.description ? <p className="mt-1 text-sm text-muted-foreground">{route.description}</p> : null}
            {route.identityProvider ? <p className="mt-1 truncate text-xs text-muted-foreground">{route.identityProvider.label}</p> : null}
          </div>
          {route.badge ? <Badge variant={badgeVariants[route.badge.tone]}>{route.badge.label}</Badge> : null}
        </div>

        {state.status === 'restoring' || state.status === 'connecting' ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            {state.status === 'restoring' ? copy.restoringLabel : copy.connectingLabel}
            {rememberedName(state) ? <span className="font-medium text-foreground">{rememberedName(state)}</span> : null}
          </div>
        ) : null}

        {state.status === 'remembered' ? (
          <div role="status" aria-live="polite" className="space-y-1 rounded-lg border border-border/60 p-3">
            <p className="text-sm font-medium text-foreground">{copy.rememberedLabel}</p>
            <p className="text-sm text-muted-foreground">{state.remembered.displayName}</p>
          </div>
        ) : null}

        {state.status === 'expired' ? (
          <div role="alert" aria-live="polite" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
            <p className="font-medium">{copy.expiredTitle}</p>
            {state.remembered ? <p className="mt-1 text-muted-foreground">{state.remembered.displayName}</p> : null}
          </div>
        ) : null}

        {hasError ? (
          <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">{state.status === 'storage-conflict' ? copy.storageConflictTitle : copy.failureTitle}</p>
            {message ? <p className="mt-1">{message}</p> : null}
          </div>
        ) : null}
        {state.status === 'retry' || state.status === 'cancel' ? (
          <div role="alert" aria-live="polite" className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">
            {message}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          {(state.status === 'anonymous' || state.status === 'remembered') && start ? (
            <Button type="button" className="w-full" disabled={routePending || !routeAvailable} onClick={() => void start(route.id)}>
              {routePending ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
              {copy.startLabel}
            </Button>
          ) : null}
          {(state.status === 'expired' || state.status === 'retry' || state.status === 'storage-conflict' || state.status === 'failure' || state.status === 'error') && onRetry ? (
            <Button type="button" className="w-full" disabled={pending} onClick={() => void onRetry(route.id)}>{copy.retryLabel}</Button>
          ) : null}
          {(state.status === 'connecting' || state.status === 'cancel') && onCancel ? (
            <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void onCancel()}>{copy.cancelLabel}</Button>
          ) : null}
          {onSwitchAccount && copy.switchAccountLabel && (state.status === 'remembered' || state.status === 'expired') ? (
            <Button type="button" variant="ghost" className="w-full" disabled={pending} onClick={() => void onSwitchAccount()}>
              {copy.switchAccountLabel}
            </Button>
          ) : null}
        </div>
      </CardContent>
      </ScrollArea>
    </Card>
  )
}
