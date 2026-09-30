import { TriangleAlert } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { formatCopy, resolvePodSignInCopy } from './copy'
import { IdpFrameHeader, type IdpViewCommonProps } from './IdpViews'
import { ActionButton, ScreenLayout, CheckboxRow, Disclosure, Hostname, PodAvatar, outlineButtonClass, primaryButtonClass, textButtonClass } from './parts'
import type { StorageLocation } from './types'
import { cn } from '../utils'

export interface ConsentWebId {
  id: string
  displayName: string
  shortName: string
  /** Full WebID; shown only in the folded request details. */
  webId?: string
  avatarUrl?: string
  /** Where the data of this WebID lives; expressed only as the avatar badge. */
  storage: StorageLocation
}

export interface ConsentViewProps extends IdpViewCommonProps {
  app: { name: string; icon?: ReactNode; host: string; clientId?: string; verified: boolean }
  webIds: ConsentWebId[]
  selectedWebId: string
  scopes: Array<{ id: string; label: string }>
  rememberChoice: boolean
  pending?: 'approve' | 'deny'
  /** Disables both actions (something else is in flight); unlike `pending` it spins nothing. */
  disabled?: boolean
  /** Disables only "Allow", e.g. while no WebID is chosen yet. */
  approveDisabled?: boolean
  /**
   * Hosts whose automation drives the WebID choice through a native select (the
   * CSS consent form's `oidc-consent-webid`) get a visually hidden select with this
   * id, mirroring the radio group. It is skipped for assistive technology.
   */
  automationSelectId?: string
  /** "Manage account": leave for the account page and come back. */
  onManageAccount?(): void
  /** "Switch account": sign out of the account. */
  onSwitchAccount?(): void
  onSelectWebId(id: string): void
  onRememberChange(value: boolean): void
  onApprove(): void
  onDeny(): void
}

/**
 * B4: consent. Three roles in fixed places: the sign-in service (top bar), the
 * requesting application (centered), and the identity being granted (radio list).
 */
export function ConsentView(props: ConsentViewProps) {
  const {
    app, webIds, selectedWebId, scopes, rememberChoice, pending, disabled = false, approveDisabled = false,
    automationSelectId, onSelectWebId, onRememberChange, onApprove, onDeny, onManageAccount, onSwitchAccount,
  } = props
  const copy = resolvePodSignInCopy(props.locale, props.copy)
  const labelId = useId()
  const busy = pending !== undefined || disabled
  const single = webIds.length === 1
  const selectedFullWebId = (webIds.find((webId) => webId.id === selectedWebId) ?? webIds[0])?.webId

  const actions = (
    <>
      <div className="grid grid-cols-2 gap-3">
        <ActionButton variant="outline" className={outlineButtonClass} busy={pending === 'deny'} disabled={busy} onClick={onDeny}>
          {copy.deny}
        </ActionButton>
        <ActionButton className={primaryButtonClass} busy={pending === 'approve'} disabled={busy || approveDisabled} onClick={onApprove}>
          {copy.allow}
        </ActionButton>
      </div>
      {onManageAccount || onSwitchAccount ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onManageAccount ? (
            <button type="button" className={cn(textButtonClass, 'text-muted-foreground hover:text-foreground')} disabled={busy} onClick={onManageAccount}>
              {copy.manageAccount}
            </button>
          ) : null}
          {onSwitchAccount ? (
            <button type="button" className={cn(textButtonClass, 'text-muted-foreground hover:text-foreground')} disabled={busy} onClick={onSwitchAccount}>
              {copy.switchAccount}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )

  return (
    <ScreenLayout data-pod-sign-in-state="consent" chrome={<IdpFrameHeader {...props} />} actions={actions}>
      <div className="flex flex-col items-center gap-2 text-center">
        {app.icon ? (
          <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl">{app.icon}</span>
        ) : null}
        <h1 className="text-xl font-semibold text-foreground">{formatCopy(copy.consentTitle, { app: app.name })}</h1>
        {app.host ? <Hostname>{app.host}</Hostname> : null}
        {!app.verified ? (
          <p role="alert" className="flex items-start gap-1.5 text-left text-[13px] text-warning">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {copy.unverifiedWarning}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <p id={labelId} className="text-[13px] font-medium text-foreground">{copy.chooseWebId}</p>
        {single ? (
          <div className="rounded-lg border border-border bg-card p-3">
            <WebIdRow webId={webIds[0]!} />
          </div>
        ) : (
          <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-2">
            {webIds.map((webId) => {
              const selected = webId.id === selectedWebId
              return (
                <label
                  key={webId.id}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
                    selected ? 'border-primary bg-accent' : 'border-border bg-card',
                  )}
                >
                  <input
                    type="radio"
                    name="consent-webid"
                    className="sr-only"
                    value={webId.id}
                    checked={selected}
                    disabled={busy}
                    onChange={() => onSelectWebId(webId.id)}
                  />
                  <WebIdRow webId={webId} />
                </label>
              )
            })}
          </div>
        )}
        {!single && automationSelectId ? (
          <select
            id={automationSelectId}
            aria-hidden="true"
            aria-label={copy.chooseWebId}
            tabIndex={-1}
            className="sr-only"
            value={selectedWebId}
            disabled={busy}
            onChange={(event) => onSelectWebId(event.target.value)}
          >
            {!selectedWebId ? <option value="" disabled>{copy.chooseWebId}</option> : null}
            {webIds.map((webId) => <option key={webId.id} value={webId.id}>{webId.displayName} {webId.shortName}</option>)}
          </select>
        ) : null}
        <p className="text-[13px] leading-5 text-muted-foreground">{formatCopy(copy.consentConsequence, { app: app.name })}</p>
      </div>

      <Disclosure summary={copy.requestDetails}>
        <div className="flex flex-col gap-2">
          {scopes.length > 0 ? (
            <div>
              <p className="font-medium text-foreground">{copy.scopes}</p>
              <ul className="list-disc pl-5">
                {scopes.map((scope) => <li key={scope.id}>{scope.label}</li>)}
              </ul>
            </div>
          ) : null}
          {selectedFullWebId ? (
            <p>
              <span className="font-medium text-foreground">{copy.webIdFull}</span>{' '}
              <Hostname className="break-all">{selectedFullWebId}</Hostname>
            </p>
          ) : null}
          {app.clientId ? (
            <p>
              <span className="font-medium text-foreground">{copy.clientId}</span>{' '}
              <Hostname className="break-all">{app.clientId}</Hostname>
            </p>
          ) : null}
          {app.verified ? (
            <CheckboxRow checked={rememberChoice} onChange={onRememberChange} label={copy.rememberChoice} disabled={busy} />
          ) : null}
        </div>
      </Disclosure>

    </ScreenLayout>
  )
}

function WebIdRow({ webId }: { webId: ConsentWebId }) {
  return (
    <span className="flex min-w-0 items-center gap-3" data-pod-sign-in="webid-row">
      <PodAvatar name={webId.displayName} avatarUrl={webId.avatarUrl} storage={webId.storage} size={40} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{webId.displayName}</span>
        {webId.shortName !== webId.displayName ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{webId.shortName}</span>
        ) : null}
      </span>
    </span>
  )
}
