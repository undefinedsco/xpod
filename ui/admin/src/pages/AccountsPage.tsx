import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { formatBytes, formatQuota } from '../modules/format';

interface AccountRow {
  accountId: string;
  email?: string;
  displayName?: string;
  quotaLimit?: number | null;
  usedBytes?: number | null;
  podIds: string[];
}

export function AccountsPage(): JSX.Element {
  const { t } = useTranslation();
  const [ loading, setLoading ] = useState(true);
  const [ error, setError ] = useState<string | null>(null);
  const [ accounts, setAccounts ] = useState<AccountRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/admin/accounts', { credentials: 'include' });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            setError('Unauthorized. Please sign in with an administrator account.');
          } else {
            setError(`Failed to load accounts (status ${response.status}).`);
          }
          return;
        }
        const payload = await response.json();
        if (cancelled) {
          return;
        }
        setAccounts(Array.isArray(payload.accounts) ? payload.accounts : []);
      } catch (cause) {
        if (!cancelled) {
          setError((cause as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader title={t('accounts.title')} subtitle={t('accounts.summary')}>
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/60 dark:text-red-200">
            {error}
          </div>
        )}
        {!error && loading && (
          <div className="animate-pulse rounded-lg border border-slate-200 bg-slate-100 p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
            Loading accounts…
          </div>
        )}
        {!error && !loading && accounts.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
            {t('accounts.empty')}
          </div>
        )}
        {!error && !loading && accounts.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm dark:border-slate-800">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3 text-right">Pods</th>
                  <th className="px-4 py-3 text-right">Usage</th>
                  <th className="px-4 py-3 text-right">Quota</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white text-sm dark:divide-slate-800 dark:bg-slate-900/50">
                {accounts.map((account) => (
                  <tr key={account.accountId}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {account.displayName ?? account.email ?? account.accountId}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {account.email ?? '—'} · {account.accountId}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{account.podIds.length}</td>
                    <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{formatBytes(account.usedBytes)}</td>
                    <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{formatQuota(account.quotaLimit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageHeader>
    </div>
  );
}
