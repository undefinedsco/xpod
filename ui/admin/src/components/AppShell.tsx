import clsx from 'clsx';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeToggle } from './ThemeToggle';
import type { DeploymentEdition, NavigationEntry } from '../types/ui';

interface AppShellProps {
  routes: NavigationEntry[];
  edition: DeploymentEdition;
  children: ReactNode;
}

export function AppShell({ routes, edition, children }: AppShellProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen w-full bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="hidden w-64 flex-col border-r border-slate-200 bg-slate-50/90 px-4 py-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 md:flex">
        <div className="mb-8 space-y-2">
          <div className="text-lg font-semibold tracking-tight">{t('brand')}</div>
          <div className="inline-flex items-center gap-2 rounded-full bg-primary-100 px-3 py-1 text-xs font-semibold text-primary-700 dark:bg-primary-500/10 dark:text-primary-200">
            <span>{t(`layout.edition.${edition}`)}</span>
            <span>·</span>
            <span>{t('layout.beta')}</span>
          </div>
        </div>
        <nav className="flex-1 space-y-1 text-sm font-medium">
          {routes.map((route) => (
            <NavLink
              key={route.path}
              to={route.path}
              className={({ isActive }) =>
                clsx(
                  'flex items-center justify-between rounded-md px-3 py-2 transition-colors',
                  isActive
                    ? 'bg-primary-500 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-primary-50 hover:text-primary-600 dark:text-slate-300 dark:hover:bg-primary-500/10 dark:hover:text-primary-200',
                )
              }
            >
              <span className="flex items-center gap-2">
                {route.icon}
                {t(route.translationKey)}
              </span>
              {route.clusterOnly && edition === 'local' && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-200">
                  {t('edition.clusterOnly')}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-10 space-y-4">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </aside>
      <main className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-4 shadow-sm dark:border-slate-800 md:hidden">
          <div>
            <div className="text-base font-semibold">{t('brand')}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t(`layout.edition.${edition}`)}</div>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <section className="flex-1 overflow-y-auto bg-slate-50/60 px-4 py-6 dark:bg-slate-900/40 sm:px-8 sm:py-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">{children}</div>
        </section>
      </main>
    </div>
  );
}
