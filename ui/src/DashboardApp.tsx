import { BrowserRouter, useRoutes } from 'react-router-dom';
import { dashboardRoutes } from './dashboard-routes';
import './index.css';

function DashboardRoutes() {
  return useRoutes(dashboardRoutes);
}

export function DashboardApp() {
  return (
    <BrowserRouter basename="/dashboard">
      <DashboardRoutes />
    </BrowserRouter>
  );
}
