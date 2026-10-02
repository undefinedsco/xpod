import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AppearancePage, WorkspacePage } from './DesktopWorkspaces';
import { XpodThemeContext } from './theme/xpod-theme-context';
import { emptyShellSnapshot } from './shell/shell-state';
import { ShellContext } from './shell/useShellState';

afterEach(cleanup);

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
