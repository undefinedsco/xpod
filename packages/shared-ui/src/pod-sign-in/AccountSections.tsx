import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronRight, KeyRound, Server, UserRound } from 'lucide-react'
import {
  DeviceIdentity,
  listRowClass,
  sectionClass,
  SectionHeader,
  type DeviceSummary,
} from './account-parts'
import { formatCopy, resolvePodSignInCopy, type PodSignInCopy, type PodSignInLocale } from './copy'
import { DevicePickerDialog } from './DeviceDialogs'
import { NetworkPanel, type NetworkPanelProps } from './NetworkPanel'
import {
  ActionButton,
  Field,
  Hostname,
  PodAvatar,
  Spinner,
  fieldClass,
  outlineButtonClass,
  primaryButtonClass,
  textButtonClass,
} from './parts'
import type { AppIdentity, StorageLocation } from './types'
import { cn } from '../utils'

interface LocalizedProps {
  locale?: PodSignInLocale
  copy?: Partial<PodSignInCopy>
}

const smallButtonClass = 'h-9 rounded-lg px-3 text-sm font-medium'

// ---------------------------------------------------------------------------
// WebID section
// ---------------------------------------------------------------------------

export interface WebIdEntry {
  id: string
  displayName: string
  /** WebID URL; shown in monospace. */
  webId: string
  avatarUrl?: string
  storage: StorageLocation
  /** The device holding this WebID's Pod. */
  deviceId?: string
  deviceName?: string
  authorizedAppCount?: number
}

export interface CreateWebIdFormProps extends LocalizedProps {
  name: string
  onNameChange(name: string): void
  /** Preview of the WebID address for the typed name. */
  addressPreview?: string
  nameHint?: { tone: 'ok' | 'error'; text: string }
  devices: DeviceSummary[]
  selectedDeviceId: string
  onSelectDevice(deviceId: string): void
  /** Opens the shared "add device" dialog (owned by the host). */
  onAddDevice(): void
  /** True while the Pod is being created. */
  creating?: boolean
  /** True while Xpod on the selected device is being started. */
  starting?: boolean
  /** Required for a device whose Xpod is stopped: it is started before anything is created. */
  onStartDevice?(deviceId: string): void
  onSubmit(): void
  onCancel?(): void
}

/**
 * Two steps, like choosing a delivery address: a name, then a location shown
 * as a summary card with "Change ›". Choosing happens in a picker dialog and
 * involves no network settings.
 */
