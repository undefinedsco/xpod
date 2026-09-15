import { AppRunner, type App } from '@solid/community-server';
import { CookieJar, JSDOM } from 'jsdom';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getFreePort } from '../../src/runtime/port-finder';
import { getAccountSessionToken, storeAccountSessionToken } from '../../ui/src/utils/account-session';

// Native CSS HTTP/cookie persistence plus the actual frontend synchronization
// helper. This is a disposable CSS service, not a three-deployment matrix.
it('preserves native remembered cookies without remembering a later unremembered account', async () => {
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/account-cookie-memory-'));
  const port = await getFreePort(30_000 + Math.floor(Math.random() * 20_000));
  const origin = `http://localhost:${port}`;
  const jar = new CookieJar();
  const dom = new JSDOM('', { url: `${origin}/.account/`, cookieJar: jar });
  let app: App | undefined;
  const request = async (route: string, body?: object, token?: string) => {
    const response = await fetch(new URL(route, origin), {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? {} : { Cookie: jar.getCookieStringSync(origin) }), ...(token ? { Authorization: `CSS-Account-Token ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, origin);
    return response;
  };
  const accountCookie = () => jar.getCookiesSync(origin).find((cookie) => cookie.key === 'css-account');
  try {
    app = await new AppRunner().create({ shorthand: { port, baseUrl: `${origin}/`, rootFilePath: root, loggingLevel: 'off' } });
    await app.start();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    for (const name of ['alice', 'bob']) {
      jar.removeAllCookiesSync();
      const created = await request('/.account/account/', {});
      expect(created.ok).toBe(true);
      const { authorization } = await created.json() as { authorization: string };
      const controlsResponse = await request('/.account/', undefined, authorization);
      expect(controlsResponse.status).toBe(200);
      const controls = await controlsResponse.json() as { controls: { password: { create: string } } };
      expect((await request(controls.controls.password.create, { email: `${name}@example.test`, password: 'account-cookie-password' }, authorization)).ok).toBe(true);
    }
    const remembered = await request('/.account/login/password/', { email: 'alice@example.test', password: 'account-cookie-password', remember: true });
    expect(remembered.ok).toBe(true);
    const rememberedBody = await remembered.json() as { authorization: string };
    const expiry = accountCookie()?.expires;
    expect(expiry).toBeInstanceOf(Date);
    expect((expiry as Date).getTime()).toBeGreaterThan(Date.now());
    storeAccountSessionToken(rememberedBody.authorization);
    expect(accountCookie()?.expires).toEqual(expiry);

    const unremembered = await request('/.account/login/password/', { email: 'bob@example.test', password: 'account-cookie-password', remember: false });
    expect(unremembered.ok).toBe(true);
    const unrememberedBody = await unremembered.json() as { authorization: string };
    expect(unrememberedBody.authorization).not.toBe(rememberedBody.authorization);
    storeAccountSessionToken(unrememberedBody.authorization);
    expect(accountCookie()?.expires).toBe('Infinity');
    expect(getAccountSessionToken()).toBe(unrememberedBody.authorization);
    const controlsResponse = await request('/.account/');
    const controls = await controlsResponse.json() as { controls: { account: { logout: string } } };
    expect((await request(controls.controls.account.logout, {})).ok).toBe(true);
    expect(accountCookie()).toBeUndefined();
    expect(getAccountSessionToken()).toBeUndefined();
    const replay = await request('/.account/', undefined, unrememberedBody.authorization);
    const replayBody = await replay.json() as { controls?: { account?: { logout?: string } } };
    expect(replayBody.controls?.account?.logout).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
