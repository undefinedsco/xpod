import { createRoot } from 'react-dom/client';
import { XpodOidcCallbackApp } from './solid/XpodOidcCallbackApp';
import { createXpodSolidRuntimeValue } from './solid/XpodSolidRuntime';
import { XpodShellApp } from './XpodShellApp';
import type { XpodOidcCallbackSuccess } from './solid/XpodOidcCallbackApp';
import {
  createCallbackNavigation,
  resolveCallbackProductDestination,
} from './auth-callback-navigation';
import './styles/global.css';
import { XpodThemeProvider } from './theme/XpodThemeProvider';
import { initializeXpodTheme } from './theme/xpod-theme-state';

initializeXpodTheme();

// A full-page OIDC redirect creates one fresh document. Keep one Xpod runtime
// and one Inrupt Session adapter for this callback document only.
const runtime = createXpodSolidRuntimeValue();
const callbackLocation = createCallbackNavigation({
  location: window.location,
  history: window.history,
});

function renderRedirected(result: XpodOidcCallbackSuccess) {
  const destination = resolveCallbackProductDestination(result.destination, window.location.origin);
  if (!destination) {
    return <main role="status" aria-live="polite">Sign-in complete. Opening Xpod…</main>;
  }

  const currentTarget = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentTarget !== destination.target) {
    window.history.replaceState({}, '', destination.target);
  }

  return (
    <XpodShellApp
      key={destination.target}
      runtime={runtime}
      initialPathname={destination.pathname}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <XpodThemeProvider>
    <XpodOidcCallbackApp
      runtime={runtime}
      location={callbackLocation}
      renderRedirected={renderRedirected}
    />
  </XpodThemeProvider>,
);
