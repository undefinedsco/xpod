import { TriangleAlert } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Input } from '../input'
import { formatCopy, resolvePodSignInCopy, type PodSignInCopy, type PodSignInLocale } from './copy'
import {
  ActionButton,
  Disclosure,
  Field,
  PodAvatar,
  ScreenLayout,
  SourceMark,
  Spinner,
  outlineButtonClass,
  primaryButtonClass,
  textButtonClass,
  usePastDelay,
} from './parts'
import type { AppIdentity, StorageLocation } from './types'
import { XpodMark } from './XpodMark'
import { cn } from '../utils'

export interface RememberedIdentity {
  displayName: string
  avatarUrl?: string
  /** Drives the avatar corner badge. */
  storage?: StorageLocation
}

export type PodSignInState =
  | { kind: 'restoring'; identity?: RememberedIdentity }
  | { kind: 'remembered'; identity: RememberedIdentity; busy?: boolean }
  | { kind: 'expired'; identity: RememberedIdentity; busy?: boolean }
  | { kind: 'choose-service'; customOpen?: boolean; customError?: string; busy?: boolean }

/** C group: one line above the primary action, plus a replaced primary label. */
export interface PodSignInNotice {
  /** neutral = grey text (e.g. "login cancelled"); warning = with an icon. */
  tone: 'neutral' | 'warning'
  text: string
  /** Replaces the primary button text, e.g. "Retry" or "Start Xpod and enter". */
  primaryLabel?: string
  /** Only expandable in developer mode. */
  developerDetail?: string
}

export interface PodSignInProps {
  app: AppIdentity
  /** Host-supplied logo and optional info; defaults to the application source mark. */
  brand?: ReactNode
  state: PodSignInState
  notice?: PodSignInNotice
  locale?: PodSignInLocale
  copy?: Partial<PodSignInCopy>
  developerMode?: boolean
  /** Icon on the A3 primary button. Defaults to the Xpod mark; pass `null` for none. */
  primaryIcon?: ReactNode
  capabilities?: { customService?: boolean; register?: boolean }
  /** A1 enter / A2 sign in again / A3 sign in with Xpod / the action a notice relabelled. */
  onPrimary(): void
  /** A1/A2 "use another account". */
  onUseAnother?(): void
  onCustomService?(input: string): void
  onRegister?(): void
  onToggleCustom?(open: boolean): void
}

const RESTORE_REVEAL_DELAY_MS = 300

function NoticeLine({
  notice,
  developerMode,
  copy,
}: {
  notice: PodSignInNotice
  developerMode: boolean
  copy: PodSignInCopy
}) {
  const [copied, setCopied] = useState(false)
  const line = (
    <span className="inline-flex items-start gap-1.5">
      {notice.tone === 'warning' ? <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
      <span>{notice.text}</span>
    </span>
  )
  const tone = notice.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'
  const role = notice.tone === 'warning' ? 'alert' : 'status'
  const detail = developerMode ? notice.developerDetail : undefined

  return (
    <div role={role} data-pod-sign-in="notice" data-tone={notice.tone} className={cn('text-[13px] leading-5', tone)}>
      {detail ? (
        <details>
          <summary
            title={copy.noticeDetailsToggle}
            className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {line}
          </summary>
          <div className="mt-1 rounded-lg bg-muted p-2 text-foreground">
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">{detail}</pre>
            <button
              type="button"
              className="mt-1 h-9 rounded-lg px-2 text-[13px] font-medium text-primary hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                void navigator.clipboard?.writeText(detail).then(() => setCopied(true), () => undefined)
              }}
            >
              {copied ? copy.noticeCopied : copy.noticeCopy}
            </button>
          </div>
        </details>
      ) : line}
    </div>
  )
}

