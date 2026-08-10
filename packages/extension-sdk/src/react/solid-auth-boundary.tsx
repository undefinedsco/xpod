import { useState, type ReactNode } from 'react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConnectSurface,
  StorageBootstrapView,
  WebIdLoginRouteView,
  type StorageBootstrapCopy,
  type StorageBootstrapState,
  type WebIdAuthPresentationState,
  type WebIdLoginRouteCopy,
} from '@undefineds.co/shared-ui'
import type {
  StorageSelectionState,
  StorageBinding,
  WebIdAuthState,
  WebIdLoginRouteDescriptor,
} from '@undefineds.co/solid-sdk'

export interface SolidAuthBoundaryProps {
  state: WebIdAuthState
  storageState?: StorageSelectionState
  routes: readonly WebIdLoginRouteDescriptor[]
  storageRouteId?: string
  onCreateStorage?: () => void | Promise<void>
  onContinueStorage?: (binding: StorageBinding) => void | Promise<void>
  onSelectStorage?: (binding: StorageBinding) => void | Promise<void>
  copy?: {
    route?: Partial<WebIdLoginRouteCopy>
    storage?: Partial<StorageBootstrapCopy>
  }
  onLogin: (routeId: string) => void | Promise<void>
  onRetry?: (routeId: string) => void | Promise<void>
  onCancel?: () => void | Promise<void>
  onSwitchAccount?: () => void | Promise<void>
  auxiliary?: ReactNode
  children: ReactNode
}

const routeCopy: WebIdLoginRouteCopy = {
  title: 'Connect to Solid',
  description: 'Choose an identity route to continue.',
  startLabel: 'Continue',
  restoringLabel: 'Restoring your session…',
  connectingLabel: 'Connecting…',
  rememberedLabel: 'Remembered identity',
  expiredTitle: 'Session expired',
  retryLabel: 'Try again',
  cancelLabel: 'Cancel',
  storageConflictTitle: 'Storage conflict',
  failureTitle: 'Could not sign in',
  switchAccountLabel: 'Switch account',
}

const storageCopy: StorageBootstrapCopy = {
  title: 'Prepare storage',
  description: 'The host is preparing the selected storage binding.',
  creationMessage: 'Storage is not ready yet.',
  waitingMessage: 'Waiting for the storage binding.',
  readyMessage: 'Storage is ready.',
  conflictMessage: 'The selected storage conflicts with this identity.',
  errorMessage: 'Storage could not be prepared.',
  createLabel: 'Create storage',
  continueLabel: 'Continue',
  retryLabel: 'Try again',
  cancelLabel: 'Cancel',
}

function presentationState(
  state: WebIdAuthState,
  storageState?: StorageSelectionState,
): WebIdAuthPresentationState {
  if (storageState?.status === 'conflict') {
    return { status: 'storage-conflict', message: storageState.message }
  }
  if (storageState?.status === 'error') {
    return { status: 'error', message: storageState.message }
  }

  switch (state.status) {
    case 'restoring':
      return state.remembered
        ? { status: 'restoring', remembered: state.remembered }
        : { status: 'restoring' }
    case 'anonymous':
      return state.remembered
        ? { status: 'remembered', remembered: state.remembered }
        : { status: 'anonymous' }
    case 'connecting':
      return { status: 'connecting' }
    case 'authenticated':
      return { status: 'authenticated', webId: state.webId }
    case 'expired':
      return state.remembered
        ? { status: 'expired', remembered: state.remembered }
        : { status: 'expired' }
    case 'error':
      return { status: 'error', message: state.message }
  }
}

function storageViewState(state: StorageSelectionState): StorageBootstrapState {
  switch (state.status) {
    case 'loading':
      return 'waiting'
    case 'empty':
      return 'creation'
    case 'selecting':
      return 'waiting_for_binding'
    case 'creating':
      return 'creating'
    case 'waiting_for_binding':
      return 'waiting_for_binding'
    case 'ready':
      return 'ready'
    case 'conflict':
      return { status: 'conflict', message: state.message }
    case 'error':
      return { status: 'error', message: state.message }
  }
}

function isStorageReady(state: StorageSelectionState | undefined): boolean {
  return state === undefined || state.status === 'ready'
}

function storageBindingLabel(binding: StorageBinding): string {
  if (binding.label?.trim()) return binding.label
  return binding.storageUrl
}

function storageBindingKey(binding: StorageBinding): string {
  return `${binding.storageUrl}\u0000${binding.webId}`
}

