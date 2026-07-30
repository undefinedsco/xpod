import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsNavLinks, XpodSettingsLayout } from './XpodSettingsLayout';
import {
  clearSettingsSearchOnEscape,
  filterSettingsNavigationItems,
  legacyDashboardRedirects,
  settingsNavigationItems,
  submitSettingsSearch,
} from './settings-navigation';

function renderLayout(path = '/models') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<XpodSettingsLayout />}>
          <Route path="/models" element={<section>Models workspace</section>} />
          <Route path="/services" element={<section>Services workspace</section>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('settings navigation metadata', () => {
  test('declares the four host navigation sections in order', () => {
    expect(settingsNavigationItems.map((item) => [item.id, item.label, item.path])).toEqual([
      ['models', 'Models', '/models'],
      ['pod', 'Pod', '/pod'],
      ['network', 'Network', '/network'],
      ['services', 'Services', '/services'],
    ]);
  });

  test('maps legacy admin routes to the new services area', () => {
    expect(legacyDashboardRedirects).toEqual({
      status: '/services',
      logs: '/services/logs',
      rdf: '/services/rdf',
      settings: '/services/runtime',
    });
  });
});

describe('XpodSettingsLayout', () => {
  test('renders SDK host shell navigation, host header search, and one main landmark', () => {
    const html = renderLayout('/models');

    expect(html).toContain('data-app-layout="workspace"');
    expect(html).toContain('Models');
    expect(html).toContain('Pod');
    expect(html).toContain('Network');
    expect(html).toContain('Services');
    expect(html).toContain('aria-label="Search settings"');
    expect(html).toContain('Models workspace');
    expect((html.match(/<main/g) ?? []).length).toBe(1);
  });

  test('marks the active navigation link for assistive technology', () => {
    const html = renderLayout('/services');

    expect(html).toContain('href="/services"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Services workspace');
  });

  test('filters settings navigation by label and description keywords', () => {
    expect(filterSettingsNavigationItems('provider').map((item) => item.label)).toEqual(['Models']);
    expect(filterSettingsNavigationItems('storage').map((item) => item.label)).toEqual(['Pod']);
    expect(filterSettingsNavigationItems('dns').map((item) => item.label)).toEqual(['Network']);
    expect(filterSettingsNavigationItems('rdf').map((item) => item.label)).toEqual(['Services']);
  });

  test('shows an accessible empty result when no settings navigation item matches', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/models']}>
        <SettingsNavLinks items={filterSettingsNavigationItems('not-a-setting')} query="not-a-setting" />
      </MemoryRouter>,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('No settings sections match');
  });

  test('prevents submit reload and navigates to the first matching settings section on Enter', () => {
    const navigatedPaths: string[] = [];
    let submitPrevented = false;

    submitSettingsSearch(
      'provider',
      { preventDefault: () => { submitPrevented = true; } },
      (path) => navigatedPaths.push(path),
    );

    expect(submitPrevented).toBe(true);
    expect(navigatedPaths).toEqual(['/models']);
  });

  test('does not navigate when submitting an unmatched query', () => {
    const navigatedPaths: string[] = [];
    let submitPrevented = false;

    submitSettingsSearch(
      'not-a-setting',
      { preventDefault: () => { submitPrevented = true; } },
      (path) => navigatedPaths.push(path),
    );

    expect(submitPrevented).toBe(true);
    expect(navigatedPaths).toEqual([]);
  });

  test('clears search results with Escape', () => {
    let query = 'provider';
    let prevented = false;

    clearSettingsSearchOnEscape(
      { key: 'Escape', preventDefault: () => { prevented = true; } },
      () => { query = ''; },
    );

    expect(prevented).toBe(true);
    expect(query).toBe('');
  });

  test('keeps search query when a non-Escape key is pressed', () => {
    let query = 'provider';
    let prevented = false;

    clearSettingsSearchOnEscape(
      { key: 'Enter', preventDefault: () => { prevented = true; } },
      () => { query = ''; },
    );

    expect(prevented).toBe(false);
    expect(query).toBe('provider');
  });
});
