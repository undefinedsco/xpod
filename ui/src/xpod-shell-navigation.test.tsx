// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { BrowserRouter, useRoutes } from 'react-router-dom';
import { xpodShellRoutes } from './xpod-shell-routes';

vi.mock('./solid/WebIdAuthBoundary', () => ({ WebIdAuthBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('./layout/XpodUserCard', () => ({ XpodUserCard: () => null }));
vi.mock('./shell/ShellHeaderControls', () => ({ ShellHeaderControls: () => null, ShellInboxContent: () => null, ShellNotificationsContent: () => null }));
vi.mock('./pages/tasks/TasksPage', () => ({ default: () => <button>添加待办</button> }));
vi.mock('./pages/settings/ModelsPage', () => ({ default: () => <button>新建 Xpod 密钥</button> }));
function Routes() { return useRoutes(xpodShellRoutes); }
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });
test('actual rail and route tree replace Tasks with the AI applet after SPA navigation', async () => {
  window.history.replaceState(null, '', '/tasks');
  render(<BrowserRouter><Routes /></BrowserRouter>);
  await screen.findByRole('button', { name: '添加待办' });
  fireEvent.click(screen.getByRole('link', { name: 'AI 连接' }));
  await waitFor(() => expect(window.location.pathname).toBe('/ai-connections'));
  await screen.findByRole('button', { name: '新建 Xpod 密钥' });
  expect(screen.queryByRole('button', { name: '添加待办' })).toBeNull();
});
