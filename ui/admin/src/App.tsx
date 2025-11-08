import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { PodsPage } from './pages/PodsPage';
import { QuotaPage } from './pages/QuotaPage';
import { SecurityPage } from './pages/SecurityPage';
import { LogsPage } from './pages/LogsPage';
import { NodesPage } from './pages/NodesPage';
import {
  DashboardIcon,
  UsersIcon,
  CubeIcon,
  SparklesIcon,
  ShieldIcon,
  ClipboardIcon,
  ServerIcon,
} from './components/icons';
import type { NavigationEntry } from './types/ui';
import { AdminConfigContext, type AdminConfig } from './context/AdminConfigContext';

const BASE_NAVIGATION: NavigationEntry[] = [
  { path: '/', translationKey: 'navigation.dashboard', icon: <DashboardIcon className="h-4 w-4" /> },
  { path: '/accounts', translationKey: 'navigation.accounts', icon: <UsersIcon className="h-4 w-4" /> },
  { path: '/pods', translationKey: 'navigation.pods', icon: <CubeIcon className="h-4 w-4" /> },
  { path: '/quota', translationKey: 'navigation.quota', icon: <SparklesIcon className="h-4 w-4" />, clusterOnly: true },
  { path: '/security', translationKey: 'navigation.security', icon: <ShieldIcon className="h-4 w-4" /> },
  { path: '/logs', translationKey: 'navigation.logs', icon: <ClipboardIcon className="h-4 w-4" /> },
];

export default function App(): JSX.Element {
  const routerBase = (import.meta.env.BASE_URL ?? '/admin/').replace(/\/$/, '');
  const [ config, setConfig ] = useState<AdminConfig>({
    edition: 'cluster',
    features: { quota: true, nodes: false },
    baseUrl: undefined,
    signalEndpoint: undefined,
  });

  useEffect(() => {
    let cancelled = false;
    async function bootstrap(): Promise<void> {
      try {
        const response = await fetch('/admin/config', { credentials: 'include' });
        if (!response.ok) {
          return;
        }
        const payload = await response.json();
        if (!cancelled) {
          const edition = payload.edition === 'local' ? 'local' : 'cluster';
          const quota = payload.features?.quota === true;
          const nodes = payload.features?.nodes === true;
          const baseUrl = typeof payload.baseUrl === 'string' && payload.baseUrl.trim().length > 0
            ? payload.baseUrl.trim()
            : undefined;
          const signalEndpoint = typeof payload.signalEndpoint === 'string' && payload.signalEndpoint.trim().length > 0
            ? payload.signalEndpoint.trim()
            : undefined;
          setConfig({ edition, features: { quota, nodes }, baseUrl, signalEndpoint });
        }
      } catch {
        // Silently fall back to defaults; configuration endpoint will be wired in later steps.
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const navigation: NavigationEntry[] = [
    ...BASE_NAVIGATION.slice(0, 3),
    ...(config.features.nodes ? [ { path: '/nodes', translationKey: 'navigation.nodes', icon: <ServerIcon className="h-4 w-4" /> } ] : []),
    ...BASE_NAVIGATION.slice(3),
  ];

  return (
    <BrowserRouter basename={routerBase}>
      <AdminConfigContext.Provider value={config}>
        <AppShell routes={navigation} edition={config.edition}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/pods" element={<PodsPage />} />
            {config.features.nodes && <Route path="/nodes" element={<NodesPage />} />}
            <Route path="/quota" element={<QuotaPage />} />
            <Route path="/security" element={<SecurityPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </AdminConfigContext.Provider>
    </BrowserRouter>
  );
}
