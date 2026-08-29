import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { XpodAuthContext, type XpodAuthValue } from '../auth/useXpodAuth';
import { XpodProductLayout } from './XpodProductLayout';
import { globalNavigationItems } from './global-navigation';

function renderProduct(product: 'dashboard' | 'settings') {
  return renderToStaticMarkup(
    <XpodAuthContext.Provider value={authenticatedAuth}>
      <MemoryRouter initialEntries={[product === 'dashboard' ? '/overview' : '/models']}>
        <XpodProductLayout product={product} />
      </MemoryRouter>
    </XpodAuthContext.Provider>,
  );
}

const authenticatedAuth = {
  account: {
    accountState: { status: 'authenticated' },
    isLoggedIn: true,
    identity: { displayName: 'Alice', username: 'alice' },
  },
  logoutState: { status: 'idle' },
} as XpodAuthValue;

describe('XpodProductLayout', () => {
  test('keeps Network with the account and host utilities at the bottom of the rail', () => {
    expect(globalNavigationItems.filter((item) => item.placement === 'primary').map((item) => item.id)).toEqual([
      'ai-connections', 'ai-config',
    ]);
    expect(globalNavigationItems.filter((item) => item.placement === 'bottom').map((item) => item.id)).toEqual([
      'network', 'status', 'settings',
    ]);
  });

  test('renders the same global rail in Settings', () => {
    const html = renderProduct('settings');

    expect(html).toContain('data-app-layout="workspace"');
    expect(globalRailLabels(html)).toEqual(['AI Connections', 'AI Config', 'Network', 'Status', 'Settings']);
    expect(html).toContain('href="/ai-connections"');
    expect(html).toContain('href="/ai-config/model-assignments"');
    expect(html).toContain('href="/settings/pod"');
    expect(html).toContain('data-testid="xpod-user-card-trigger"');
    expect(html).not.toContain('>X</a>');
  });

  test('renders the same global rail in Dashboard', () => {
    const html = renderProduct('dashboard');

    expect(globalRailLabels(html)).toEqual(['AI Connections', 'AI Config', 'Network', 'Status', 'Settings']);
    expect(html).toContain('href="/status/overview"');
    expect(html).toContain('aria-label="Network"');
    expect(html).toContain('data-testid="xpod-user-card-trigger"');
    expect(html).not.toContain('>X</a>');
  });

  test('uses the account avatar as the top-left rail identity', () => {
    const html = renderProduct('dashboard');

    expect(html).not.toContain('aria-label="Xpod Home"');
    expect(html).toContain('aria-label="Open account menu for Alice"');
    expect(html.indexOf('aria-label="Open account menu for Alice"')).toBeLessThan(html.indexOf('aria-label="Status"'));
  });

  test('uses a bottom navigation on narrow screens and a left rail from sm upward', () => {
    const html = renderProduct('dashboard');

    expect(html).toContain('flex-row items-center px-2');
    expect(html).toContain('sm:flex-col sm:px-0 sm:py-4');
    expect(html).toContain('flex flex-row items-center gap-3 sm:flex-col sm:gap-4');
    expect(html).not.toContain('justify-center sm:flex-col sm:py-4');
    expect(html).toContain('data-testid="xpod-user-card-trigger"');
  });
});

function globalRailLabels(html: string): string[] {
  return Array.from(html.matchAll(/aria-label="(Status|Network|AI Connections|AI Config|Settings)"/g))
    .map((match) => match[1]);
}
