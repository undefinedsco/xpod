import { BrowserRouter, useRoutes } from 'react-router-dom';
import { settingsRoutes } from './settings-routes';
import { XpodSolidRuntimeProvider } from './solid/XpodSolidRuntimeProvider';
import './index.css';

function SettingsRoutes() {
  return useRoutes(settingsRoutes);
}

export function SettingsApp() {
  return (
    <XpodSolidRuntimeProvider>
      <BrowserRouter basename="/settings">
        <SettingsRoutes />
      </BrowserRouter>
    </XpodSolidRuntimeProvider>
  );
}
