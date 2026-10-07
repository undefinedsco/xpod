// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PodDeletionAuthorizationPanel, PodManagementTaskRoute } from './PodDeletionAuthorizationPanel';

const target = () => ({ challenge: 'opaque.challenge', podName: 'alice', expiresAt: Date.now() + 60000,
  cloudAccountId: 'verified-cloud-account', cloudPodId: 'cloud-pod', nodeId: 'node',
  storageUrl: 'https://verified-node.test/alice/', currentLocalPodId: 'local-generation-1',
  ownerWebIds: ['https://verified-node.test/alice/profile/card#me'], returnUrl: 'https://cloud.test/.account/account/' });
const path = '/settings/pod?deletionAuthorization=opaque.challenge&podName=alice&cloudAccountId=FORGED&storageUrl=https://evil.test/';
function mount() { return render(<MemoryRouter initialEntries={[path]}><PodDeletionAuthorizationPanel /></MemoryRouter>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('inspects authoritative facts, cancels without authorization, and confirms the inspected generation', async () => {
  const fetchMock = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return request.action === 'inspectDeletionAuthorization'
      ? Response.json({ deletionAuthorization: target() }) : Response.json({ success: true, returnUrl: target().returnUrl });
  });
  vi.stubGlobal('fetch', fetchMock); mount();
  await screen.findByText('verified-cloud-account');
  expect(screen.queryByText('FORGED')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const allow = screen.getByRole('button', { name: '允许这个账号删除此 Pod' });
  fireEvent.click(allow);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(allow);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '允许这个账号删除此 Pod' }));
  await screen.findByText('已启用删除。这个 Pod 的数据尚未删除。');
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ action: 'authorizeDeletion', challenge: 'opaque.challenge', podName: 'alice', expectedLocalPodId: 'local-generation-1' });
  expect(fetchMock.mock.calls.every(([url, init]) => url === '/provision/pods' && init?.method === 'POST' && init.credentials === 'same-origin' && init.redirect === 'error')).toBe(true);
  expect(screen.getByRole('link', { name: '返回账号页面' }).getAttribute('href')).toBe(target().returnUrl);
});

test.each(['POD_DELETE_OPERATOR_REQUIRED', 'POD_DELETE_ORIGIN_REQUIRED'])('fails closed without device authority: %s', async (code) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code }, { status: 403 })));
  mount();
  expect((await screen.findByRole('alert')).textContent).toContain('设备管理权限');
  expect(screen.queryByRole('button', { name: '允许这个账号删除此 Pod' })).toBeNull();
  expect(screen.getByLabelText('本机 Xpod 管理地址')).toBeTruthy();
  expect(document.querySelector('input[type=password]')).toBeNull();
});

test('rejects a rebuilt Pod and never silently retries a different generation', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ deletionAuthorization: target() }))
    .mockResolvedValueOnce(Response.json({ code: 'POD_DELETE_GENERATION_CHANGED' }, { status: 409 }));
  vi.stubGlobal('fetch', fetchMock); mount();
  fireEvent.click(await screen.findByRole('button', { name: '允许这个账号删除此 Pod' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '允许这个账号删除此 Pod' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Pod 已发生变化');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: '允许这个账号删除此 Pod' })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('keeps transient failure retryable without duplicate pending requests', async () => {
  let resolve!: (value: Response) => void;
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ deletionAuthorization: target() }))
    .mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
    .mockResolvedValueOnce(Response.json({ success: true, returnUrl: target().returnUrl }));
  vi.stubGlobal('fetch', fetchMock); mount();
  fireEvent.click(await screen.findByRole('button', { name: '允许这个账号删除此 Pod' }));
  const dialog = screen.getByRole('dialog');
  const confirm = within(dialog).getByRole('button', { name: '允许这个账号删除此 Pod' });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect((within(dialog).getByRole('button', { name: '正在授权…' }) as HTMLButtonElement).disabled).toBe(true);
  resolve(Response.json({ code: 'POD_DELETE_NODE_UNAVAILABLE' }, { status: 502 }));
  await within(dialog).findByRole('alert');
  fireEvent.click(within(dialog).getByRole('button', { name: '允许这个账号删除此 Pod' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test.each([{ returnUrl: 'javascript:alert(1)' }, { expiresAt: 1 }])('rejects invalid inspection metadata: %j', async (invalid) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ deletionAuthorization: { ...target(), ...invalid } })));
  mount();
  expect((await screen.findByRole('alert')).textContent).toContain('请求已失效');
  expect(screen.queryByRole('link')).toBeNull();
});


test('treats plain 401 as device access failure and rejects unsafe recovery addresses without network calls', async () => {
  const fetchMock = vi.fn(async () => Response.json({}, { status: 401 }));
  vi.stubGlobal('fetch', fetchMock); mount();
  await screen.findByText(/当前访问没有设备管理权限/);
  for (const value of ['https://evil.test/', 'http://localhost.evil.test/', 'http://user:secret@localhost:40991/', 'http://localhost:40991/?x=1', 'http://localhost:40991/#x', 'file:///tmp/x', 'http://192.168.1.2:40991/']) {
    fireEvent.change(screen.getByLabelText('本机 Xpod 管理地址'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '在本机继续' }));
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('请输入本机'))).toBe(true);
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
});


test('keeps ordinary legacy Pod entry on its canonical editor', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  render(<MemoryRouter initialEntries={['/settings/pod']}><Routes>
    <Route path="/settings/pod" element={<PodManagementTaskRoute to="/pod/models" />} />
    <Route path="/pod/models" element={<span>Canonical Pod editor</span>} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText('Canonical Pod editor')).toBeTruthy();
  expect(request).not.toHaveBeenCalled();
});

test('opens the explicit legacy deletion task without redirecting to the WebID editor', async () => {
  const request = vi.fn(async () => Response.json({ deletionAuthorization: target() }));
  vi.stubGlobal('fetch', request);
  render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/settings/pod" element={<PodManagementTaskRoute to="/pod/models" />} />
    <Route path="/pod/models" element={<span>Canonical Pod editor</span>} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText('verified-cloud-account')).toBeTruthy();
  expect(screen.queryByText('Canonical Pod editor')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
