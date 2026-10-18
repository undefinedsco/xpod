import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({ controls: {} as any, begin: vi.fn(), refetch: vi.fn() }));
vi.mock('../context/AuthContextValue', () => ({ useAuth: () => ({ controls: state.controls, refetchControls: state.refetch }) }));
vi.mock('./external-login', () => ({ beginExternalLogin: state.begin }));
import { ExternalLoginButtons } from './ExternalLoginButtons';

beforeEach(() => {
  state.begin.mockReset();
  state.refetch.mockReset();
  state.controls = { externalLogins: { wechat: { name: '微信', login: '/.account/login/wechat/' } } };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('External login entry controls', () => {
  it('hides entries when the account authority has not configured a provider', () => {
    state.controls = {};
    const { container } = render(<ExternalLoginButtons />);
    expect(container.textContent).toBe('');
  });
  it('starts an explicit registration after the user clicks, with remember off', async () => {
    state.begin.mockRejectedValueOnce(new Error('受控取消'));
    render(<ExternalLoginButtons intent="register" />);
    fireEvent.click(screen.getByRole('button', { name: '使用微信创建账号' }));
    await waitFor(() => expect(state.begin).toHaveBeenCalledWith('/.account/login/wechat/', 'register', false, fetch));
    expect((await screen.findByRole('alert')).textContent).toBe('受控取消');
  });
  it('does not start another login while the password form is submitting', () => {
    render(<ExternalLoginButtons disabled />);
    fireEvent.click(screen.getByRole('button', { name: '微信登录' }));
    expect(state.begin).not.toHaveBeenCalled();
  });
  it('offers unlink only for a bound identity and refreshes the current controls', async () => {
    state.controls.externalLogins.wechat.linked = true;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', fetchImpl);
    render(<ExternalLoginButtons intent="link" />);
    expect(screen.queryByRole('button', { name: '绑定微信' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '解除绑定微信' }));
    await waitFor(() => expect(state.refetch).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
  });
});
