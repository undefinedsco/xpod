import { BrowserRouter, useRoutes } from 'react-router-dom';
import { settingsRoutes } from './settings-routes';
import type { XpodSolidRuntimeCore } from './solid/XpodSolidRuntime';
import { XpodAuthProvider } from './auth/XpodAuthProvider';
import './index.css';

function SettingsRoutes() {
  return useRoutes(settingsRoutes);
}

export function SettingsApp({ runtime }: { runtime?: XpodSolidRuntimeCore } = {}) {
  return (
    <XpodAuthProvider runtime={runtime}>
      <BrowserRouter basename="/settings">
        <SettingsRoutes />
      </BrowserRouter>
    </XpodAuthProvider>
  );
}
