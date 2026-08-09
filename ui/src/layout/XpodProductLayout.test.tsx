import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { XpodProductLayout } from './XpodProductLayout';
import { dashboardNavigationItems } from './dashboard-navigation';
import { settingsNavigationItems } from './settings-navigation';

function renderProduct(
  product: 'dashboard' | 'settings',
  items: typeof dashboardNavigationItems | typeof settingsNavigationItems,
  switchHref: '/dashboard/overview' | '/settings/models',
) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[product === 'dashboard' ? '/overview' : '/models']}>
      <XpodProductLayout product={product} items={items} switchHref={switchHref} />
    </MemoryRouter>,
  );
}

describe('XpodProductLayout', () => {
  test('renders the same global rail in Settings', () => {
    const html = renderProduct('settings', settingsNavigationItems, '/dashboard/overview');

    expect(html).toContain('data-app-layout="workspace"');
    expect(globalRailLabels(html)).toEqual(['Status', 'Network', 'AI Connections', 'AI Config', 'Settings']);
    expect(html).toContain('href="/ai-connections"');
    expect(html).toContain('href="/ai-config/model-assignments"');
    expect(html).toContain('href="/settings/pod"');
    expect(html).not.toContain('aria-label="Open Dashboard"');
  });

  test('renders the same global rail in Dashboard', () => {
    const html = renderProduct('dashboard', dashboardNavigationItems, '/settings/models');

    expect(globalRailLabels(html)).toEqual(['Status', 'Network', 'AI Connections', 'AI Config', 'Settings']);
    expect(html).toContain('href="/status/overview"');
    expect(html).toContain('aria-label="Network"');
    expect(html).not.toContain('aria-label="Open Settings"');
  });

  test('uses a bottom navigation on narrow screens and a left rail from sm upward', () => {
    const html = renderProduct('dashboard', dashboardNavigationItems, '/settings/models');

    expect(html).toContain('flex-row items-center px-2');
    expect(html).toContain('sm:flex-col sm:px-0');
    expect(html).toContain('flex flex-row items-center gap-3 sm:flex-col sm:gap-4');
    expect(html).toContain('hidden shrink-0 flex-col items-center pt-12 sm:flex');
    expect(html).toContain('bottom-12 right-0');
    expect(html).toContain('sm:bottom-0 sm:left-12');
  });
});

function globalRailLabels(html: string): string[] {
  return Array.from(html.matchAll(/aria-label="(Status|Network|AI Connections|AI Config|Settings)"/g))
    .map((match) => match[1]);
}
