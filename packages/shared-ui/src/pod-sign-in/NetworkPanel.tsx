import { Check, Minus, X } from 'lucide-react'
import { useId } from 'react'
import { cn } from '../utils'
import { formatCopy, resolvePodSignInCopy, type PodSignInCopy, type PodSignInLocale } from './copy'
import { ActionButton, Field, Spinner, fieldClass, outlineButtonClass, primaryButtonClass } from './parts'

export type ProbeState = 'idle' | 'checking' | 'ok' | 'failed'

/** This computer, the local network, and other networks (the public entry). */
export interface NetworkChecks {
  local: ProbeState
  lan: ProbeState
  wan: ProbeState
}

export interface TunnelFieldDescriptor {
  key: string
  label: string
  /** Rendered as a password input. */
  secret?: boolean
}

/**
 * One tunnel option, generated from the provider catalog (`TunnelProviderCatalog`:
 * `id`, `label`, `parameterFields`, plus the credential field). The panel renders
 * fields from this description and never branches on the provider.
 */
export interface TunnelOption {
  id: string
  label: string
  parameterFields: readonly TunnelFieldDescriptor[]
  credentialField?: TunnelFieldDescriptor
}

export interface NetworkPanelProps {
  checks: NetworkChecks
  tunnels: readonly TunnelOption[]
  selectedTunnelId?: string
  /** Field values keyed by `TunnelFieldDescriptor.key`. */
  fieldValues: Record<string, string>
  /** Label of the tunnel that makes the public entry reachable, once it does. */
  activeTunnelLabel?: string
  busy?: boolean
  onSelectTunnel(id: string): void
  onFieldChange(key: string, value: string): void
  /** "Enable and recheck". */
  onEnable(): void
  onRecheck(): void
  /** When given (inside "add device"), the actions become "Skip, set up later" / "Enable and check". */
  onSkip?(): void
  locale?: PodSignInLocale
  copy?: Partial<PodSignInCopy>
}

function probeLabel(state: ProbeState, copy: PodSignInCopy): string {
  switch (state) {
    case 'idle': return copy.probeIdle
    case 'checking': return copy.probeChecking
    case 'ok': return copy.probeOk
    case 'failed': return copy.probeFailed
  }
}

function ProbeIcon({ state }: { state: ProbeState }) {
  if (state === 'checking') return <Spinner />
  if (state === 'ok') return <Check aria-hidden="true" className="h-4 w-4 text-success" />
  if (state === 'failed') return <X aria-hidden="true" className="h-4 w-4 text-warning" />
  return <Minus aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
}

/** Network access of one device: three checks, and four tunnels when the public entry fails. */
export function NetworkPanel({
  checks,
  tunnels,
  selectedTunnelId,
  fieldValues,
  activeTunnelLabel,
  busy = false,
  onSelectTunnel,
  onFieldChange,
  onEnable,
  onRecheck,
  onSkip,
  locale,
  copy: overrides,
}: NetworkPanelProps) {
  const copy = resolvePodSignInCopy(locale, overrides)
  const titleId = useId()
  const tunnelLabelId = useId()
  const selected = tunnels.find((tunnel) => tunnel.id === selectedTunnelId)
  const fields = selected ? [...selected.parameterFields, ...(selected.credentialField ? [selected.credentialField] : [])] : []
  const rows: Array<[keyof NetworkChecks, string]> = [
    ['local', copy.probeLocal],
    ['lan', copy.probeLan],
    ['wan', copy.probeWan],
  ]
  const checking = Object.values(checks).includes('checking')
  const showTunnels = checks.wan === 'failed'

  return (
    <section
      aria-labelledby={titleId}
      data-pod-sign-in="network-panel"
      className="pod-sign-in flex flex-col gap-4 rounded-lg bg-muted p-3"
    >
      <h3 id={titleId} className="text-sm font-semibold text-foreground">{copy.networkTitle}</h3>

      <ul className="grid grid-cols-3 gap-2" aria-busy={checking || undefined}>
        {rows.map(([key, label]) => (
          <li key={key} data-probe={key} data-state={checks[key]} className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2 text-[13px]">
            <span className="text-foreground">{label}</span>
            <span className="flex items-center gap-1 text-muted-foreground">
              <ProbeIcon state={checks[key]} />
              {probeLabel(checks[key], copy)}
            </span>
          </li>
        ))}
      </ul>

      {checks.wan === 'ok' && activeTunnelLabel ? (
        <p role="status" className="text-[13px] text-success">{formatCopy(copy.reachableVia, { tunnel: activeTunnelLabel })}</p>
      ) : null}

      {showTunnels ? (
        <div className="flex flex-col gap-3">
          <p id={tunnelLabelId} className="text-[13px] font-medium text-foreground">{copy.tunnelTitle}</p>
          <div role="radiogroup" aria-labelledby={tunnelLabelId} className="grid grid-cols-2 gap-2">
            {tunnels.map((tunnel) => {
              const isSelected = tunnel.id === selectedTunnelId
              return (
                <label
                  key={tunnel.id}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-sm focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
                    isSelected ? 'border-primary bg-accent text-foreground' : 'border-border bg-card text-foreground',
                  )}
                >
                  <input
                    type="radio"
                    name="tunnel-provider"
                    className="sr-only"
                    value={tunnel.id}
                    checked={isSelected}
                    disabled={busy}
                    onChange={() => onSelectTunnel(tunnel.id)}
                  />
                  {tunnel.label}
                </label>
              )
            })}
          </div>
          {fields.map((field) => (
            <Field key={field.key} label={field.label}>
              {(fieldProps) => (
                <input
                  {...fieldProps}
                  name={field.key}
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  className={fieldClass}
                  value={fieldValues[field.key] ?? ''}
                  disabled={busy}
                  onChange={(event) => onFieldChange(field.key, event.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {showTunnels ? (
          <ActionButton className={primaryButtonClass} busy={busy} disabled={!selected} onClick={onEnable}>
            {onSkip ? copy.enableAndCheck : copy.enableAndRecheck}
          </ActionButton>
        ) : null}
        {onSkip ? (
          <ActionButton variant="outline" className={outlineButtonClass} disabled={busy} onClick={onSkip}>{copy.skipForNow}</ActionButton>
        ) : (
          <ActionButton variant="outline" className={outlineButtonClass} disabled={busy || checking} onClick={onRecheck}>{copy.recheck}</ActionButton>
        )}
      </div>

      <p className="text-[13px] text-muted-foreground">{copy.networkFootnote}</p>
    </section>
  )
}
