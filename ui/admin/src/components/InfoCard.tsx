import type { ReactNode } from 'react';
import clsx from 'clsx';

interface InfoCardProps {
  title: string;
  value?: ReactNode;
  description?: string;
  icon?: ReactNode;
  className?: string;
  footer?: ReactNode;
}

export function InfoCard({ title, value, description, icon, className, footer }: InfoCardProps): JSX.Element {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70 sm:p-6',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-500 dark:text-slate-400">{title}</div>
          {value && <div className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{value}</div>}
          {description && <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>}
        </div>
        {icon && <div className="text-primary-500 dark:text-primary-300">{icon}</div>}
      </div>
      {footer && <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">{footer}</div>}
    </div>
  );
}
