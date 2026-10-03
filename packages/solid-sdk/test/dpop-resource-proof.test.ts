import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as browserCore from '@inrupt/solid-client-authn-core';
import { importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

const nodeCore = createRequire(import.meta.url)('@inrupt/solid-client-authn-core') as typeof browserCore;

// Exercise the installed signer used by real Session.fetch, without substituting
// a UI transport or inventing a second signer in the SDK wrapper.
describe.each([['core ESM', browserCore], ['Node CJS', nodeCore]] as const)('%s resource DPoP', (_name, core) => {
  async function assertProof(init: RequestInit, token: string, target: string, method: string) {
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`DPoP ${token}`);
    const proof = headers.get('dpop')!;
    const header = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url').toString());
    const key = await importJWK(header.jwk, header.alg);
    const { payload } = await jwtVerify(proof, key, { algorithms: ['ES256'] });
    expect(payload).toMatchObject({
      ath: createHash('sha256').update(token).digest('base64url'), htu: target, htm: method,
    });
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
  }

  it('binds the proof to the actual resource token, method and normalized URL', async () => {
    const dpopKey = await core.generateDpopKeyPair();
    const fetch = core.buildAuthenticatedFetch('resource-access-token', {
      dpopKey,
      fetch: async (_url, init) => {
        await assertProof(init!, 'resource-access-token', 'https://identity.example/.account/', 'POST');
        return new Response(null, { status: 200 });
      },
    });
    await fetch('https://identity.example/.account/?details=true#fragment', { method: 'POST' });
  });

  it('binds to the renewed token at dispatch after expiration', async () => {
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const emitter = new EventEmitter();
    emitter.on(core.EVENTS.TIMEOUT_SET, timeout => timeouts.push(timeout));
    const fetch = core.buildAuthenticatedFetch('expired-access-token', {
      expiresIn: 0, eventEmitter: emitter, dpopKey: await core.generateDpopKeyPair(),
      refreshOptions: {
        sessionId: 'fixture', refreshToken: 'fixture-refresh-token',
        tokenRefresher: { refresh: async () => ({ accessToken: 'renewed-access-token', expiresIn: 600 }) },
      },
      fetch: async (_url, init) => {
        await assertProof(init!, 'renewed-access-token', 'https://identity.example/.account/', 'GET');
        return new Response(null, { status: 200 });
      },
    });
    try { await fetch('https://identity.example/.account/'); }
    finally { timeouts.forEach(clearTimeout); }
  });

  it('keeps token-endpoint proofs without ath when no access token exists', async () => {
    const proof = await core.createDpopHeader('https://identity.example/.oidc/token', 'post', await core.generateDpopKeyPair());
    const payload = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString());
    expect(payload.ath).toBeUndefined();
    expect(payload.htm).toBe('POST');
  });

  it('regenerates the proof for the redirect target while retaining the token hash', async () => {
    let dispatches = 0;
    const targets = ['https://identity.example/start', 'https://identity.example/.account/'];
    const proofs: string[] = [];
    const fetch = core.buildAuthenticatedFetch('redirect-access-token', {
      dpopKey: await core.generateDpopKeyPair(),
      fetch: async (_url, init) => {
        await assertProof(init!, 'redirect-access-token', targets[dispatches], 'GET');
        proofs.push(new Headers(init!.headers).get('dpop')!);
        dispatches += 1;
        const response = new Response(null, { status: dispatches === 1 ? 401 : 200 });
        Object.defineProperty(response, 'url', { value: targets[1] });
        return response;
      },
    });
    await fetch(targets[0]);
    expect(dispatches).toBe(2);
    expect(proofs[0]).not.toBe(proofs[1]);
  });

  it('preserves Bearer resource fetch when no DPoP key is present', async () => {
    const fetch = core.buildAuthenticatedFetch('bearer-fixture', {
      fetch: async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer bearer-fixture');
        expect(headers.has('dpop')).toBe(false);
        return new Response(null, { status: 200 });
      },
    });
    await fetch('https://identity.example/.account/');
  });
});
