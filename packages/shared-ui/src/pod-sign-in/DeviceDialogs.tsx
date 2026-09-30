import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog'
import { cn } from '../utils'
import { DeviceIdentity, type DeviceSummary } from './account-parts'
import { resolvePodSignInCopy, type PodSignInCopy, type PodSignInLocale } from './copy'
import { NetworkPanel, type NetworkPanelProps } from './NetworkPanel'
import { ActionButton, outlineButtonClass, primaryButtonClass } from './parts'

const dialogClass = 'pod-sign-in max-h-[90dvh] w-[min(400px,calc(100vw-2rem))] max-w-[400px] gap-4 overflow-y-auto rounded-xl bg-card p-5'

interface LocalizedProps {
  locale?: PodSignInLocale
  copy?: Partial<PodSignInCopy>
}

export interface DevicePickerDialogProps extends LocalizedProps {
  open: boolean
  onOpenChange(open: boolean): void
  devices: DeviceSummary[]
  selectedDeviceId?: string
  /** Picking a row selects it and closes the dialog. */
  onSelect(deviceId: string): void
  onAddDevice(): void
}

/** "Choose where to store": pick a row, like choosing a delivery address. Offline devices are greyed out. */
export function DevicePickerDialog({
  open,
  onOpenChange,
  devices,
  selectedDeviceId,
  onSelect,
  onAddDevice,
  locale,
  copy: overrides,
}: DevicePickerDialogProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClass} aria-describedby={undefined}>
        <DialogTitle className="text-[17px] leading-6">{copy.devicePickerTitle}</DialogTitle>
        <div role="radiogroup" aria-label={copy.devicePickerTitle} className="flex flex-col gap-2">
          {devices.map((device) => {
            const selectable = device.status !== 'offline'
            const selected = device.id === selectedDeviceId
            return (
              <button
                key={device.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!selectable}
                className={cn(
                  'flex min-h-14 w-full items-center rounded-lg border px-3 py-2 text-left',
                  selected ? 'border-primary bg-accent' : 'border-border bg-card',
                  selectable ? 'hover:bg-accent' : 'cursor-not-allowed opacity-50',
                )}
                onClick={() => {
                  onSelect(device.id)
                  onOpenChange(false)
                }}
              >
                <DeviceIdentity device={device} copy={copy} />
              </button>
            )
          })}
        </div>
        <ActionButton variant="outline" className={outlineButtonClass} onClick={onAddDevice}>{copy.addDevice}</ActionButton>
      </DialogContent>
    </Dialog>
  )
}

export type AddDeviceStep = 1 | 2 | 3

export interface AddDeviceDialogProps extends LocalizedProps {
  open: boolean
  onOpenChange(open: boolean): void
  step: AddDeviceStep
  /** Only when the host can launch Xpod Edge on this computer, and it has not joined yet. */
  canJoinThisComputer?: boolean
  joining?: boolean
  onJoinThisComputer?(): void
  /** The device that came online (steps 2 and 3). */
  device?: DeviceSummary
  /** Network checks and tunnel form for step 2. `onSkip` is supplied by the dialog. */
  network: Omit<NetworkPanelProps, 'onSkip' | 'locale' | 'copy'>
  /** Step 2: leave the network as is and finish ("Skip, set up later", or "Continue" once reachable). */
  onNetworkDone(): void
  /** Where the dialog was opened from decides the final button: "Done" or "Use this device". */
  origin: 'device-section' | 'picker'
  onFinish(): void
}

/** Add a device in three steps: install and sign in, check the network, done. */
export function AddDeviceDialog({
  open,
  onOpenChange,
  step,
  canJoinThisComputer = false,
  joining = false,
  onJoinThisComputer,
  device,
  network,
  onNetworkDone,
  origin,
  onFinish,
  locale,
  copy: overrides,
}: AddDeviceDialogProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const steps = [copy.stepInstall, copy.stepNetwork, copy.stepDone]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={dialogClass} aria-describedby={undefined}>
        <DialogTitle className="text-[17px] leading-6">{copy.addDeviceTitle}</DialogTitle>
        <ol className="flex items-center gap-2 text-[13px]" aria-label={copy.addDeviceTitle}>
          {steps.map((label, index) => {
            const number = index + 1
            const state = number === step ? 'current' : number < step ? 'done' : 'todo'
            return (
              <li
                key={label}
                aria-current={state === 'current' ? 'step' : undefined}
                data-step-state={state}
                className={cn('flex min-w-0 items-center gap-1', state === 'current' ? 'font-semibold text-foreground' : 'text-muted-foreground')}
              >
                <span aria-hidden="true" className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs', state === 'todo' ? 'bg-muted' : 'bg-primary text-primary-foreground')}>{number}</span>
                <span className="truncate">{label}</span>
              </li>
            )
          })}
        </ol>

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            {canJoinThisComputer ? (
              <ActionButton className={primaryButtonClass} busy={joining} onClick={onJoinThisComputer}>{copy.joinThisComputer}</ActionButton>
            ) : null}
            <p className="text-sm text-foreground">{copy.installOnOther}</p>
            <p role="status" aria-live="polite" className="text-[13px] text-muted-foreground">{copy.waitingForDevice}</p>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-4">
            {device ? <DeviceOnlineCard device={device} copy={copy} /> : null}
            {network.checks.wan === 'failed' ? (
              <NetworkPanel {...network} locale={locale} copy={overrides} onSkip={onNetworkDone} />
            ) : (
              <>
                <NetworkPanel {...network} locale={locale} copy={overrides} />
                <ActionButton className={primaryButtonClass} disabled={network.checks.wan === 'checking'} onClick={onNetworkDone}>
                  {copy.customSubmit}
                </ActionButton>
              </>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-4">
            {device ? <DeviceOnlineCard device={device} copy={copy} /> : null}
            <ActionButton className={primaryButtonClass} onClick={onFinish}>
              {origin === 'picker' ? copy.useThisDevice : copy.finish}
            </ActionButton>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function DeviceOnlineCard({ device, copy }: { device: DeviceSummary; copy: PodSignInCopy }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3" data-pod-sign-in="new-device">
      <DeviceIdentity device={device} copy={copy} showStatus={false} />
      <span role="status" className="shrink-0 text-[13px] text-success">{copy.deviceOnline}</span>
    </div>
  )
}
