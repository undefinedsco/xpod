import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, NavLink } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { aiConfigNavigationItems } from './ai-config-navigation';
import { statusNavigationItems } from './status-navigation';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function installDom(pathname: string) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `https://xpod.test${pathname}`,
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
}

async function renderNavigation(basename: string, pathname: string, items: readonly { id: string; label: string; path: string; end?: boolean }[]) {
  installDom(pathname);
  const container = document.getElementById('root');
  if (!container) throw new Error('missing root');
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <BrowserRouter basename={basename}>
        <nav>
          {items.map((item) => (
            <NavLink key={item.id} to={item.path} end={item.end}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </BrowserRouter>,
    );
  });

  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe('surface navigation under product basenames', () => {
  test('status links stay inside the /status surface without duplicating the basename', async () => {
    const { container, root } = await renderNavigation('/status', '/status/index/vector', statusNavigationItems);

    const active = [...container.querySelectorAll('a[aria-current="page"]')];
    expect(active.map((link) => link.textContent)).toEqual(['Vector']);
    expect(active[0]?.getAttribute('href')).toBe('/status/index/vector');
    expect(active[0]?.getAttribute('href')).not.toContain('/status/status/');
    expect(statusNavigationItems.find((item) => item.id === 'vector')?.href).toBe('/status/index/vector');

    await unmount(root);
  });

  test('AI Config links stay inside the /ai-config surface without duplicating the basename', async () => {
    const { container, root } = await renderNavigation('/ai-config', '/ai-config/search-indexing', aiConfigNavigationItems);

    const active = [...container.querySelectorAll('a[aria-current="page"]')];
    expect(active.map((link) => link.textContent)).toEqual(['Search & Indexing']);
    expect(active[0]?.getAttribute('href')).toBe('/ai-config/search-indexing');
    expect(active[0]?.getAttribute('href')).not.toContain('/ai-config/ai-config/');
    expect(aiConfigNavigationItems.find((item) => item.id === 'search-indexing')?.href).toBe('/ai-config/search-indexing');

    await unmount(root);
  });
});
