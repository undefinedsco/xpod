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
  test('keeps the shared Linx-sized rail for Settings', () => {
    const html = renderProduct('settings', settingsNavigationItems, '/dashboard/overview');

    expect(html).toContain('data-app-layout="workspace"');
    expect(html).toContain('aria-label="Models"');
    expect(html).toContain('aria-label="Pod"');
    expect(html).toContain('aria-label="Network"');
    expect(html).toContain('aria-label="Services"');
    expect(html).toContain('data-testid="xpod-user-card-trigger"');
    expect(html).not.toContain('>X</a>');
  });

  test('renders Dashboard observability navigation without Settings items', () => {
    const html = renderProduct('dashboard', dashboardNavigationItems, '/settings/models');

    for (const label of ['Overview', 'Runtime', 'Logs', 'RDF', 'Network', 'Usage']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('aria-label="Models"');
    expect(html).not.toContain('aria-label="Pod"');
    expect(html).toContain('data-testid="xpod-user-card-trigger"');
    expect(html).not.toContain('>X</a>');
  });
});
