import * as React from 'react'
import { Check, Minus } from 'lucide-react'
import { controlFocusClass } from './focus'
import { cn } from './utils'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  indeterminate?: boolean
}

/** A real form input: checked state and change events remain native. */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, indeterminate = false, ...props }, forwardedRef) => {
    const inputRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(forwardedRef, () => inputRef.current!)
    React.useEffect(() => {
      if (inputRef.current) inputRef.current.indeterminate = indeterminate
    })
    return (
      <span className="relative inline-flex shrink-0 items-center justify-center align-middle">
        <input
          {...props}
          ref={inputRef}
          type="checkbox"
          className={cn(
            'peer m-0 h-4 w-4 shrink-0 appearance-none rounded border border-input bg-background checked:border-primary checked:bg-primary checked:bg-none indeterminate:border-primary indeterminate:bg-primary indeterminate:bg-none disabled:cursor-not-allowed disabled:opacity-50',
            controlFocusClass,
            className,
          )}
        />
        <Check aria-hidden="true" className="pointer-events-none absolute hidden h-3 w-3 text-primary-foreground peer-checked:block peer-indeterminate:hidden peer-disabled:opacity-50" strokeWidth={3} />
        <Minus aria-hidden="true" className="pointer-events-none absolute hidden h-3 w-3 text-primary-foreground peer-indeterminate:block peer-disabled:opacity-50" strokeWidth={3} />
      </span>
    )
  },
)
Checkbox.displayName = 'Checkbox'
