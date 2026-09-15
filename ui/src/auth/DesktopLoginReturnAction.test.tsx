// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ErrorScreen } from '../components/ErrorScreen';
import { AccountAuthBoundary } from './AccountAuthBoundary';
import { AuthContext } from '../context/AuthContextValue';

afterEach(() => { cleanup(); window.xpodDesktop = undefined; });

const surfaces = {
  global: () => <ErrorScreen message="offline" retry={vi.fn()} />,
  boundary: () => <AuthContext.Provider value={{} as never}>
    <AccountAuthBoundary accountState={{ status: 'error', mode: 'login', message: 'offline' }} retry={vi.fn()} />
  </AuthContext.Provider>,
};

describe.each(Object.entries(surfaces))('%s Account recovery', (_name, surface) => {
  test('does not invent a browser return destination', () => {
    render(surface());
    expect(screen.queryByRole('button', { name: '返回应用' })).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  test('awaits desktop cancellation once and offers retry after rejection', async () => {
    let reject!: (reason: Error) => void;
    const cancelLogin = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue(undefined);
    window.xpodDesktop = { platform: 'darwin', setIdentity: vi.fn(), cancelLogin };
    render(surface());
    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));
    const waiting = screen.getByRole('button', { name: '正在返回…' });
    expect(waiting.hasAttribute('disabled')).toBe(true);
    fireEvent.click(waiting);
    expect(cancelLogin).toHaveBeenCalledTimes(1);
    reject(new Error('private IPC detail'));
    await waitFor(() => expect(screen.getByRole('button', { name: '返回应用' })).toBeTruthy());
    expect(screen.getByText('返回应用未完成，请重试。')).toBeTruthy();
    expect(screen.queryByText('private IPC detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));
    await waitFor(() => expect(cancelLogin).toHaveBeenCalledTimes(2));
  });
});
