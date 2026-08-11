import { createRoot } from 'react-dom/client';
import { XpodOidcCallbackApp } from './solid/XpodOidcCallbackApp';
import { createXpodSolidRuntimeValue } from './solid/XpodSolidRuntime';
import { SettingsApp } from './SettingsApp';
import { DashboardApp } from './DashboardApp';
import type { XpodOidcCallbackSuccess } from './solid/XpodOidcCallbackApp';
import { createCallbackNavigation } from './auth-callback-navigation';
import './index.css';

// A full-page OIDC redirect creates one fresh document. Keep one Xpod runtime
// and one Inrupt Session adapter for this callback document only.
const runtime = createXpodSolidRuntimeValue();
const callbackLocation = createCallbackNavigation({
  location: window.location,
  history: window.history,
});

function renderRedirected(result: XpodOidcCallbackSuccess) {
  const destination = new URL(result.destination);
  if (destination.origin !== window.location.origin) {
    return <main role="status" aria-live="polite">Sign-in complete. Opening Xpod…</main>;
  }
  if (destination.pathname.startsWith('/settings')) {
    return <SettingsApp runtime={runtime} />;
  }
  if (destination.pathname.startsWith('/dashboard')) {
    return <DashboardApp runtime={runtime} />;
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
