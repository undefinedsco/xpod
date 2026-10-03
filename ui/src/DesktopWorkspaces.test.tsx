import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkspaceDrawerContext } from '@undefineds.co/extension-sdk/react';
import { AppearancePage, SubjectWorkspace, WorkspacePage } from './DesktopWorkspaces';
import { XpodThemeContext } from './theme/xpod-theme-context';
import { emptyShellSnapshot } from './shell/shell-state';
import { ShellContext } from './shell/useShellState';

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function installNarrowViewport() {
  window.matchMedia = ((query: string) => ({
    matches: /max-width/u.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
}

function ControlledDrawerHost({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return <WorkspaceDrawerContext.Provider value={{ open, onClose: () => { setOpen(false); onClose(); } }}>
    <div data-testid="host-drawer" data-drawer-open={String(open)}>{children}</div>
  </WorkspaceDrawerContext.Provider>;
}

const shell = {
  snapshot: emptyShellSnapshot(),
  loading: false,
  error: undefined,
  refresh: vi.fn(),
  markAllRead: vi.fn(),
  decide: vi.fn(async () => undefined),
  resumeFailures: [],
  retryResume: vi.fn(async () => undefined),
};

it('gives a shell page one 48px main header over a scrollable, padded body', () => {
  const { container } = render(
    <MemoryRouter>
      <ShellContext.Provider value={shell}>
        <WorkspacePage title="收件箱"><p>收件箱内容</p></WorkspacePage>
      </ShellContext.Provider>
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1, name: '收件箱' })).toBeTruthy();
  const header = container.querySelector('[data-workspace-main-header]');
  expect(header?.className).toContain('h-12');
  expect(container.querySelector('[data-testid="workspace-list-pane"]')?.hasAttribute('hidden')).toBe(true);
  const main = container.querySelector('[data-testid="workspace-main-pane"]');
  expect(main?.textContent).toContain('收件箱内容');
  expect(main?.querySelector('.p-6')).toBeTruthy();
});

it('passes the native appearance selection to the host theme preference', () => {
  const setPreference = vi.fn();
  render(<XpodThemeContext.Provider value={{ preference: 'system', resolvedTheme: 'light', setPreference }}><AppearancePage /></XpodThemeContext.Provider>);
  fireEvent.change(screen.getByRole('combobox', { name: '主题' }), { target: { value: 'dark' } });
  expect(setPreference).toHaveBeenCalledWith('dark');
});

it.each([
  { subject: 'device', route: '/device/network', page: 'network', label: '网络访问', content: '网络访问内容' },
  { subject: 'pod', route: '/pod/models', page: 'models', label: '模型设置', content: '模型设置内容' },
  { subject: 'settings', route: '/settings/appearance', page: 'appearance', label: '外观', content: '外观内容' },
] as const)('closes the host drawer when the current $subject link is selected without a route change', ({ subject, route, page, label, content }) => {
  installNarrowViewport();
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={[route]}>
      <ShellContext.Provider value={shell}>
        <ControlledDrawerHost onClose={onClose}>
          <Routes>
            <Route path={`/${subject}`} element={<SubjectWorkspace subject={subject} />}>
              <Route path={page} element={<div>{content}</div>} />
            </Route>
          </Routes>
        </ControlledDrawerHost>
      </ShellContext.Provider>
    </MemoryRouter>,
  );
  const listPane = screen.getByTestId('workspace-list-pane');
  const mainPane = screen.getByTestId('workspace-main-pane');
  expect(listPane.hidden).toBe(false);
  expect(mainPane.hasAttribute('inert')).toBe(true);
  const link = screen.getByRole('link', { name: label, exact: true });
  expect(link.getAttribute('aria-current')).toBe('page');
  fireEvent.click(link);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('host-drawer').getAttribute('data-drawer-open')).toBe('false');
  expect(listPane.hidden).toBe(true);
  expect(mainPane.hasAttribute('inert')).toBe(false);
  expect(screen.getByText(content)).toBeTruthy();
});
