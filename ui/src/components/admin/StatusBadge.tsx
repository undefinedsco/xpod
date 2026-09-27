import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type HealthState = 'healthy' | 'degraded' | 'failed' | 'unknown';

const healthClass: Record<HealthState, string> = {
  healthy: 'border-success/40 bg-success/10 text-success dark:border-success/40 dark:bg-success/40 dark:text-success',
  degraded: 'border-warning/40 bg-warning/10 text-warning dark:border-warning/40 dark:bg-warning/40 dark:text-warning',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  unknown: 'border-border bg-muted text-muted-foreground',
};

export function StatusBadge(props: { state: HealthState; children: ReactNode; className?: string }) {
  const { state, children, className } = props;
  return (
    <span className={clsx('inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium', healthClass[state], className)}>
      {children}
    </span>
  );
}
