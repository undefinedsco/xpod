import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const LANG_OPTIONS: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
];

export function LanguageSwitcher(): JSX.Element {
  const { i18n, t } = useTranslation();

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      void i18n.changeLanguage(event.target.value);
    },
    [ i18n ],
  );

  return (
    <label className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
      <span>{t('actions.changeLanguage')}</span>
      <select
        value={i18n.language}
        onChange={handleChange}
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
      >
        {LANG_OPTIONS.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
