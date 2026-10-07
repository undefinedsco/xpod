// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { TwoPaneLayout } from '@undefineds.co/extension-sdk/react';
import { XpodProductLayout } from './XpodProductLayout';

vi.mock('./XpodUserCard', () => ({ XpodUserCard: () => <a href="/tasks">登录</a> }));
vi.mock('../shell/useShellState', () => ({ useOptionalShellState: () => ({ snapshot: { attention: [{ kind: 'network' }] } }) }));
const originalWidth = window.innerWidth;
beforeEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }); });
afterEach(() => { cleanup(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth }); });

test('keeps local controls accessible and opens the applet list with the rail', () => {
  render(<MemoryRouter initialEntries={['/device/network']}><Routes>
    <Route element={<XpodProductLayout product="dashboard" />}>
      <Route path="/device/network" element={<TwoPaneLayout mode="stack" listHeader="搜索" list={<button>网络访问</button>} mainHeader={<><h1>网络访问</h1><button>通知</button><button>收件箱</button></>} main="设备内容" />} />
    </Route>
  </Routes></MemoryRouter>);
  expect(screen.getByRole('link', { name: '这台设备' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '设置' })).toBeTruthy();
  expect(screen.getByRole('img', { name: '需要处理' })).toBeTruthy();
  expect(screen.getByTestId('workspace-main-pane').hidden).toBe(false);
  expect(screen.getByTestId('workspace-list-pane').hidden).toBe(true);
  const header = screen.getByTestId('workspace-main-pane').querySelector('header')!;
  const menu = within(header).getByRole('button', { name: '打开导航' });
  expect(within(header).getByRole('heading', { name: '网络访问' })).toBeTruthy();
  expect(within(header).getByRole('button', { name: '通知' })).toBeTruthy();
  expect(within(header).getByRole('button', { name: '收件箱' })).toBeTruthy();
  expect(within(header).getByText('这台设备 ›')).toBeTruthy();
  fireEvent.click(menu);
  expect(screen.getByTestId('workspace-list-pane').hidden).toBe(false);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByTestId('workspace-list-pane').hidden).toBe(true);
  expect(document.activeElement).toBe(menu);
});

function RouteControls() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate('/device/runtime')}>切换页面</button><button onClick={() => navigate(-1)}>返回页面</button></>;
}

test('closes on route changes and does not reopen when returning to the earlier route', () => {
  render(<MemoryRouter initialEntries={['/device/network']}><Routes>
    <Route element={<XpodProductLayout product="dashboard" />}>
      <Route path="/device/:page" element={<RouteControls />} />
    </Route>
  </Routes></MemoryRouter>);
  const menu = screen.getByRole('button', { name: '打开导航' });
  fireEvent.click(menu);
  expect(screen.getByRole('dialog', { name: 'Xpod 导航' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '切换页面' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(menu);
  fireEvent.click(screen.getByRole('button', { name: '返回页面' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
