import { Loader2 } from 'lucide-react'
import { Button } from './button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card'
import { ScrollArea } from './scroll-area'
import { cn } from './utils'

export type StorageBootstrapStatus = 'creation' | 'creating' | 'waiting' | 'waiting_for_binding' | 'ready' | 'conflict' | 'error'

export type StorageBootstrapState =
  | StorageBootstrapStatus
  | { status: 'conflict' | 'error'; message: string }

export interface StorageBootstrapCopy {
  title: string
  description?: string
  creationMessage: string
  waitingMessage: string
  readyMessage: string
  conflictMessage: string
  errorMessage: string
  createLabel: string
  continueLabel: string
  retryLabel: string
  cancelLabel: string
}
export interface StorageBootstrapViewProps {
  state: StorageBootstrapState
  copy: StorageBootstrapCopy
  pending?: boolean
  onCreate?: () => void | Promise<void>
  onContinue?: () => void | Promise<void>
  onRetry?: () => void | Promise<void>
  onCancel?: () => void | Promise<void>
  /**
   * `false` 时去掉自身卡片边框/圆角/阴影，用于嵌套在 AuthSurface 等
   * 已提供外框的宿主内，避免双层卡片。独立使用时保持默认 `true`。
   */
  framed?: boolean
}

function normalizeState(state: StorageBootstrapState): { status: StorageBootstrapStatus; message?: string } {
  if (typeof state === 'string') return { status: state }
  return state
}

export function StorageBootstrapView({
  state: stateInput,
  copy,
  pending = false,
  onCreate,
  onContinue,
  onRetry,
  onCancel,
  framed = true,
}: StorageBootstrapViewProps) {
  const state = normalizeState(stateInput)
  const canCreate = state.status === 'creation'
  const isCreating = state.status === 'creating'
  const isWaiting = state.status === 'waiting' || state.status === 'waiting_for_binding'
  const isError = state.status === 'conflict' || state.status === 'error'
  const isProvisioning = canCreate || isCreating
  const showProgress = isWaiting || isCreating || (canCreate && pending)
  const message = state.message ?? (isProvisioning
    ? copy.creationMessage
    : isWaiting
      ? copy.waitingMessage
      : state.status === 'ready'
        ? copy.readyMessage
        : state.status === 'conflict'
          ? copy.conflictMessage
          : copy.errorMessage)

  return (
    <Card className={cn(
      'w-full text-card-foreground',
      framed ? 'border-border bg-card' : 'rounded-none border-0 bg-transparent shadow-none',
    )}>
      <ScrollArea data-testid="storage-bootstrap-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
        {copy.title || copy.description ? (
          <CardHeader>
            {copy.title ? <CardTitle>{copy.title}</CardTitle> : null}
            {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
          </CardHeader>
        ) : null}
        <CardContent className={cn('space-y-4', !framed && 'px-4 pb-4 pt-0')}>
          {isError ? (
            <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {message}
            </div>
          ) : showProgress ? (
            <div role="status" aria-live="polite" className="flex items-start gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>{message}</span>
            </div>
          ) : (
            <p role="status" aria-live="polite" className="text-sm text-foreground">{message}</p>
          )}

          <div className="flex flex-col gap-2">
            {canCreate && onCreate ? <Button type="button" className="w-full" disabled={pending} onClick={() => void onCreate()}>{copy.createLabel}</Button> : null}
            {state.status === 'ready' && onContinue ? <Button type="button" className="w-full" disabled={pending} onClick={() => void onContinue()}>{copy.continueLabel}</Button> : null}
            {isError && onRetry ? <Button type="button" className="w-full" disabled={pending} onClick={() => void onRetry()}>{copy.retryLabel}</Button> : null}
            {(isWaiting || isCreating) && onCancel ? <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void onCancel()}>{copy.cancelLabel}</Button> : null}
          </div>
        </CardContent>
      </ScrollArea>
    </Card>
  )
}
