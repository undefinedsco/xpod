import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { TwoPaneLayout, useWorkspaceLayout, type TwoPaneLayoutMode } from '@undefineds.co/extension-sdk/react';
import { clsx } from 'clsx';
import { RefreshCw, Server } from 'lucide-react';
import {
  fetchServicesStatusSnapshot,
  type AdminCapability,
  type ServicesStatusSnapshot,
} from '../../api/admin';
import { serviceNavigationItems } from './services-navigation';
import { ServicesStatusContext, type ServicesStatusContextValue } from './services-status-context';
import { PaneListHeader } from './PaneListHeader';

const unsupportedCapability: AdminCapability = {
  supported: false,
  reason: 'capability_not_reported',
};

export default function ServicesPage({
  mode = 'auto',
  product = 'legacy',
}: {
  mode?: TwoPaneLayoutMode;
  product?: 'legacy' | 'dashboard' | 'settings';
}) {
  const [snapshot, setSnapshot] = useState<ServicesStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  const loadSnapshot = useCallback(async (initial = false) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(undefined);

    try {
      const nextSnapshot = await fetchServicesStatusSnapshot({ signal: controller.signal });
      if (mountedRef.current && requestIdRef.current === requestId && !controller.signal.aborted) {
        setSnapshot(nextSnapshot);
      }
    } catch (caught) {
      if (
        mountedRef.current
        && requestIdRef.current === requestId
        && !controller.signal.aborted
        && !(caught instanceof DOMException && caught.name === 'AbortError')
      ) {
        setError('Services status request failed. Please try again.');
      }
    } finally {
      if (mountedRef.current && requestIdRef.current === requestId && !controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadSnapshot(true);
    const interval = setInterval(() => void loadSnapshot(false), 10_000);

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      clearInterval(interval);
    };
  }, [loadSnapshot]);

  const contextValue = useMemo<ServicesStatusContextValue>(() => {
    const capabilities = snapshot?.adminData?.capabilities?.services;
    return {
      snapshot,
      loading,
      refreshing,
      error,
      refresh: () => void loadSnapshot(false),
      restartCapability: capabilities?.lifecycle?.restart ?? unsupportedCapability,
      configurationWriteCapability: capabilities?.configuration?.write ?? unsupportedCapability,
    };
  }, [error, loadSnapshot, loading, refreshing, snapshot]);

  return (
    <ServicesStatusContext.Provider value={contextValue}>
      <TwoPaneLayout
        mode={mode}
        listHeader={<PaneListHeader title="Services" />}
        list={<ServicesSidebar snapshot={snapshot} loading={loading && !snapshot} showSections={product === 'legacy'} />}
        mainHeader={<ServicesHeader product={product} loading={loading || refreshing} onRefresh={contextValue.refresh} />}
        main={
          <section className="min-h-full min-w-0 bg-background">
            <ServicesRoutePaneSync />
            {error ? (
              <div role="alert" className="mx-6 mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <Outlet />
          </section>
        }
        className="min-h-full"
      />
    </ServicesStatusContext.Provider>
  );
}

function ServicesRoutePaneSync() {
  const location = useLocation();
  const workspace = useWorkspaceLayout();
  const lastSyncedPathRef = useRef<string | null>(null);
  const normalizedPath = location.pathname.replace(/\/+$/, '') || '/services';

  useEffect(() => {
    if (lastSyncedPathRef.current === normalizedPath) return;
    lastSyncedPathRef.current = normalizedPath;
    if (normalizedPath === '/services') {
      workspace.openList();
      return;
    }
    workspace.openMain();
  }, [normalizedPath, workspace]);

  return null;
}

function ServicesHeader({
  product,
  loading,
  onRefresh,
}: {
  product: 'legacy' | 'dashboard' | 'settings';
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-full min-w-0 items-center justify-between gap-4 px-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">Services</div>
        <div className="truncate text-xs text-muted-foreground">Runtime health, logs, RDF indexing, and configuration</div>
      </div>
      <div className="flex items-center gap-2">
        {product !== 'legacy' ? (
          <a
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent"
            href={product === 'dashboard' ? '/settings/services' : '/dashboard/runtime'}
          >
            {product === 'dashboard' ? 'Configure' : 'View runtime'}
          </a>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw className={clsx('mr-2 h-4 w-4', loading && 'animate-spin')} aria-hidden="true" />
          Refresh
        </button>
      </div>
    </div>
  );
}

function ServicesSidebar({
  snapshot,
  loading,
  showSections,
}: {
  snapshot: ServicesStatusSnapshot | null;
  loading: boolean;
  showSections: boolean;
}) {
  const location = useLocation();
  const workspace = useWorkspaceLayout();
  const services = snapshot?.servicesData ?? [];
  const runningCount = services.filter((service) => service.status === 'running').length;
  const serviceCount = services.length;

  return (
    <aside className="flex h-full flex-col gap-4 border-r border-border bg-muted/30 p-4">
      <div className="rounded-md border border-border bg-card">
        <div className="px-4 pt-4">
          <div className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Server className="h-4 w-4" aria-hidden="true" />
            Service health
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {loading ? 'Loading runtime status' : `${runningCount}/${serviceCount || 0} services running`}
          </div>
        </div>
        <div className="space-y-2 px-4 pb-4 pt-3">
          {serviceCount > 0 ? services.map((service) => (
            <div key={service.name} className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium text-foreground">{service.name}</span>
              <span className={clsx(
                'rounded-md px-2 py-0.5 text-xs font-medium',
                service.status === 'running' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}>
                {service.status}
              </span>
            </div>
          )) : (
            <div className="text-sm text-muted-foreground">{loading ? 'Waiting for status' : 'No service status reported'}</div>
          )}
        </div>
      </div>

      {showSections ? <nav aria-label="Services sections" className="space-y-1">
        {serviceNavigationItems.map((item) => {
          const Icon = item.icon;
          const isRuntimeIndex = item.id === 'runtime' && location.pathname === '/services';
          return (
            <NavLink
              key={item.id}
              to={item.path}
              onClick={() => workspace.openMain()}
              className={({ isActive }) => clsx(
                'flex gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                isActive || isRuntimeIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block font-medium">{item.label}</span>
                <span className="mt-0.5 block text-xs opacity-80">{item.description}</span>
              </span>
            </NavLink>
          );
        })}
      </nav> : null}
    </aside>
  );
}
