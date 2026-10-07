// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { XpodProductEntry } from './XpodProductEntry';
const loaded = vi.hoisted(() => ({ shell: vi.fn(), callback: vi.fn() }));
vi.mock('./XpodShellApp', () => { loaded.shell(); return { XpodShellApp: () => <div>Desktop workspace</div> }; });
vi.mock('./DesktopOidcCallback', () => { loaded.callback(); return { default: () => <div>Desktop callback</div> }; });
vi.mock('./pages/WebDesktopEntry', () => ({ default: () => <h1>在桌面 Xpod 中管理</h1> }));
vi.mock('./pages/settings/PodDeletionAuthorizationPanel', () => ({ PodDeletionAuthorizationPanel: () => <h1>授权删除单个 Pod</h1> }));
beforeEach(() => { vi.stubGlobal('xpodDesktop', undefined); history.replaceState({}, '', '/settings/pod'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test.each(['/settings/pod', '/status/overview', '/ai-connections', '/ai-config/model-assignments'])('Web route %s never loads desktop workspace', async path => {
  history.replaceState({}, '', path); render(<XpodProductEntry />);
  await screen.findByRole('heading', { name: '在桌面 Xpod 中管理' });
  expect(loaded.shell).not.toHaveBeenCalled();
});
test('browser callback does not initialise the desktop Solid session', async () => {
  render(<XpodProductEntry callback />);
  await screen.findByRole('heading', { name: '在桌面 Xpod 中管理' });
  expect(loaded.callback).not.toHaveBeenCalled();
});
test('device deletion authorization stays a single lightweight task', async () => {
  history.replaceState({}, '', '/settings/pod?deletionAuthorization=opaque&podName=alice');
  render(<XpodProductEntry />); await screen.findByRole('heading', { name: '授权删除单个 Pod' });
  expect(loaded.shell).not.toHaveBeenCalled();
});
test('the actual desktop bridge keeps the workspace', async () => {
  vi.stubGlobal('xpodDesktop', {}); render(<XpodProductEntry />);
  await screen.findByText('Desktop workspace');
});
test('the actual desktop bridge keeps callback processing', async () => {
  vi.stubGlobal('xpodDesktop', {}); render(<XpodProductEntry callback />);
  await screen.findByText('Desktop callback');
});
