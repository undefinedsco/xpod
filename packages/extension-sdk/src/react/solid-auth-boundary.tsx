import { useRef, useState, type ReactNode } from 'react'
import {
  Button,
  PodSignIn,
  PodSignInFrame,
  SourceMark,
  formatCopy,
  resolvePodSignInCopy,
  webIdShortName,
  type AppIdentity,
  type AuthSurfaceMode,
  type PodSignInCopy,
  type PodSignInLocale,
  type PodSignInNotice,
  type PodSignInState,
  type RememberedIdentity,
  type SignInPresentation,
  type StorageBootstrapCopy,
  type WebIdLoginRouteCopy,
} from '@undefineds.co/shared-ui'
import type {
  StorageSelectionState,
  StorageBinding,
  RememberedWebIdLogin,
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
  /**
   * `storage` still overrides the Pod chooser wording. `route` is retained for
   * source compatibility only: the sign-in wording now ships with `PodSignIn`
   * (`podSignInCopy` overrides it).
   */
  copy?: {
    route?: Partial<WebIdLoginRouteCopy>
    storage?: Partial<StorageBootstrapCopy>
  }
  onLogin: (routeId: string) => void | Promise<void>
  onRetry?: (routeId: string) => void | Promise<void>
  onCancel?: () => void | Promise<void>
  onSwitchAccount?: () => void | Promise<void>
  /** Presentation contract for the boundary's unauthenticated surface. */
  surfaceMode?: AuthSurfaceMode
  /** Optional host-owned close action for modal presentation. */
  onSurfaceClose?: () => void | Promise<void>
  auxiliary?: ReactNode
  /** The application's own name and icon for the source mark. Nothing is assumed when omitted. */
  app?: AppIdentity
  /** Sign-in wording language. Defaults to `en`. */
  locale?: PodSignInLocale
  /** Partial overrides of the shared sign-in wording. */
  podSignInCopy?: Partial<PodSignInCopy>
  /** Technical detail of a failure becomes expandable. */
  developerMode?: boolean
  children: ReactNode
}

const DEFAULT_APP_NAME = 'Solid'

function presentationFor(mode: AuthSurfaceMode): { presentation: SignInPresentation; modal: boolean } {
  switch (mode) {
    case 'page': return { presentation: 'page', modal: false }
    case 'modal': return { presentation: 'dialog', modal: true }
    case 'embedded': return { presentation: 'dialog', modal: false }
  }
}

function rememberedIdentity(remembered: { displayName: string; avatarUrl?: string }): RememberedIdentity {
  return {
    displayName: remembered.displayName,
    ...(remembered.avatarUrl ? { avatarUrl: remembered.avatarUrl } : {}),
  }
}

function storageBindingLabel(binding: StorageBinding): string {
  if (binding.label?.trim()) return binding.label
  return binding.storageUrl
}

function storageBindingKey(binding: StorageBinding): string {
  return `${binding.storageUrl}\u0000${binding.webId}`
}

