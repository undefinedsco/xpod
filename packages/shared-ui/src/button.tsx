import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { buttonFocusClass } from './focus'
import { cn } from './utils'

export const buttonVariants = cva(
  `inline-flex items-center justify-center whitespace-normal rounded-md text-sm font-medium transition-colors active:translate-y-px ${buttonFocusClass} disabled:pointer-events-none disabled:opacity-50`,
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:bg-primary/80',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:bg-destructive/80',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:bg-accent focus-visible:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 focus-visible:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline focus-visible:underline',
        subtle: 'bg-muted text-muted-foreground hover:bg-muted/80 focus-visible:bg-muted/60',
      },
      size: {
        default: 'min-h-10 px-4 py-2',
        sm: 'min-h-9 rounded-md px-3 py-1',
        lg: 'min-h-11 rounded-md px-8 py-2',
        icon: 'h-10 w-10',
      },
    },
    compoundVariants: [{ variant: 'default', className: 'min-h-11' }],
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : 'button'
    return (
      <Component
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'