export function CreateWebIdForm({
  name,
  onNameChange,
  addressPreview,
  nameHint,
  devices,
  selectedDeviceId,
  onSelectDevice,
  onAddDevice,
  creating = false,
  starting = false,
  onStartDevice,
  onSubmit,
  onCancel,
  locale,
  copy: overrides,
}: CreateWebIdFormProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const [pickerOpen, setPickerOpen] = useState(false)
  const selected = devices.find((device) => device.id === selectedDeviceId)
  const needsStart = selected?.status === 'stopped'
  const busy = creating || starting
  const trimmed = name.trim()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !selected) return
    if (needsStart) onStartDevice?.(selected.id)
    else if (trimmed && nameHint?.tone !== 'error') onSubmit()
  }

  return (
    <form
      onSubmit={submit}
      aria-label={copy.createWebId}
      data-pod-sign-in="create-webid"
      className="flex flex-col gap-4 border-t border-border bg-muted p-4"
      noValidate
    >
      <Field
        label={`1 · ${copy.createStepName}`}
        error={nameHint?.tone === 'error' ? nameHint.text : undefined}
        hint={nameHint?.tone === 'ok'
          ? <span role="status">{nameHint.text}</span>
          : addressPreview ? <span><span className="sr-only">{copy.createNameHint}: </span><Hostname>{addressPreview}</Hostname></span> : undefined}
      >
        {(fieldProps) => (
          <input
            {...fieldProps}
            name="webIdName"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className={fieldClass}
            value={name}
            disabled={busy}
            onChange={(event) => onNameChange(event.target.value)}
          />
        )}
      </Field>

      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-medium text-foreground">{`2 · ${copy.createStepLocation}`}</p>
        {selected ? (
          <div className={listRowClass} data-pod-sign-in="selected-device">
            <DeviceIdentity device={selected} copy={copy} />
            <button
              type="button"
              className={cn(textButtonClass, 'shrink-0 text-primary hover:underline')}
              disabled={busy}
              onClick={() => setPickerOpen(true)}
            >
              {copy.changeDevice}
            </button>
          </div>
        ) : null}
        <p className="text-[13px] text-muted-foreground">{copy.cannotChangeLater}</p>
      </div>

      {creating ? (
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner />
          {copy.creatingNote}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <ActionButton
          type="submit"
          className={primaryButtonClass}
          busy={busy}
          disabled={!selected || (needsStart ? !onStartDevice : !trimmed || nameHint?.tone === 'error')}
        >
          {needsStart ? copy.startDeviceXpod : copy.createPod}
        </ActionButton>
        {onCancel ? (
          <ActionButton variant="outline" className={outlineButtonClass} disabled={busy} onClick={onCancel}>{copy.cancel}</ActionButton>
        ) : null}
      </div>

      <DevicePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onSelect={onSelectDevice}
        onAddDevice={() => {
          setPickerOpen(false)
          onAddDevice()
        }}
        locale={locale}
        copy={overrides}
      />
    </form>
  )
}

export interface WebIdSectionProps extends LocalizedProps {
  webIds: WebIdEntry[]
  /** Open when arriving from authorization with no WebID; collapsed on a plain visit. */
  createOpen: boolean
  onCreateOpenChange(open: boolean): void
  createForm: CreateWebIdFormProps
  onLinkExisting?(): void
  /** Jump to the device that holds a WebID's Pod. */
  onGoToDevice?(deviceId: string): void
}

/** The identities of the account, one row per WebID with its Pod, plus the create form. */
export function WebIdSection({
  webIds,
  createOpen,
  onCreateOpenChange,
  createForm,
  onLinkExisting,
  onGoToDevice,
  locale,
  copy: overrides,
}: WebIdSectionProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} data-pod-sign-in="webid-section" className={sectionClass}>
      <SectionHeader
        id={titleId}
        icon={UserRound}
        title={copy.webIdSectionTitle}
        hint={copy.webIdSectionHint}
        actions={(
        <div className="flex shrink-0 items-center gap-2">
          {onLinkExisting ? (
            <ActionButton variant="ghost" className={smallButtonClass} onClick={onLinkExisting}>{copy.linkExistingWebId}</ActionButton>
          ) : null}
          {!createOpen ? (
            <ActionButton variant="outline" className={smallButtonClass} onClick={() => onCreateOpenChange(true)}>{copy.createWebId}</ActionButton>
          ) : null}
        </div>
        )}
      />

      {webIds.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-3 py-3 text-sm text-muted-foreground">{copy.webIdEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {webIds.map((entry) => (
            <li key={entry.id} className={listRowClass} data-webid-id={entry.id}>
              <PodAvatar name={entry.displayName} avatarUrl={entry.avatarUrl} storage={entry.storage} size={40} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{entry.displayName}</span>
                <Hostname className="truncate">{entry.webId}</Hostname>
                <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  {entry.deviceName ? (
                    entry.deviceId && onGoToDevice ? (
                      <button
                        type="button"
                        className="rounded text-xs text-primary hover:underline"
                        onClick={() => onGoToDevice(entry.deviceId!)}
                      >
                        {formatCopy(copy.podOnDevice, { device: entry.deviceName })}
                      </button>
                    ) : <span>{formatCopy(copy.podOnDevice, { device: entry.deviceName })}</span>
                  ) : null}
                  {entry.authorizedAppCount !== undefined ? (
                    <span>{formatCopy(copy.authorizedApps, { count: entry.authorizedAppCount })}</span>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {createOpen ? (
        <CreateWebIdForm
          {...createForm}
          locale={createForm.locale ?? locale}
          copy={createForm.copy ?? overrides}
          onCancel={createForm.onCancel ?? (webIds.length > 0 ? () => onCreateOpenChange(false) : undefined)}
        />
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Device section
// ---------------------------------------------------------------------------

export interface DeviceSectionProps extends LocalizedProps {
  devices: DeviceSummary[]
  onAddDevice(): void
  /** The device whose network panel is expanded, if any. */
  networkDeviceId?: string
  onToggleNetwork(deviceId: string): void
  /** Props of the panel shown under `networkDeviceId`. */
  network?: Omit<NetworkPanelProps, 'locale' | 'copy'>
  /** Only offered for online devices whose Xpod is stopped, and only when the host can start it. */
  onStartDevice?(deviceId: string): void
  startingDeviceId?: string
}

/** Xpod Cloud and every edge device signed in to this account. Network belongs to the device. */
export function DeviceSection({
  devices,
  onAddDevice,
  networkDeviceId,
  onToggleNetwork,
  network,
  onStartDevice,
  startingDeviceId,
  locale,
  copy: overrides,
}: DeviceSectionProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} data-pod-sign-in="device-section" className={sectionClass}>
      <SectionHeader
        id={titleId}
        icon={Server}
        title={copy.deviceSectionTitle}
        hint={copy.deviceSectionHint}
        actions={<ActionButton variant="outline" className={cn(smallButtonClass, 'shrink-0')} onClick={onAddDevice}>{copy.addDevice}</ActionButton>}
      />
      <ul className="flex flex-col gap-2">
        {devices.map((device) => {
          const expanded = device.id === networkDeviceId
          const panelId = `${titleId}-network-${device.id}`
          return (
            <li key={device.id} className="flex flex-col gap-2" data-device-row={device.id}>
              <div className={listRowClass}>
                <DeviceIdentity device={device} copy={copy} />
                {device.kind === 'edge' ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={expanded ? panelId : undefined}
                    className={cn(textButtonClass, 'shrink-0 text-primary hover:underline')}
                    onClick={() => onToggleNetwork(device.id)}
                  >
                    {expanded ? copy.collapseAction : device.status === 'unreachable' ? copy.fixAction : copy.networkAction}
                    <ChevronRight aria-hidden="true" className={cn('ml-0.5 inline h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')} />
                  </button>
                ) : null}
                {device.status === 'stopped' && onStartDevice ? (
                  <ActionButton
                    variant="outline"
                    className={cn(smallButtonClass, 'shrink-0')}
                    busy={startingDeviceId === device.id}
                    onClick={() => onStartDevice(device.id)}
                  >
                    {copy.startAction}
                  </ActionButton>
                ) : null}
              </div>
              {expanded && network ? (
                <div id={panelId}>
                  <NetworkPanel {...network} locale={locale} copy={overrides} />
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface CredentialEntry {
  id: string
  label: string
  /** The WebID this credential acts as. */
  webIdName: string
  createdLabel?: string
}

export interface CredentialSectionProps extends LocalizedProps {
  credentials: CredentialEntry[]
  /** False when the account has no WebID yet. */
  canCreate: boolean
  onCreate(): void
  onRevoke?(credentialId: string): void
}

/** Solid client credentials: let a script or service reach a Pod as one WebID. */
export function CredentialSection({ credentials, canCreate, onCreate, onRevoke, locale, copy: overrides }: CredentialSectionProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} data-pod-sign-in="credential-section" className={sectionClass}>
      <SectionHeader
        id={titleId}
        icon={KeyRound}
        title={copy.credentialSectionTitle}
        hint={copy.credentialSectionHint}
        actions={<ActionButton variant="outline" className={cn(smallButtonClass, 'shrink-0')} disabled={!canCreate} onClick={onCreate}>{copy.createCredential}</ActionButton>}
      />
      {credentials.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-3 py-3 text-sm text-muted-foreground">{copy.credentialEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {credentials.map((credential) => (
            <li key={credential.id} className={listRowClass}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">{credential.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {credential.webIdName}{credential.createdLabel ? ` · ${credential.createdLabel}` : ''}
                </span>
              </span>
              {onRevoke ? (
                <button
                  type="button"
                  aria-label={`${copy.revokeCredential} ${credential.label}`}
                  className={cn(textButtonClass, 'shrink-0 text-destructive hover:underline')}
                  onClick={() => onRevoke(credential.id)}
                >
                  {copy.revokeCredential}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Consent resume banner
// ---------------------------------------------------------------------------

export interface ConsentResumeBannerProps extends LocalizedProps {
  app: AppIdentity
  /** False until a Pod exists: the continue button stays disabled. */
  podReady: boolean
  onContinue(): void
  onCancel(): void
  /** Replaces the default status sentence. */
  statusText?: ReactNode
  pending?: boolean
}

/** Top-of-page bar that leads back to authorization after managing the account. */
export function ConsentResumeBanner({
  app,
  podReady,
  onContinue,
  onCancel,
  statusText,
  pending = false,
  locale,
  copy: overrides,
}: ConsentResumeBannerProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      data-pod-sign-in="consent-resume"
      className="pod-sign-in flex flex-wrap items-center gap-3 rounded-lg bg-muted px-4 py-3 text-foreground"
    >
      {app.icon ? (
        <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg">{app.icon}</span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <p id={titleId} className="text-sm font-semibold">{formatCopy(copy.resumeTitle, { app: app.name })}</p>
        <p role="status" aria-live="polite" className="text-[13px] text-muted-foreground">
          {statusText ?? (podReady ? copy.resumeReady : copy.resumeWaiting)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className={cn(textButtonClass, 'text-primary hover:underline')} disabled={pending} onClick={onCancel}>
          {copy.resumeCancel}
        </button>
        <ActionButton className="h-11 rounded-lg px-4 text-sm font-medium" busy={pending} disabled={!podReady} onClick={onContinue}>
          {formatCopy(copy.resumeContinue, { app: app.name })}
        </ActionButton>
      </div>
    </section>
  )
}
