/**
 * Dashboard 入口文件
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { XpodProductEntry } from './XpodProductEntry';
import './styles/global.css';
import { XpodThemeProvider } from './theme/XpodThemeProvider';
import { initializeXpodTheme } from './theme/xpod-theme-state';

initializeXpodTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <XpodThemeProvider>
      <XpodProductEntry />
    </XpodThemeProvider>
  </StrictMode>
);
