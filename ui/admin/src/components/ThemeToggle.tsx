import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoonIcon, SunIcon } from './icons';

type ThemeMode = 'light' | 'dark';

export function ThemeToggle(): JSX.Element {
  const { t } = useTranslation();
  const [ mode, setMode ] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') {
      return 'light';
    }
    const stored = window.localStorage.getItem('xpod-theme');
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'dark') {
      root.classList.add('dark');
      root.dataset.mode = 'dark';
    } else {
      root.classList.remove('dark');
      root.dataset.mode = 'light';
    }
    window.localStorage.setItem('xpod-theme', mode);
  }, [ mode ]);

  const toggle = useCallback(() => {
    setMode((value) => (value === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      title={t('actions.toggleTheme')}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition-colors hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
    >
      {mode === 'dark' ? <MoonIcon className="h-5 w-5" /> : <SunIcon className="h-5 w-5" />}
    </button>
  );
}
