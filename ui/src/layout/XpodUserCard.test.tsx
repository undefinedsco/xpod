import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';
import { XpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';
import { XpodUserCard } from './XpodUserCard';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';

function renderCard(state: XpodSolidRuntimeValue['state'], accountLoggedIn = false) {
  const value = {
    state,
    webId: state.webId,
    podUrl: state.podUrl,
    issuer: state.issuer,
    fetch: globalThis.fetch,
    login: async () => undefined,
    logout: async () => undefined,
  } as XpodSolidRuntimeValue;

  return renderToStaticMarkup(
    <AuthContext.Provider value={{
      controls: accountLoggedIn ? { account: { logout: '/.account/logout/' } } : {},
      isInitializing: false, initError: null, idpIndex: '/.account/', isLoggedIn: accountLoggedIn,
      authenticating: false, hasOidcPending: false, refetchControls: async () => undefined,
    } satisfies AuthContextType}>
      <XpodSolidRuntimeContext.Provider value={value}>
        <XpodUserCard />
      </XpodSolidRuntimeContext.Provider>
    </AuthContext.Provider>,
  );
}

describe('XpodUserCard', () => {
  test('shows the current identity and Pod actions', () => {
    const html = renderCard({
      status: 'authenticated',
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://pod.example/alice/',
      issuer: 'https://id.example/',
    }, true);

    expect(html).toContain('aria-label="Current user"');
    expect(html).toContain('alice');
    expect(html).toContain('https://pod.example/alice/');
    expect(html).toContain('Open Pod');
    expect(html).toContain('Copy WebID');
    expect(html).toContain('Xpod account');
    expect(html).toContain('Solid identity');
    expect(html).toContain('Sign out account');
    expect(html).toContain('Disconnect WebID');
  });

  test('explains that Pod discovery is still pending', () => {
    const html = renderCard({
      status: 'authenticated',
      webId: 'https://id.example/alice/profile/card#me',
      issuer: 'https://id.example/',
    });

    expect(html).toContain('Pod discovery pending');
    expect(html).not.toContain('Open Pod');
  });

  test('shows a signed-out identity entry without operational summaries', () => {
    const html = renderCard({ status: 'anonymous', issuer: 'https://id.example/' });

    expect(html).toContain('Not signed in');
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Storage');
    expect(html).not.toContain('Bandwidth');
    expect(html).not.toContain('AI Config');
  });

  test('announces identity switching while the runtime session is loading', () => {
    const html = renderCard({ status: 'loading', issuer: 'https://id.example/' });

    expect(html).toContain('Switching Solid identity…');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('Connect a Solid identity');
  });

  test('shows an unavailable identity with a recovery action', () => {
    const html = renderCard({ status: 'error', issuer: 'https://id.example/', error: new Error('session unavailable') });

    expect(html).toContain('Identity unavailable');
    expect(html).toContain('session unavailable');
    expect(html).toContain('Try again');
  });
});
