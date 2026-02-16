import type { PropsWithChildren } from 'react';
import { clsx } from 'clsx';

export function Card(props: PropsWithChildren<{ className?: string; variant?: 'bordered' }>) {
  const { className, variant, children } = props;
  return (
    <div
      className={clsx(
        'rounded-xl bg-background',
        variant === 'bordered' && 'border border-border',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader(props: PropsWithChildren<{ className?: string }>) {
  const { className, children } = props;
  return <div className={clsx('px-5 pt-5', className)}>{children}</div>;
}

export function CardTitle(props: PropsWithChildren<{ className?: string }>) {
  const { className, children } = props;
  return <div className={clsx('text-base font-semibold', className)}>{children}</div>;
}

export function CardContent(props: PropsWithChildren<{ className?: string }>) {
  const { className, children } = props;
  return <div className={clsx('px-5 pb-5 pt-4', className)}>{children}</div>;
}
