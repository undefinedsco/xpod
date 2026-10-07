import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { readRcAccountBindings } from '../helpers/rcLightWeb';

// Actual Chromium Cookie transport, deliberately synthetic Account endpoints.
// This is a browser boundary regression, not Xpod/RC OIDC or desktop evidence.
it('restores a native HTTP-only Account Cookie in a new Chromium context without a desktop bridge', async () => {
  const accountId = '11111111-1111-4111-8111-111111111111';
  const binding = { webId: 'https://id.example/alice/profile/card#me', storageUrl: 'https://pods.example/alice/' };
  const server = createServer((request, response) => {
    if (request.url === '/login-fixture') {
      response.setHeader('Set-Cookie', 'account=alice-fixture; HttpOnly; SameSite=Lax; Path=/');
      response.end('<h1>Fixture login</h1>');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (!request.headers.cookie?.includes('account=alice-fixture')) { response.statusCode = 401; response.end('{}'); return; }
    if (request.url === '/.account/') response.end(JSON.stringify({ controls: { account: {
      id: accountId, logout: `/.account/${accountId}/logout/`, bindings: `/.account/${accountId}/bindings/`,
    } } }));
    else if (request.url === `/.account/${accountId}/bindings/`) response.end(JSON.stringify({ bindings: [binding] }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const first = await browser.newContext();
    const page = await first.newPage();
    await page.goto(`${baseUrl}login-fixture`);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    const state = await first.storageState();
    expect(state.cookies[0].httpOnly).toBe(true);
    await first.close();
    const restored = await browser.newContext({ storageState: state });
    const resumed = await restored.newPage();
    expect(await readRcAccountBindings(resumed, baseUrl)).toEqual({ accountId, bindings: [binding] });
    expect(await resumed.evaluate(() => Boolean((globalThis as { xpodDesktop?: unknown }).xpodDesktop))).toBe(false);
    const anonymous = await browser.newContext();
    await expect(readRcAccountBindings(await anonymous.newPage(), baseUrl)).rejects.toThrow('HTTP 401');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it('uses actual SDK DPoP fetch for both owners on the wire (synthetic resource server)', async () => {
  const { buildAuthenticatedFetch, generateDpopKeyPair } = await import('@inrupt/solid-client-authn-core');
  const { decodeProtectedHeader, importJWK, jwtVerify } = await import('jose');
  const { createHash } = await import('node:crypto');
  const { verifyRcPrivateIsolation } = await import('../helpers/rcLightWeb');
  const files = new Map<string, string>();
  let verifiedProofs = 0;
  let deniedReads = 0;
  let deniedWrites = 0;
  let origin = '';
  const server = createServer((request, response) => {
    void (async () => {
      const credential = request.headers.authorization?.match(/^DPoP (fixture-alice|fixture-bob)$/u)?.[1];
      let owner: string | undefined;
      if (credential && typeof request.headers.dpop === 'string') {
        const proof = request.headers.dpop;
        const header = decodeProtectedHeader(proof);
        if (!header.jwk) throw new Error('missing-proof-key');
        const { payload } = await jwtVerify(proof, await importJWK(header.jwk, header.alg), { algorithms: ['ES256'] });
        if (payload.htm !== request.method || payload.htu !== new URL(request.url!, origin).href
          || payload.ath !== createHash('sha256').update(credential).digest('base64url')) throw new Error('invalid-proof');
        verifiedProofs++;
        owner = credential.slice('fixture-'.length);
      }
      if (!owner || !request.url?.startsWith(`/${owner}/`)) {
        if (request.method === 'GET') deniedReads++;
        if (request.method === 'PUT') deniedWrites++;
        response.statusCode = 403; response.end(); return;
      }
      const target = request.url!;
      if (request.method === 'PUT') {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (files.has(target)) { response.statusCode = 412; response.end(); return; }
        files.set(target, body); response.statusCode = 201; response.end();
      } else if (request.method === 'DELETE') {
        files.delete(target); response.statusCode = 204; response.end();
      } else {
        response.statusCode = files.has(target) ? 200 : 404; response.end(files.get(target));
      }
    })().catch(() => { response.statusCode = 500; response.end('Synthetic proof validation failed'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const sessions = await Promise.all(['alice', 'bob'].map(async owner => ({
      identity: { accountId: owner, webId: `https://id.example/${owner}/profile/card#me`, storageUrl: `${origin}${owner}/` },
      authenticatedFetch: await buildAuthenticatedFetch(`fixture-${owner}`, { dpopKey: await generateDpopKeyPair(), fetch }),
    })));
    await verifyRcPrivateIsolation(sessions);
    expect(files.size).toBe(0);
    expect(verifiedProofs).toBeGreaterThanOrEqual(12);
    expect(deniedReads).toBe(4);
    expect(deniedWrites).toBe(4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
