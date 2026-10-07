// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { XpodDeploymentIdentity } from './XpodDeploymentIdentity';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each([
  [{ edition: 'cloud', managed: false }, '云端'],
  [{ edition: 'local', managed: true, oidcIssuer: 'https://accounts.example/' }, '托管部署'],
  [{ edition: 'local', managed: false }, '独立部署'],
])('uses server metadata for %s, irrespective of browser hostname', async (body, label) => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', request);
  render(<XpodDeploymentIdentity />);
  expect(await screen.findByText(label)).toBeTruthy();
  expect(screen.queryByText(window.location.origin)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '部署详情' }));
  const details = within(await screen.findByRole('tooltip'));
  expect(details.getByText(window.location.origin)).toBeTruthy();
  if ('oidcIssuer' in body) expect(details.getByText('https://accounts.example')).toBeTruthy();
  expect(request).toHaveBeenCalledWith('/api/service-info', expect.objectContaining({ cache: 'no-store' }));
});

test.each([{}, { edition: 'local' }, { edition: 'other', managed: false }, {
  edition: 'local', managed: true, oidcIssuer: 'https://user:secret@example.com/',
}])('never guesses an edition or exposes invalid issuer metadata: %s', async body => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  render(<XpodDeploymentIdentity />);
  expect(await screen.findByText('部署信息暂不可用')).toBeTruthy();
  expect(screen.queryByText(/secret/)).toBeNull();
  expect(screen.queryByText('云端')).toBeNull();
});

test('reports unavailable metadata without blocking the login page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  render(<XpodDeploymentIdentity />);
  expect(await screen.findByText('部署信息暂不可用')).toBeTruthy();
});

test('distinguishes the allocated node URL from the current transport and account issuer', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    edition: 'local', managed: true, publicUrl: 'https://assigned.nodes.example/', oidcIssuer: 'https://accounts.example/',
  }))));
  render(<XpodDeploymentIdentity />);
  await screen.findByText('托管部署');
  expect(screen.queryByText('https://assigned.nodes.example/')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '部署详情' }));
  const details = within(await screen.findByRole('tooltip'));
  expect(details.getByText('https://assigned.nodes.example/')).toBeTruthy();
  expect(details.getByText(window.location.origin)).toBeTruthy();
  expect(details.getByText('https://accounts.example')).toBeTruthy();
});

test('states explicitly that a managed node has no assigned URL', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ edition: 'local', managed: true, publicUrl: null }))));
  render(<XpodDeploymentIdentity />);
  await screen.findByText('托管部署');
  fireEvent.click(screen.getByRole('button', { name: '部署详情' }));
  expect(within(await screen.findByRole('tooltip')).getByText('尚未分配')).toBeTruthy();
});


test('keyboard focus opens details, Escape and outside pointer close them', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ edition: 'cloud', managed: false }))));
  render(<XpodDeploymentIdentity />);
  await screen.findByText('云端');
  const trigger = screen.getByRole('button', { name: '部署详情' });
  fireEvent.focus(trigger);
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  fireEvent.keyDown(trigger, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  fireEvent.click(trigger);
  expect(await screen.findByRole('tooltip')).toBeTruthy();
  // DismissableLayer installs its document listener after mounting.
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});

test('opening details does not remount an adjacent form or alter its selection', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ edition: 'local', managed: false })));
  vi.stubGlobal('fetch', request);
  render(<><XpodDeploymentIdentity /><input aria-label="邮箱" defaultValue="user@example.com" /></>);
  await screen.findByText('独立部署');
  const input = screen.getByRole('textbox', { name: '邮箱' }) as HTMLInputElement;
  input.focus();
  input.setSelectionRange(0, input.value.length);
  const trigger = screen.getByRole('button', { name: '部署详情' });
  fireEvent.click(trigger);
  await screen.findByRole('tooltip');
  await new Promise(resolve => setTimeout(resolve, 0));
  fireEvent.pointerDown(trigger, { cancelable: true });
  fireEvent.pointerUp(trigger);
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  expect(screen.getByRole('textbox', { name: '邮箱' })).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  expect(request).toHaveBeenCalledTimes(1);
});

test('hover opens address details without requiring a click', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ edition: 'cloud', managed: false }))));
  render(<XpodDeploymentIdentity />);
  await screen.findByText('云端');
  fireEvent.pointerMove(screen.getByRole('button', { name: '部署详情' }), { pointerType: 'mouse' });
  expect(await screen.findByRole('tooltip')).toBeTruthy();
});