function StorageSelectionView({
  state,
  copy,
  onSelectStorage,
  onContinueStorage,
}: {
  state: Extract<StorageSelectionState, { status: 'selecting' }>
  copy: StorageBootstrapCopy
  onSelectStorage?: (binding: StorageBinding) => void | Promise<void>
  onContinueStorage?: (binding: StorageBinding) => void | Promise<void>
}) {
  const [selectedKey, setSelectedKey] = useState<string>()
  const selected = state.candidates.find((candidate) => storageBindingKey(candidate) === selectedKey)
  const canSelect = Boolean(onSelectStorage || onContinueStorage)

  return (
    <Card className="w-full border-border bg-card text-card-foreground">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        {copy.description ? <CardDescription>{copy.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="status" aria-live="polite" className="text-sm text-foreground">
          Choose a storage binding to continue.
        </p>
        <div className="space-y-2">
          {state.candidates.map((candidate) => {
            const key = storageBindingKey(candidate)
            const label = storageBindingLabel(candidate)
            const isSelected = key === selectedKey
            const content = (
              <>
                <span className="min-w-0 truncate">{label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {isSelected ? 'Selected' : 'Select'}
                </span>
              </>
            )
            return canSelect ? (
              <Button
                key={key}
                type="button"
                variant={isSelected ? 'secondary' : 'outline'}
                className="h-auto w-full justify-between gap-3 px-3 py-3 text-left"
                aria-label={`${isSelected ? 'Selected' : 'Select'} ${label}`}
                aria-pressed={isSelected}
                onClick={() => {
                  setSelectedKey(key)
                  if (onSelectStorage) void onSelectStorage(candidate)
                }}
              >
                {content}
              </Button>
            ) : (
              <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-3 text-sm">
                {content}
              </div>
            )
          })}
        </div>
        {selected && onContinueStorage ? (
          <Button type="button" className="w-full" onClick={() => void onContinueStorage(selected)}>
            {copy.continueLabel}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function SolidAuthBoundary({
  state,
  storageState,
  routes,
  storageRouteId,
  onCreateStorage,
  onContinueStorage,
  onSelectStorage,
  copy,
  onLogin,
  onRetry,
  onCancel,
  onSwitchAccount,
  auxiliary,
  children,
}: SolidAuthBoundaryProps) {
  const visibleRouteCopy: WebIdLoginRouteCopy = { ...routeCopy, ...copy?.route }
  const visibleStorageCopy: StorageBootstrapCopy = { ...storageCopy, ...copy?.storage }

  if (state.status === 'authenticated' && isStorageReady(storageState)) {
    return <>{children}</>
  }

  if (state.status === 'authenticated' && storageState?.status === 'selecting') {
    return (
      <ConnectSurface>
        <StorageSelectionView
          state={storageState}
          copy={visibleStorageCopy}
          onSelectStorage={onSelectStorage}
          onContinueStorage={onContinueStorage}
        />
      </ConnectSurface>
    )
  }

  if (state.status === 'authenticated' && storageState) {
    const storageStateView = storageViewState(storageState)
    const canRetryStorage = Boolean(onRetry && storageRouteId
      && (storageState.status === 'conflict' || storageState.status === 'error'))
    const canCancelStorage = Boolean(onCancel
      && (storageState.status === 'creating' || storageState.status === 'waiting_for_binding'))

    return (
      <ConnectSurface>
        <StorageBootstrapView
          state={storageStateView}
          copy={visibleStorageCopy}
          onCreate={storageState.status === 'empty' ? onCreateStorage : undefined}
          onRetry={canRetryStorage ? () => void onRetry?.(storageRouteId!) : undefined}
          onCancel={canCancelStorage ? onCancel : undefined}
        />
      </ConnectSurface>
    )
  }

  const routeList = state.status === 'connecting'
    ? [state.route]
    : routes.length > 0
      ? routes
      : []
  const mappedState = presentationState(state, storageState)

  return (
    <ConnectSurface>
      <div className="flex w-full flex-col gap-4">
        {routeList.map((route) => {
          const retryRouteId = state.status === 'error'
            ? state.retryRouteId
            : state.status === 'expired'
              ? state.remembered?.routeId ?? (routes.length === 1 ? routes[0]?.id : undefined)
              : undefined
          const canRetry = Boolean(onRetry && (
            retryRouteId === route.id
            || (storageRouteId === route.id
              && (storageState?.status === 'conflict' || storageState?.status === 'error'))
          ))
          const canStart = state.status === 'anonymous'
          const canCancel = state.status === 'connecting'

          return (
            <WebIdLoginRouteView
              key={route.id}
              route={route}
              state={mappedState}
              copy={visibleRouteCopy}
              onStart={canStart ? onLogin : undefined}
              onRetry={canRetry ? onRetry : undefined}
              onCancel={canCancel ? onCancel : undefined}
              onSwitchAccount={onSwitchAccount}
            />
          )
        })}
        {auxiliary ? <div>{auxiliary}</div> : null}
      </div>
    </ConnectSurface>
  )
}
