import { BrowserRouter, useRoutes } from 'react-router-dom';
import { dashboardRoutes } from './dashboard-routes';
import { XpodAuthProvider } from './auth/XpodAuthProvider';
import './index.css';

function DashboardRoutes() {
  return useRoutes(dashboardRoutes);
}

export function DashboardApp() {
  return (
    <XpodAuthProvider>
      <BrowserRouter basename="/dashboard">
        <DashboardRoutes />
      </BrowserRouter>
    </XpodAuthProvider>
  );
}
