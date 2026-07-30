import { BrowserRouter, useRoutes } from 'react-router-dom';
import { dashboardRoutes } from './dashboard-routes';
import { XpodSolidRuntimeProvider } from './solid/XpodSolidRuntimeProvider';
import './index.css';

function DashboardRoutes() {
  return useRoutes(dashboardRoutes);
}

export function DashboardApp() {
  return (
    <XpodSolidRuntimeProvider>
      <BrowserRouter basename="/dashboard">
        <DashboardRoutes />
      </BrowserRouter>
    </XpodSolidRuntimeProvider>
  );
}
