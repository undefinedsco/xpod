import { describe, expect, test } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SystemSettingsPage from './SystemSettingsPage';

describe('SystemSettingsPage', () => {
  test('gives each settings link a stable accessible name', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/settings/pod']}>
        <Routes>
          <Route path="/settings" element={<SystemSettingsPage />}>
            <Route path="pod" element={<div>Pod details</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Pod"');
    expect(html).toContain('aria-label="Identity &amp; Access"');
  });
});
