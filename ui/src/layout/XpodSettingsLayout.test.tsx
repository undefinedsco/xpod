import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { XpodSettingsLayout } from './XpodSettingsLayout';
import { legacyDashboardRedirects, settingsNavigationItems } from './settings-navigation';

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
});
