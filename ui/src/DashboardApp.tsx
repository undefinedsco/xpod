import { BrowserRouter, useRoutes } from 'react-router-dom';
import { dashboardRoutes } from './dashboard-routes';
import { XpodAuthProvider } from './auth/XpodAuthProvider';
import type { XpodSolidRuntimeCore } from './solid/XpodSolidRuntime';
import './index.css';

function DashboardRoutes() {
  return useRoutes(dashboardRoutes);
}

export function DashboardApp({ runtime }: { runtime?: XpodSolidRuntimeCore } = {}) {
  return (
    <XpodAuthProvider runtime={runtime}>
      <BrowserRouter basename="/dashboard">
        <DashboardRoutes />
      </BrowserRouter>
    </XpodAuthProvider>
  );
}
