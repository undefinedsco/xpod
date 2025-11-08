import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { useAdminConfig } from '../context/AdminConfigContext';
import { formatDateTime } from '../modules/format';

interface EdgeNode {
  nodeId: string;
  displayName?: string;
  podCount: number;
  createdAt?: string;
  lastSeen?: string;
  metadata?: Record<string, unknown> | null;
}

interface CreateNodeResponse {
  nodeId: string;
  token: string;
  createdAt: string;
}

export function NodesPage(): JSX.Element {
  const { t } = useTranslation();
  const config = useAdminConfig();
  const nodesEnabled = config.features.nodes;
  const [ nodes, setNodes ] = useState<EdgeNode[]>([]);
  const [ loading, setLoading ] = useState(true);
  const [ error, setError ] = useState<string | null>(null);
  const [ displayName, setDisplayName ] = useState('');
  const [ creating, setCreating ] = useState(false);
  const [ creationResult, setCreationResult ] = useState<CreateNodeResponse | null>(null);

  const publicBaseUrl = useMemo(() => config.baseUrl ?? t('nodes.baseUrlUnset'), [ config.baseUrl, t ]);
  const signalEndpoint = useMemo(() => config.signalEndpoint ?? t('nodes.signalEndpointUnset'), [ config.signalEndpoint, t ]);

  const fetchNodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/admin/nodes', { credentials: 'include' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setError(t('nodes.errorUnauthorized'));
        } else {
          setError(t('nodes.errorFetch', { status: response.status }));
        }
        return;
      }
      const payload = await response.json();
      const list: EdgeNode[] = Array.isArray(payload.nodes) ? payload.nodes : [];
      setNodes(list);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [ t ]);

  useEffect(() => {
    if (!nodesEnabled) {
      setLoading(false);
      setNodes([]);
      return;
    }
    void fetchNodes();
  }, [ nodesEnabled, fetchNodes ]);

  const handleCreate = useCallback(async () => {
    if (creating || !nodesEnabled) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const response = await fetch('/admin/nodes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim() || undefined,
        }),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setError(t('nodes.errorUnauthorized'));
        } else {
          const body = await response.json().catch(() => ({}));
          const message = typeof body.message === 'string' ? body.message : t('nodes.errorCreate', { status: response.status });
          setError(message);
        }
        return;
      }
      const created: CreateNodeResponse = await response.json();
      setCreationResult(created);
      setDisplayName('');
      void fetchNodes();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setCreating(false);
    }
  }, [ creating, displayName, fetchNodes, t ]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      void handleCreate();
    },
    [ handleCreate ],
  );

  const handleCopyToken = useCallback(() => {
    if (!creationResult?.token || typeof navigator?.clipboard?.writeText !== 'function') {
      return;
    }
    void navigator.clipboard.writeText(creationResult.token);
  }, [ creationResult ]);

  if (!nodesEnabled) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('nodes.title')} subtitle={t('nodes.summary')}>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
            {t('nodes.disabled')}
          </div>
        </PageHeader>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('nodes.title')} subtitle={t('nodes.summary')}>
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300">
          <p>{t('nodes.noticeDomain')}</p>
          <p className="mt-1">{t('nodes.noticeToken')}</p>
        </div>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('nodes.connection.title')}</h2>
          <dl className="mt-4 space-y-3 text-sm text-slate-600 dark:text-slate-300">
            <div>
              <dt className="font-medium text-slate-500 dark:text-slate-400">{t('nodes.connection.domain')}</dt>
              <dd className="mt-1 break-all font-mono text-sm">{publicBaseUrl}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500 dark:text-slate-400">{t('nodes.connection.signal')}</dt>
              <dd className="mt-1 break-all font-mono text-sm">{signalEndpoint}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('nodes.create.title')}</h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{t('nodes.create.subtitle')}</p>
          <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
            <label className="block text-sm font-medium text-slate-600 dark:text-slate-300">
              {t('nodes.create.displayName')}
              <input
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('nodes.create.placeholder') ?? ''}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </label>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center justify-center rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t(creating ? 'nodes.create.creating' : 'nodes.create.action')}
            </button>
          </form>

          {creationResult && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
              <p className="font-semibold">{t('nodes.create.tokenGenerated')}</p>
              <p className="mt-1">{t('nodes.create.tokenHint')}</p>
              <dl className="mt-3 space-y-2 font-mono text-xs">
                <div>
                  <dt className="uppercase tracking-wide text-amber-700 dark:text-amber-300">{t('nodes.create.nodeId')}</dt>
                  <dd className="break-all text-amber-800 dark:text-amber-200">{creationResult.nodeId}</dd>
                </div>
                <div>
                  <dt className="uppercase tracking-wide text-amber-700 dark:text-amber-300">{t('nodes.create.token')}</dt>
                  <dd className="break-all text-amber-800 dark:text-amber-200">{creationResult.token}</dd>
                </div>
              </dl>
              {typeof navigator?.clipboard?.writeText === 'function' && (
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="mt-3 inline-flex items-center rounded-md border border-amber-300 px-3 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-200/60 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-800/40"
                >
                  {t('actions.copy')}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {!error && loading && (
        <div className="rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-sm text-slate-500 shadow-inner dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400">
          {t('nodes.loading')}
        </div>
      )}

      {!error && !loading && nodes.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
          {t('nodes.empty')}
        </div>
      )}

      {!error && !loading && nodes.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm dark:border-slate-800">
          <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-4 py-3">{t('nodes.table.node')}</th>
                <th className="px-4 py-3">{t('nodes.table.identifier')}</th>
                <th className="px-4 py-3">{t('nodes.table.endpoint')}</th>
                <th className="px-4 py-3 text-right">{t('nodes.table.pods')}</th>
                <th className="px-4 py-3 text-right">{t('nodes.table.createdAt')}</th>
                <th className="px-4 py-3 text-right">{t('nodes.table.lastSeen')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white text-sm dark:divide-slate-800 dark:bg-slate-900/50">
              {nodes.map((node) => (
                <tr key={node.nodeId}>
                  <td className="px-4 py-3 text-slate-900 dark:text-slate-100">{node.displayName ?? t('nodes.table.unnamed')}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">{node.nodeId}</td>
                  {(() => {
                    const endpointRaw = (() => {
                      const metadata = node.metadata ?? undefined;
                      const publicAddress = typeof metadata?.publicAddress === 'string' ? metadata.publicAddress.trim() : undefined;
                      if (publicAddress && publicAddress.length > 0) {
                        return publicAddress;
                      }
                      const baseUrl = typeof metadata?.baseUrl === 'string' ? metadata.baseUrl.trim() : undefined;
                      return baseUrl && baseUrl.length > 0 ? baseUrl : undefined;
                    })();
                    const endpoint = endpointRaw ?? t('nodes.table.endpointUnset');
                    const statusRaw = typeof node.metadata?.status === 'string' ? node.metadata.status.trim() : undefined;
                    const status = statusRaw && statusRaw.length > 0 ? statusRaw : undefined;
                    return (
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <span className="break-all font-mono text-xs text-slate-500 dark:text-slate-400">{endpoint}</span>
                          {status && (
                            <span className="inline-flex items-center rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-700 dark:bg-primary-500/10 dark:text-primary-200">
                              {status}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })()}
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{node.podCount}</td>
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{formatDateTime(node.createdAt)}</td>
                  <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{formatDateTime(node.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
