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
  test('keeps the applets and host controls in spec order', () => {
    // §2.1: tasks, connections, Pod, then host controls.
    expect(globalNavigationItems.map((item) => item.id)).toEqual(['tasks', 'ai', 'pod', 'device', 'settings']);
  });

  test.each(['settings', 'dashboard'] as const)('does not treat Account identity as WebID login in %s', (product) => {
    const html = renderProduct(product);
    expect(html).toContain('data-app-layout="workspace"');
    expect(html).toContain('aria-label="登录"');
    expect(html).toContain('href="/ai-connections"');
    expect(html).toContain('aria-label="这台设备"');
    expect(html).not.toContain('aria-label="Status"');
  });
});
