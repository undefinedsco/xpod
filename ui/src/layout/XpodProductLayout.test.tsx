import { describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextType } from '../context/AuthContextValue';
import { XpodProductLayout } from './XpodProductLayout';
import { globalNavigationItems } from './global-navigation';

const authenticatedAccount: AuthContextType = {
  controls: {},
  isInitializing: false,
  initError: null,
  idpIndex: '/.account/',
  isLoggedIn: true,
  authenticating: false,
  hasOidcPending: false,
  refetchControls: vi.fn(async () => undefined),
  retry: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  accountState: { status: 'authenticated' },
  identity: { displayName: 'Alice', username: 'alice' },
};

function renderProduct(product: 'dashboard' | 'settings') {
  return renderToStaticMarkup(
    <AuthContext.Provider value={authenticatedAccount}>
      <MemoryRouter initialEntries={[product === 'dashboard' ? '/overview' : '/models']}>
        <XpodProductLayout product={product} />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('XpodProductLayout', () => {
  test('keeps global navigation order stable', () => {
    expect(globalNavigationItems.filter((item) => item.placement === 'primary').map((item) => item.id))
      .toEqual(['ai-connections', 'ai-config']);
    expect(globalNavigationItems.filter((item) => item.placement === 'bottom').map((item) => item.id))
      .toEqual(['network', 'status', 'settings']);
  });

  test.each(['settings', 'dashboard'] as const)('renders the native Account avatar in %s', (product) => {
    const html = renderProduct(product);
    expect(html).toContain('data-app-layout="workspace"');
    expect(html).toContain('aria-label="Open account menu for Alice"');
    expect(html).toContain('href="/ai-connections"');
    expect(html).toContain('aria-label="Network"');
  });
});
