import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardApp as SettingsApp } from './DashboardApp';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