function CustomServiceForm({
  copy,
  error,
  busy,
  onSubmit,
}: {
  copy: PodSignInCopy
  error?: string
  busy: boolean
  onSubmit?: (input: string) => void
}) {
  const [value, setValue] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (input && onSubmit) onSubmit(input)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-pod-sign-in="custom-service">
      <Field label={copy.customLabel} error={error}>
        {(fieldProps) => (
          <Input
            {...fieldProps}
            name="service"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={copy.customPlaceholder}
            value={value}
            disabled={busy}
            className="h-11 rounded-lg bg-card text-sm"
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </Field>
      <ActionButton type="submit" variant="outline" className={outlineButtonClass} busy={busy} disabled={!value.trim()}>
        {copy.customSubmit}
      </ActionButton>
    </form>
  )
}

/**
 * Application-side sign-in body (A and C groups). One column: source mark,
 * one h1, main content, actions. It renders no request, redirect or storage
 * access; the host's controller maps its state to `state` and `notice`.
 */
export function PodSignIn({
  app,
  brand,
  state,
  notice,
  locale = 'zh-CN',
  copy: copyOverrides,
  developerMode = false,
  primaryIcon,
  capabilities,
  onPrimary,
  onUseAnother,
  onCustomService,
  onRegister,
  onToggleCustom,
}: PodSignInProps) {
  const copy = resolvePodSignInCopy(locale, copyOverrides)
  const pastRestoreDelay = usePastDelay(RESTORE_REVEAL_DELAY_MS)
  const [localCustomOpen, setLocalCustomOpen] = useState(false)
  const source = brand ? <div data-pod-sign-in="source">{brand}</div> : <SourceMark icon={app.icon} name={app.name} />

  if (state.kind === 'restoring') {
    const identity = pastRestoreDelay ? state.identity : undefined
    return (
      <ScreenLayout data-pod-sign-in-state="restoring">
        {source}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          {identity ? (
            <>
              <PodAvatar name={identity.displayName} avatarUrl={identity.avatarUrl} storage={identity.storage} />
              <h1 className="text-[17px] font-semibold text-foreground">{identity.displayName}</h1>
            </>
          ) : (
            <h1 className="sr-only">{app.name}</h1>
          )}
          <div role="status" aria-live="polite">
            {pastRestoreDelay ? (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner />
                {copy.restoring}
              </p>
            ) : null}
          </div>
        </div>
      </ScreenLayout>
    )
  }

  const busy = state.busy === true
  const primaryLabel = notice?.primaryLabel
    ?? (state.kind === 'remembered'
      ? formatCopy(copy.enterApp, { app: app.name })
      : state.kind === 'expired'
        ? copy.reauthenticate
        : copy.useXpod)
  const noticeNode = notice ? <NoticeLine notice={notice} developerMode={developerMode} copy={copy} /> : null

  if (state.kind === 'remembered' || state.kind === 'expired') {
    return (
      <ScreenLayout
        data-pod-sign-in-state={state.kind}
        actions={(
          <>
            {noticeNode}
            <ActionButton className={primaryButtonClass} busy={busy} data-pod-sign-in-primary="true" onClick={onPrimary}>
              {primaryLabel}
            </ActionButton>
            {onUseAnother ? (
              <ActionButton variant="ghost" className={cn(textButtonClass, 'w-full')} disabled={busy} onClick={onUseAnother}>
                {copy.useAnother}
              </ActionButton>
            ) : null}
          </>
        )}
      >
        {source}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <PodAvatar name={state.identity.displayName} avatarUrl={state.identity.avatarUrl} storage={state.identity.storage} />
          <h1 className="text-[17px] font-semibold text-foreground">{state.identity.displayName}</h1>
          {state.kind === 'expired' ? <p className="text-sm text-muted-foreground">{copy.expiredLine}</p> : null}
        </div>
      </ScreenLayout>
    )
  }

  // choose-service (A3)
  const allowCustom = capabilities?.customService !== false
  const allowRegister = capabilities?.register !== false && Boolean(onRegister)
  const customOpen = allowCustom && (state.customOpen ?? localCustomOpen)
  const toggleCustom = () => {
    const next = !customOpen
    setLocalCustomOpen(next)
    onToggleCustom?.(next)
  }

  return (
    <ScreenLayout
      data-pod-sign-in-state="choose-service"
      actions={(
        <>
        {noticeNode}
        <ActionButton className={primaryButtonClass} busy={busy} data-pod-sign-in-primary="true" onClick={onPrimary}>
          {!notice?.primaryLabel && primaryIcon !== null ? <span aria-hidden="true" className="mr-2 flex">{primaryIcon ?? <XpodMark size={20} />}</span> : null}
          {primaryLabel}
        </ActionButton>
        {allowCustom ? (
          <>
            <ActionButton
              variant="outline"
              className={outlineButtonClass}
              disabled={busy}
              aria-expanded={customOpen}
              onClick={toggleCustom}
            >
              {copy.useOtherSolid}
            </ActionButton>
            {customOpen ? (
              <CustomServiceForm copy={copy} error={state.customError} busy={busy} onSubmit={onCustomService} />
            ) : null}
          </>
        ) : null}
        {allowRegister ? (
          <p className="text-center text-[13px] text-muted-foreground">
            {copy.noAccount}
            <button
              type="button"
              className="ml-1 h-9 rounded px-1 font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              disabled={busy}
              onClick={onRegister}
            >
              {copy.register}
            </button>
          </p>
        ) : null}
        </>
      )}
    >
      {source}
      <div className="flex flex-col gap-2">
        <h1 className="text-[17px] font-semibold text-foreground">{copy.chooseTitle}</h1>
        <p className="text-sm leading-[22px] text-muted-foreground">{copy.chooseLead}</p>
        <div className="flex flex-col">
          <Disclosure summary={copy.whatIsWebId}>{copy.whatIsWebIdBody}</Disclosure>
          <Disclosure summary={copy.whatIsPod}>{copy.whatIsPodBody}</Disclosure>
        </div>
      </div>
    </ScreenLayout>
  )
}
