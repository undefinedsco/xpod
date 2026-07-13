/**
 * Dashboard App - runtime console entry
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout, LogsPage, RdfPage, SettingsPage, StatusPage } from './pages/admin';
import './index.css';

export function DashboardApp() {
  return (
    <BrowserRouter basename="/dashboard">
      <Routes>
        <Route element={<AdminLayout />}>
          <Route index element={<Navigate to="/status" replace />} />
          <Route path="status" element={<StatusPage />} />
          <Route path="rdf" element={<RdfPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/status" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
