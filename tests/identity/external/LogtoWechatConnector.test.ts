import { beforeEach, describe, expect, it, vi } from 'vitest';
const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('got', () => ({ got: http, HTTPError: class HTTPError extends Error {} }));
import { createWechatLoginProvider } from '../../../src/identity/external/ExternalLoginProvider';

describe('published Logto connector through the Xpod adapter (HTTP fixture)', () => {
  beforeEach(() => http.get.mockReset());
  it('uses the website scope and the stable public callback', async () => {
    const provider = createWechatLoginProvider('fixture-app', 'fixture-secret');
    const url = new URL(await provider.authorizationUrl('state', 'https://id.test/.account/login/wechat/callback/'));
    expect(url.origin + url.pathname).toBe('https://open.weixin.qq.com/connect/qrconnect');
    expect(url.searchParams.get('scope')).toBe('snsapi_login');
    expect(url.searchParams.get('redirect_uri')).toBe('https://id.test/.account/login/wechat/callback/');
  });
  it('exchanges a code and extracts OpenID even when Logto selects UnionID', async () => {
    http.get.mockResolvedValueOnce({ body: JSON.stringify({ access_token: 'token', openid: 'openid', expires_in: 7200 }) })
      .mockResolvedValueOnce({ body: JSON.stringify({ openid: 'openid', unionid: 'unionid', nickname: 'name' }) });
    const provider = createWechatLoginProvider('fixture-app', 'fixture-secret');
    expect(await provider.identity('code')).toEqual({ subject: 'openid', unionId: 'unionid' });
    expect(http.get.mock.calls[0][1].searchParams).toEqual({ appid: 'fixture-app', secret: 'fixture-secret', code: 'code', grant_type: 'authorization_code' });
  });
  it('rejects HTTP-200 business errors without propagating secret-bearing errors', async () => {
    http.get.mockResolvedValueOnce({ body: JSON.stringify({ errcode: 40029, errmsg: 'secret=DO_NOT_LOG' }) });
    await expect(createWechatLoginProvider('app', 'secret').identity('code')).rejects.toThrow('EXTERNAL_AUTHORIZATION_FAILED');
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});
