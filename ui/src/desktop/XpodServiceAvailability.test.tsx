// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { XpodServiceAvailability } from './XpodServiceAvailability';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { await Promise.resolve(); });
function Content() {
  const [value, setValue] = useState('existing draft');
  return <input aria-label="draft" value={value} onChange={(e) => setValue(e.target.value)} />;
}

test('keeps mounted state during an outage and recovers without navigation or replay', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('[]'))
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValue(new Response('[]'));
  vi.stubGlobal('fetch', fetch);
  const { container } = render(<XpodServiceAvailability><Content /></XpodServiceAvailability>);
  await settle();
  const input = screen.getByRole('textbox');
  input.focus();
  fireEvent.change(input, { target: { value: 'unsaved draft' } });
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(screen.getByText('Xpod 连接中断')).toBeTruthy();
  expect(container.querySelector('[inert]')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole('button', { name: '立即重试' }));
  await settle();
  expect(screen.queryByText('Xpod 连接中断')).toBeNull();
  expect(screen.getByRole('textbox')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe('unsaved draft');
  expect(fetch.mock.calls.every(([url]) => url === '/service/status')).toBe(true);
});

test('treats a 503 as an outage and online event as a recovery trigger', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValue(new Response('[]')));
  render(<XpodServiceAvailability><Content /></XpodServiceAvailability>);
  await settle();
  expect(screen.getByText('Xpod 连接中断')).toBeTruthy();
  fireEvent(window, new Event('online'));
  await settle();
  expect(screen.queryByText('Xpod 连接中断')).toBeNull();
});

test.each([401, 403, 404])('does not mistake HTTP %s for a service outage or log the session out', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
  render(<XpodServiceAvailability><Content /></XpodServiceAvailability>);
  await settle();
  expect(screen.queryByText('Xpod 连接中断')).toBeNull();
});

test('aborts a hung check after five seconds and cancels all work on unmount', async () => {
  const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  vi.stubGlobal('fetch', fetch);
  const { unmount } = render(<XpodServiceAvailability><Content /></XpodServiceAvailability>);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(screen.getByText('Xpod 连接中断')).toBeTruthy();
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('shows an outage for a stopped child service while the Gateway itself still responds', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([
    { name: 'css', status: 'running' }, { name: 'api', status: 'stopped' },
  ]))));
  render(<XpodServiceAvailability><Content /></XpodServiceAvailability>);
  await settle();
  expect(screen.getByText('Xpod 连接中断')).toBeTruthy();
});


test('keeps navigation and local service controls usable while unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
  const start = vi.fn();
  const { container } = render(<XpodServiceAvailability>
    <nav><a href="/device/runtime">运行设置</a><a href="/settings/appearance">设置</a></nav>
    <button onClick={start}>启动 Xpod</button><Content />
  </XpodServiceAvailability>);
  await settle();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(container.querySelector('[inert]')).toBeNull();
  expect(screen.getByRole('link', { name: '运行设置' }).getAttribute('href')).toBe('/device/runtime');
  fireEvent.click(screen.getByRole('button', { name: '启动 Xpod' }));
  expect(start).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(start).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/未完成的操作不会自动重试/)).toBeTruthy();
});
