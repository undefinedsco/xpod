import { createRoot } from 'react-dom/client';
import { XpodOidcCallbackApp } from './solid/XpodOidcCallbackApp';
import { createXpodSolidRuntimeValue } from './solid/XpodSolidRuntime';
import { SettingsApp } from './SettingsApp';
import { DashboardApp } from './DashboardApp';
import type { XpodOidcCallbackSuccess } from './solid/XpodOidcCallbackApp';
import {
  callbackProductAppForDestination,
  createCallbackNavigation,
} from './auth-callback-navigation';
import './index.css';

// A full-page OIDC redirect creates one fresh document. Keep one Xpod runtime
// and one Inrupt Session adapter for this callback document only.
const runtime = createXpodSolidRuntimeValue();
const callbackLocation = createCallbackNavigation({
  location: window.location,
  history: window.history,
});

function renderRedirected(result: XpodOidcCallbackSuccess) {
  const productApp = callbackProductAppForDestination(result.destination, window.location.origin);
  if (productApp === 'dashboard') {
    return <DashboardApp runtime={runtime} />;
  }
  if (productApp === 'settings') {
    return <SettingsApp runtime={runtime} />;
  }
  return <main role="status" aria-live="polite">Sign-in complete. Opening Xpod…</main>;
}

createRoot(document.getElementById('root')!).render(
  <XpodOidcCallbackApp
    runtime={runtime}
    location={callbackLocation}
    renderRedirected={renderRedirected}
  />,
);
