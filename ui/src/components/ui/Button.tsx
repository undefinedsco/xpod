import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';
import { clsx } from 'clsx';

type Variant = 'default' | 'secondary' | 'ghost';
type Size = 'default' | 'sm';

export function Button(
  props: PropsWithChildren<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: Variant;
      size?: Size;
    }
  >,
) {
  const { className, variant = 'default', size = 'default', children, ...rest } = props;

  const base =
    'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:pointer-events-none';

  const variants: Record<Variant, string> = {
    default: 'bg-primary text-primary-foreground hover:bg-primary/90',
    secondary: 'bg-muted text-foreground hover:bg-muted/80',
    ghost: 'bg-transparent hover:bg-muted text-foreground',
  };

  const sizes: Record<Size, string> = {
    default: 'h-10 px-4 py-2',
    sm: 'h-8 px-3',
  };

  return (
    <button className={clsx(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </button>
  );
}
