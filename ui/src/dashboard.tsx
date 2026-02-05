/**
 * Dashboard 入口文件
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardApp } from './DashboardApp';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>
);