/** The Pod chooser: the same 360px body and tokens as the sign-in states. */
function StorageSelectionView({
  state,
  app,
  copy,
  storageCopy,
  onSelectStorage,
  onContinueStorage,
}: {
  state: Extract<StorageSelectionState, { status: 'selecting' }>
  app: AppIdentity
  copy: PodSignInCopy
  storageCopy?: Partial<StorageBootstrapCopy>
  onSelectStorage?: (binding: StorageBinding) => void | Promise<void>
  onContinueStorage?: (binding: StorageBinding) => void | Promise<void>
}) {
  const [selectedKey, setSelectedKey] = useState<string>()
  const selected = state.candidates.find((candidate) => storageBindingKey(candidate) === selectedKey)
  const canSelect = Boolean(onSelectStorage || onContinueStorage)
  const title = storageCopy?.title || copy.choosePodTitle
  const continueLabel = storageCopy?.continueLabel || copy.customSubmit

  return (
    <div data-pod-sign-in-state="choose-pod" className="flex flex-col gap-6">
      <SourceMark icon={app.icon} name={app.name} />
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {storageCopy?.description || copy.choosePodLead}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {state.candidates.map((candidate) => {
          const key = storageBindingKey(candidate)
          const label = storageBindingLabel(candidate)
          const isSelected = key === selectedKey
          const stateLabel = isSelected ? copy.selected : copy.select
          const content = (
            <>
              <span className="min-w-0 truncate text-sm text-foreground">{label}</span>
              <span className="shrink-0 text-[13px] text-muted-foreground">{stateLabel}</span>
            </>
          )
          return canSelect ? (
            <button
              key={key}
              type="button"
              aria-label={`${stateLabel} ${label}`}
              aria-pressed={isSelected}
              className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${isSelected ? 'border-primary bg-accent' : 'border-border bg-card'}`}
              onClick={() => {
                setSelectedKey(key)
                if (onSelectStorage) void onSelectStorage(candidate)
              }}
            >
              {content}
            </button>
          ) : (
            <div key={key} className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
              {content}
            </div>
          )
        })}
      </div>
      {selected && onContinueStorage ? (
        <Button type="button" className="h-11 w-full rounded-lg text-sm font-medium" onClick={() => void onContinueStorage(selected)}>
          {continueLabel}
        </Button>
      ) : null}
    </div>
  )
}

function isStorageReady(state: StorageSelectionState | undefined): boolean {
  return state === undefined || state.status === 'ready'
}

/**
 * The application front door for third-party apps: maps the WebID and Pod
 * selection state onto the shared `PodSignIn` states (A0-A3, plus a one-line
 * C notice). It renders no second login flow; every action calls the host.
 */
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
  surfaceMode = 'page',
  onSurfaceClose,
  auxiliary,
  app: appProp,
  locale = 'en',
  podSignInCopy,
  developerMode = false,
  children,
}: SolidAuthBoundaryProps) {
  const text = resolvePodSignInCopy(locale, podSignInCopy)
  // `connecting` carries only the route, so the screen the user pressed the button on
  // (remembered identity or first visit) is remembered from the states before it.
  const lastRemembered = useRef<RememberedWebIdLogin | undefined>(undefined)
  if (state.status === 'anonymous' || state.status === 'restoring' || state.status === 'expired') {
    lastRemembered.current = state.remembered
  }
  const app: AppIdentity = appProp ?? { name: DEFAULT_APP_NAME }
  const { presentation, modal } = presentationFor(surfaceMode)
  const frame = (content: ReactNode) => (
    <PodSignInFrame
      presentation={presentation}
      modal={modal}
      ariaLabel={text.chooseTitle}
      onClose={onSurfaceClose ? () => void onSurfaceClose() : undefined}
      closeLabel={onSurfaceClose ? text.close : undefined}
    >
      {content}
      {auxiliary ? <div className="mt-4">{auxiliary}</div> : null}
    </PodSignInFrame>
  )

  if (state.status === 'authenticated' && isStorageReady(storageState)) {
    return <>{children}</>
  }

  if (state.status === 'authenticated' && storageState?.status === 'selecting') {
    return frame(
      <StorageSelectionView
        state={storageState}
        app={app}
        copy={text}
        storageCopy={copy?.storage}
        onSelectStorage={onSelectStorage}
        onContinueStorage={onContinueStorage}
      />,
    )
  }

  // Route used by "sign in" and "sign in again": the remembered identity's route,
  // else the only route. With several routes and nothing remembered the first is the primary one.
  const rememberedOf = (s: WebIdAuthState) => (
    s.status === 'anonymous' || s.status === 'restoring' || s.status === 'expired' ? s.remembered : undefined
  )
  const remembered = rememberedOf(state)
  const primaryRoute = state.status === 'connecting'
    ? state.route
    : routes.find((route) => route.id === remembered?.routeId) ?? routes[0]
  const login = () => { if (primaryRoute) void onLogin(primaryRoute.id) }
  const relogin = () => {
    const routeId = state.status === 'error' ? state.retryRouteId : primaryRoute?.id
    if (routeId && onRetry) void onRetry(routeId)
    else login()
  }
  const noop = () => undefined
  const extraRoutes = state.status === 'anonymous' && !remembered ? routes.filter((route) => route !== primaryRoute) : []

  let podState: PodSignInState
  let notice: PodSignInNotice | undefined
  let onPrimary: () => void = login
  let onUseAnother: (() => void) | undefined = onSwitchAccount ? () => void onSwitchAccount() : undefined
  const serviceLabel = primaryRoute?.label
  // Route-specific label for the primary button on the first-visit screen.
  const routeCopy: Partial<PodSignInCopy> | undefined = serviceLabel
    ? { useXpod: formatCopy(text.signInWith, { service: serviceLabel }) }
    : undefined

  if (state.status === 'authenticated') {
    // Valid WebID sessions stay valid while their Pod opens or retries: never
    // turn a Pod problem into a second login.
    const identity: RememberedIdentity = { displayName: webIdShortName(state.webId) }
    const busy = storageState?.status === 'loading'
      || storageState?.status === 'waiting_for_binding'
      || storageState?.status === 'creating'
    podState = { kind: 'remembered', identity, busy }
    onUseAnother = undefined
    onPrimary = noop
    if (storageState?.status === 'error') {
      notice = { tone: 'warning', text: text.noticeUnreachable, primaryLabel: text.retry, developerDetail: storageState.message }
      const retryRouteId = storageRouteId
      onPrimary = retryRouteId && onRetry ? () => void onRetry(retryRouteId) : noop
    } else if (storageState?.status === 'conflict') {
      notice = { tone: 'warning', text: text.noticeIncomplete, primaryLabel: text.useAnother, developerDetail: storageState.message }
      onPrimary = onSwitchAccount
        ? () => void onSwitchAccount()
        : storageRouteId && onRetry ? () => void onRetry(storageRouteId) : noop
    } else if (storageState?.status === 'empty') {
      notice = { tone: 'neutral', text: text.noticeNoWebId, primaryLabel: text.goCreate }
      onPrimary = onCreateStorage ? () => void onCreateStorage() : noop
    }
  } else if (state.status === 'restoring') {
    podState = { kind: 'restoring', ...(remembered ? { identity: rememberedIdentity(remembered) } : {}) }
  } else if (state.status === 'connecting') {
    // The screen the user pressed the button on, with the button spinning.
    podState = lastRemembered.current
      ? { kind: 'remembered', identity: rememberedIdentity(lastRemembered.current), busy: true }
      : { kind: 'choose-service', busy: true }
    if (lastRemembered.current) onUseAnother = undefined
  } else if (state.status === 'expired') {
    podState = {
      kind: 'expired',
      identity: rememberedIdentity(remembered ?? { displayName: serviceLabel ?? app.name }),
    }
    onPrimary = relogin
  } else {
    // anonymous, or error (same screens plus a C4 notice)
    podState = remembered
      ? { kind: 'remembered', identity: rememberedIdentity(remembered) }
      : { kind: 'choose-service' }
    if (state.status === 'error') {
      notice = {
        tone: 'warning',
        text: text.noticeIncomplete,
        primaryLabel: text.reauthenticate,
        developerDetail: state.message,
      }
      onPrimary = relogin
    }
    if (primaryRoute?.availability === 'starting') {
      podState = { ...podState, busy: true } as PodSignInState
    } else if (primaryRoute?.availability === 'unavailable' && !notice) {
      notice = { tone: 'warning', text: primaryRoute.unavailableReason ?? text.noticeUnreachable }
      onPrimary = noop
    }
  }

  return frame(
    <>
      <PodSignIn
        app={app}
        state={podState}
        notice={notice}
        locale={locale}
        copy={{ ...routeCopy, ...podSignInCopy }}
        developerMode={developerMode}
        primaryIcon={null}
        capabilities={{ customService: false, register: false }}
        onPrimary={onPrimary}
        onUseAnother={onUseAnother}
      />
      {extraRoutes.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {extraRoutes.map((route) => (
            <Button
              key={route.id}
              type="button"
              variant="outline"
              className="h-11 w-full rounded-lg text-sm font-medium"
              disabled={route.availability === 'unavailable'}
              onClick={() => void onLogin(route.id)}
            >
              {formatCopy(text.signInWith, { service: route.label })}
            </Button>
          ))}
        </div>
      ) : null}
      {state.status === 'connecting' && onCancel ? (
        <Button
          type="button"
          variant="ghost"
          className="mt-2 h-9 w-full rounded-lg px-2 text-sm font-medium"
          onClick={() => void onCancel()}
        >
          {text.cancel}
        </Button>
      ) : null}
    </>,
  )
}
