import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { XpodTestStack } from '../helpers/XpodTestStack';

// Real Gateway/CSS wiring, but deliberately no real WeChat exchange or user data.
it.skipIf(process.env.XPOD_RUN_INTEGRATION_TESTS !== 'true')('publishes WeChat controls and protects its callback at the Gateway boundary', async () => {
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/wechat-http-'));
  const stack = new XpodTestStack();
  try {
    await stack.start('local', {
      transport: 'port', runtimeRoot: root, logLevel: 'error',
      env: { XPOD_WECHAT_APP_ID: 'fixture-website-app', XPOD_WECHAT_APP_SECRET: 'fixture-not-a-real-secret' },
    });
    const headers = { accept: 'application/json' };
    const jsonHeaders = { ...headers, 'content-type': 'application/json' };
    const controlsResponse = await fetch(new URL('.account/', stack.baseUrl), { headers });
    const controlsBody = await controlsResponse.json();
    expect(controlsResponse.status, JSON.stringify(controlsBody)).toBe(200);
    const { controls } = controlsBody;
    expect(controls.externalLogins.wechat).toEqual({ name: '微信', login: new URL('.account/login/wechat/', stack.baseUrl).href, linked: false });
    expect(controls.password).toBeDefined();

    const crossOrigin = await fetch(controls.externalLogins.wechat.login, {
      method: 'POST', headers: { ...jsonHeaders, origin: 'https://sibling.example.test', 'sec-fetch-site': 'same-site' },
      body: JSON.stringify({ proof: 'p'.repeat(64), intent: 'register' }),
    });
    expect(crossOrigin.status).toBe(403);

    const startResponse = await fetch(controls.externalLogins.wechat.login, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ proof: 'p'.repeat(64), intent: 'register', remember: false }),
    });
    expect(startResponse.status).toBe(200);
    expect(startResponse.headers.get('cache-control')).toBe('no-store');
    const start = await startResponse.json();
    const authorization = new URL(start.authorizationUrl);
    expect(authorization.origin).toBe('https://open.weixin.qq.com');
    expect(authorization.searchParams.get('appid')).toBe('fixture-website-app');
    expect(authorization.searchParams.get('scope')).toBe('snsapi_login');
    expect(authorization.searchParams.get('state')).toBe(start.state);
    expect(authorization.searchParams.get('redirect_uri')).toBe(new URL('.account/login/wechat/callback/', stack.baseUrl).href);

    const callbackPage = await fetch(start.callback, { headers: { accept: 'text/html' } });
    expect(callbackPage.status).toBe(200);
    expect(callbackPage.headers.get('cache-control')).toBe('no-store');
    expect(callbackPage.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await callbackPage.text()).toContain('name="referrer" content="no-referrer"');

    // Invalid browser proof is rejected before any request can reach WeChat.
    const rejected = await fetch(start.callback, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ code: 'fixture-code', state: start.state, proof: 'q'.repeat(64) }),
    });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(await rejected.json())).not.toContain('fixture-not-a-real-secret');
    const unlink = await fetch(controls.externalLogins.wechat.login, { method: 'DELETE', headers });
    expect(unlink.status).toBe(403);
  } finally {
    await stack.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
