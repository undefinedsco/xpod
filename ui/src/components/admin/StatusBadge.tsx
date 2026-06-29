import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type HealthState = 'healthy' | 'degraded' | 'failed' | 'unknown';

const healthClass: Record<HealthState, string> = {
  healthy: 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300',
  degraded: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
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
