import type { InputHTMLAttributes, LabelHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return (
    <input
      className={clsx(
        'w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm',
        'placeholder:text-muted-foreground',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        className,
      )}
      {...rest}
    />
  );
}

export function Label(props: LabelHTMLAttributes<HTMLLabelElement>) {
  const { className, ...rest } = props;
  return <label className={clsx('text-sm font-medium text-foreground', className)} {...rest} />;
}
