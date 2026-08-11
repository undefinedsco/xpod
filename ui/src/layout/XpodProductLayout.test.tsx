import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { XpodProductLayout } from './XpodProductLayout';

function renderProduct(product: 'dashboard' | 'settings') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[product === 'dashboard' ? '/overview' : '/models']}>
      <XpodProductLayout product={product} />
    </MemoryRouter>,
  );
}

describe('XpodProductLayout', () => {
  test('renders the same global rail in Settings', () => {
    const html = renderProduct('settings');

    expect(html).toContain('data-app-layout="workspace"');
    expect(globalRailLabels(html)).toEqual(['Status', 'Network', 'AI Connections', 'AI Config', 'Settings']);
    expect(html).toContain('href="/ai-connections"');
    expect(html).toContain('href="/ai-config/model-assignments"');
    expect(html).toContain('href="/settings/pod"');
    expect(html).not.toContain('aria-label="Open Dashboard"');
  });

  test('renders the same global rail in Dashboard', () => {
    const html = renderProduct('dashboard');

    expect(globalRailLabels(html)).toEqual(['Status', 'Network', 'AI Connections', 'AI Config', 'Settings']);
    expect(html).toContain('href="/status/overview"');
    expect(html).toContain('aria-label="Network"');
    expect(html).not.toContain('aria-label="Open Settings"');
  });

  test('uses the account avatar as the top-left rail identity', () => {
    const html = renderProduct('dashboard');

    expect(html).not.toContain('aria-label="Xpod Home"');
    expect(html).toContain('aria-label="Current user"');
    expect(html.indexOf('aria-label="Current user"')).toBeLessThan(html.indexOf('aria-label="Status"'));
  });

  test('uses a bottom navigation on narrow screens and a left rail from sm upward', () => {
    const html = renderProduct('dashboard');

    expect(html).toContain('flex-row items-center px-2');
    expect(html).toContain('sm:flex-col sm:px-0 sm:py-4');
    expect(html).toContain('flex flex-row items-center gap-3 sm:flex-col sm:gap-4');
    expect(html).not.toContain('justify-center sm:flex-col sm:py-4');
    expect(html).toContain('bottom-12 left-0');
    expect(html).toContain('sm:left-12 sm:top-0');
  });
});

function globalRailLabels(html: string): string[] {
  return Array.from(html.matchAll(/aria-label="(Status|Network|AI Connections|AI Config|Settings)"/g))
    .map((match) => match[1]);
}
