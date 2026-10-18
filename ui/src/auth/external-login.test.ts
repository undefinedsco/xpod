import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginExternalLogin, completeExternalLogin } from './external-login';

const state = 's'.repeat(43);
const callback = '/.account/login/wechat/callback/';
const endpoint = '/.account/login/wechat/';
const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const key = `xpod.external-login.${state}`;

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', endpoint);
});
async function begin(callbackUrl = callback) {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ state, authorizationUrl: `https://open.weixin.qq.com/connect/qrconnect?state=${state}`, callback: callbackUrl }));
  await beginExternalLogin(endpoint, 'login', false, fetchImpl as typeof fetch);
  return fetchImpl;
}

describe('External login browser transaction', () => {
  it('keeps proof in the initiating tab and sends explicit intent/remember', async () => {
    const fetchImpl = await begin();
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ intent: 'login', remember: false });
    expect(body.proof).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({ proof: body.proof });
  });
  it('rejects cross-origin start or callback addresses before saving credentials', async () => {
    const fetchImpl = vi.fn();
    await expect(beginExternalLogin('https://evil.test/.account/login/wechat/', 'login', false, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(begin('https://evil.test/.account/login/wechat/callback/')).rejects.toThrow();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('rejects a callback in another browser and immediately removes code from the address', async () => {
    window.history.replaceState(null, '', `${callback}?state=${state}&code=one-use`);
    const fetchImpl = vi.fn();
    await expect(completeExternalLogin(fetchImpl)).rejects.toThrow('浏览器窗口');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
  it('completes only once on the original CSS interaction and strips URL parameters', async () => {
    const scoped = `/.account/interaction/flow/login/wechat/callback/`;
    await begin(scoped);
    window.history.replaceState(null, '', `${callback}?state=${state}&code=one-use`);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ authorization: 'account-cookie', location: '/.oidc/auth/flow' }));
    const result = await completeExternalLogin(fetchImpl as typeof fetch);
    expect(result).toMatchObject({ authorization: 'account-cookie' });
    expect(fetchImpl.mock.calls[0][0]).toBe(new URL(scoped, window.location.origin).href);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toMatchObject({ code: 'one-use', state });
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(window.location.search).toBe('');
    await expect(completeExternalLogin(fetchImpl as typeof fetch)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects expiration, duplicate query parameters and provider path substitution', async () => {
    await begin();
    const pending = JSON.parse(sessionStorage.getItem(key)!);
    pending.created = Date.now() - 11 * 60_000;
    sessionStorage.setItem(key, JSON.stringify(pending));
    window.history.replaceState(null, '', `${callback}?state=${state}&code=code`);
    const fetchImpl = vi.fn();
    await expect(completeExternalLogin(fetchImpl)).rejects.toThrow('过期');
    await begin();
    window.history.replaceState(null, '', `${callback}?state=${state}&code=one&code=two`);
    await expect(completeExternalLogin(fetchImpl)).rejects.toThrow('无效');
    await begin();
    window.history.replaceState(null, '', `/.account/login/other/callback/?state=${state}&code=code`);
    await expect(completeExternalLogin(fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects an external return location even if the completion response is successful', async () => {
    await begin();
    window.history.replaceState(null, '', `${callback}?state=${state}&code=one-use`);
    await expect(completeExternalLogin(vi.fn(async () => json({ authorization: 'cookie', location: 'https://evil.test/' })))).rejects.toThrow('返回地址');
  });
  it('retains the original OIDC interaction in the retry link on a rejected login', async () => {
    await begin('/.account/interaction/flow/login/wechat/callback/');
    window.history.replaceState(null, '', `${callback}?state=${state}&code=one-use`);
    await expect(completeExternalLogin(vi.fn(async () => json({ error: 'EXTERNAL_ACCOUNT_NOT_LINKED' }, 400))))
      .rejects.toMatchObject({ retryTo: '/.account/interaction/flow/login/password/' });
  });
});
