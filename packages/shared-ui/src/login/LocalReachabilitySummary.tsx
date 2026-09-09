import { Check, Loader2, X } from 'lucide-react'

import { cn } from '../utils'
import type { LocalOnboardingConnectivity, LocalOnboardingRouteProbe } from './types'

type ReachabilityState = 'checking' | 'reachable' | 'unreachable'

export function LocalReachabilitySummary({
  connectivity,
  assumeLocalReachable = false,
  className,
}: {
  connectivity: LocalOnboardingConnectivity | null | undefined
  assumeLocalReachable?: boolean
  className?: string
}) {
  return (
    <div className={cn('rounded-2xl border border-border/60 bg-muted/25 p-3', className)}>
      <div className="space-y-2">
        <ReachabilityRow
          label="本机可以访问"
          state={assumeLocalReachable
            ? 'reachable'
            : resolveReachabilityState(connectivity?.local ?? null, connectivity)}
        />
        <ReachabilityRow
          label="公网可以访问"
          state={resolveReachabilityState(connectivity?.public ?? null, connectivity)}
        />
      </div>
    </div>
  )
}

function ReachabilityRow({
  label,
  state,
}: {
  label: string
  state: ReachabilityState
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/70 px-3 py-2">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <ReachabilityIcon label={label} state={state} />
    </div>
  )
}

function ReachabilityIcon({
  label,
  state,
}: {
  label: string
  state: ReachabilityState
}) {
  const accessibleLabel = state === 'reachable'
    ? `${label}：是`
    : state === 'unreachable'
      ? `${label}：否`
      : `${label}：检测中`

  return (
    <span
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className={cn(
        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
        state === 'reachable' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        state === 'unreachable' && 'bg-destructive/10 text-destructive',
        state === 'checking' && 'bg-muted text-muted-foreground',
      )}
    >
      {state === 'reachable' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {state === 'unreachable' ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : null}
      {state === 'checking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
    </span>
  )
}

function resolveReachabilityState(
  probe: LocalOnboardingRouteProbe | null,
  connectivity: LocalOnboardingConnectivity | null | undefined,
): ReachabilityState {
  if (connectivity?.status === 'checking') {
    return 'checking'
  }

  if (probe?.reachable === true) {
    return 'reachable'
  }

  if (probe?.reachable === false) {
    return 'unreachable'
  }

  return connectivity?.status === 'unknown' || !connectivity
    ? 'checking'
    : 'unreachable'
}
