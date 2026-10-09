import * as React from 'react'
import { cn } from './utils'

export type MeterTone = 'primary' | 'success' | 'warning' | 'danger'

const meterToneClass: Record<MeterTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
}

export interface MeterBaseProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Upper bound of the track; defaults to 100. */
  max?: number
  tone?: MeterTone
}

/**
 * A known value must be named for assistive tech; when the value is unknown the
 * track is decorative and the surrounding copy carries the meaning.
 */
export type MeterProps =
  | (MeterBaseProps & { value: number; label: string })
  | (MeterBaseProps & { value?: undefined; label?: string })

/**
 * Thin track meter for capacity / progress readings. Maps to the shared theme
 * tokens and keeps a single visual language across applets. When `value` is
 * absent the element is decorative and the surrounding copy carries meaning.
 */
export function Meter({ value, max = 100, label, tone = 'primary', className, ...props }: MeterProps) {
  const boundedMax = Number.isFinite(max) && max > 0 ? max : 100
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return (
      <div
        aria-hidden="true"
        className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
        {...props}
      />
    )
  }
  const clamped = Math.max(0, Math.min(boundedMax, value))
  const percent = (clamped / boundedMax) * 100
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={boundedMax}
      aria-valuenow={clamped}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className={cn('h-full rounded-full', meterToneClass[tone])}
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  )
}
