import * as React from 'react'
import { Switch } from './switch'
import { cn } from './utils'

export interface SettingRowControlProps {
  id: string
  'aria-describedby'?: string
  'aria-labelledby'?: string
}

export interface SettingRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: React.ReactNode
  description?: React.ReactNode
  /**
   * Render the control; callers must apply the supplied attributes to the actual
   * control so its name and description remain associated with the full-row label.
   */
  control: (props: SettingRowControlProps) => React.ReactNode
}

/** Pure label/description/control row. Business state stays with the caller. */
export function SettingRow({ label, description, control, className, ...props }: SettingRowProps) {
  const id = React.useId()
  const labelId = `${id}-label`
  const descriptionId = description ? `${id}-description` : undefined
  return (
    <div className={cn('border-b border-border', className)} {...props}>
      <label htmlFor={id} className="flex min-h-16 w-full cursor-pointer items-center justify-between gap-3">
        <span className="min-w-0">
          <span id={labelId} className="text-sm leading-normal text-foreground">{label}</span>
          {description ? (
            <span id={descriptionId} className="mt-1 block text-xs leading-normal text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        <span className="shrink-0">{control({ id, 'aria-describedby': descriptionId, 'aria-labelledby': labelId })}</span>
      </label>
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
      control={(controlProps) => (
        <Switch
          {...controlProps}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
        />
      )}
    />
  )
}
