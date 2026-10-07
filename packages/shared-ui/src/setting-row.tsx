import * as React from 'react'
import { Switch } from './switch'
import { cn } from './utils'

export interface SettingRowControlProps {
  id: string
  'aria-describedby'?: string
}

export interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: React.ReactNode
  description?: React.ReactNode
  /**
   * Render the control; callers must apply the supplied `id` to the actual
   * control so the visible label is associated with it.
   */
  control: (props: SettingRowControlProps) => React.ReactNode
}

/** Pure label/description/control row. Business state stays with the caller. */
export function SettingRow({ label, description, control, className, ...props }: SettingRowProps) {
  const id = React.useId()
  const descriptionId = description ? `${id}-description` : undefined
  return (
    <div className={cn('flex min-h-16 items-center justify-between gap-3 border-b border-border', className)} {...props}>
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm leading-normal text-foreground">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="mt-1 text-xs leading-normal text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{control({ id, 'aria-describedby': descriptionId })}</div>
    </div>
  )
}

export interface SwitchSettingRowProps extends Omit<SettingRowProps, 'control'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

/** Convenience setting row that reuses the shared `Switch` implementation. */
export function SwitchSettingRow({ checked, onCheckedChange, disabled, ...props }: SwitchSettingRowProps) {
  return (
    <SettingRow
      {...props}
      control={({ id, 'aria-describedby': describedBy }) => (
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-describedby={describedBy}
        />
      )}
    />
  )
}
