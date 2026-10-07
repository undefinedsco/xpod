import * as React from 'react'
import { formControlClass } from './form-control'
import { cn } from './utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(formControlClass, 'min-h-20 resize-y', className)} {...props} />
  ),
)
Textarea.displayName = 'Textarea'
