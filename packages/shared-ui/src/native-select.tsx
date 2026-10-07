import * as React from 'react'
import { formControlClass } from './form-control'
import { cn } from './utils'

export interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

/** Native options, change events and form submission, with the shared control surface. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, multiple, size, ...props }, ref) => (
    <select
      ref={ref}
      multiple={multiple}
      size={size}
      className={cn(formControlClass, !multiple && (!size || size <= 1) && 'min-h-10', className)}
      {...props}
    />
  ),
)
NativeSelect.displayName = 'NativeSelect'
