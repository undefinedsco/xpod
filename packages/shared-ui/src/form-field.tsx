import { useId, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from './utils'

export interface FormFieldControlProps {
  id: string
  'aria-invalid'?: true
  'aria-describedby'?: string
}

export interface FormFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode
  error?: string
  hint?: ReactNode
  labelAside?: ReactNode
  children: (props: FormFieldControlProps) => ReactNode
}

/** Presentation only: callers own the control, validation and submission. */
export function FormField({ label, error, hint, labelAside, children, className, ...props }: FormFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : undefined, hint ? hintId : undefined].filter(Boolean).join(' ') || undefined
  return (
    <div {...props} className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-foreground">{label}</label>
        {labelAside}
      </div>
      {children({ id, ...(error ? { 'aria-invalid': true as const } : {}), 'aria-describedby': describedBy })}
      {error ? <p id={errorId} role="alert" className="text-[13px] text-destructive">{error}</p> : null}
      {hint ? <div id={hintId} className="text-[13px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
