import { Loader2 } from 'lucide-react'
import { Button } from './button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card'
import { ScrollArea } from './scroll-area'

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
}: StorageBootstrapViewProps) {
  const state = normalizeState(stateInput)
  const isCreating = state.status === 'creation' || state.status === 'creating'
  const isWaiting = state.status === 'waiting' || state.status === 'waiting_for_binding'
  const isError = state.status === 'conflict' || state.status === 'error'
  const message = state.message ?? (isCreating
    ? copy.creationMessage
    : isWaiting
      ? copy.waitingMessage
      : state.status === 'ready'
        ? copy.readyMessage
        : state.status === 'conflict'
          ? copy.conflictMessage
          : copy.errorMessage)

  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <ScrollArea data-testid="storage-bootstrap-scroll" className="max-h-[min(70vh,36rem)] overflow-y-auto">
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {isError ? (
            <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {message}
            </div>
          ) : isWaiting || isCreating ? (
            <div role="status" aria-live="polite" className="flex items-start gap-2 text-sm text-muted-foreground">
              {(isWaiting || pending) ? <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : null}
              <span>{message}</span>
            </div>
          ) : (
            <p role="status" aria-live="polite" className="text-sm text-foreground">{message}</p>
          )}

          <div className="flex flex-col gap-2">
            {isCreating && onCreate ? <Button type="button" className="w-full" disabled={pending} onClick={() => void onCreate()}>{copy.createLabel}</Button> : null}
            {state.status === 'ready' && onContinue ? <Button type="button" className="w-full" disabled={pending} onClick={() => void onContinue()}>{copy.continueLabel}</Button> : null}
            {isError && onRetry ? <Button type="button" className="w-full" disabled={pending} onClick={() => void onRetry()}>{copy.retryLabel}</Button> : null}
            {(isWaiting || isCreating) && onCancel ? <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void onCancel()}>{copy.cancelLabel}</Button> : null}
          </div>
        </CardContent>
      </ScrollArea>
    </Card>
  )
}
