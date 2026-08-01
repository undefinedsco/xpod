import { jsx as _jsx } from "react/jsx-runtime";
import { cva } from 'class-variance-authority';
import { cn } from './utils.js';
export const badgeVariants = cva('inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring/50 focus:ring-offset-2', {
    variants: {
        variant: {
            default: 'border-transparent bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90',
            secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
            destructive: 'border-transparent bg-destructive text-destructive-foreground shadow-sm shadow-destructive/20 hover:bg-destructive/90',
            outline: 'border-border/40 text-foreground bg-muted/30 backdrop-blur-sm',
        },
    },
    defaultVariants: { variant: 'default' },
});
export function Badge({ className, variant, ...props }) {
    return _jsx("div", { className: cn(badgeVariants({ variant }), className), ...props });
}
