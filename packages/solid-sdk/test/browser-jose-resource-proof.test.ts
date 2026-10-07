import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); });

it('installed resource signer binds ath using the actual browser JOSE encoder and WebCrypto', async () => {
  const require = createRequire(import.meta.url);
  // Node's Buffer encoder accepts ArrayBuffer, but browser JOSE requires
  // Uint8Array. Load the browser implementation explicitly to protect that ABI.
  const browserEntry = pathToFileURL(join(dirname(require.resolve('jose/package.json')), 'dist/browser/index.js')).href;
  vi.stubGlobal('crypto', webcrypto);
  const jose = await import(browserEntry);
  const bundle = readFileSync(require.resolve('@inrupt/solid-client-authn-core').replace(/index\.js$/u, 'index.mjs'), 'utf8');
  const start = bundle.indexOf('async function createDpopHeader(');
  const end = bundle.indexOf('async function generateDpopKeyPair(', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // Execute the installed function body with real browser JOSE. The deployed
  // bundler selects this implementation; a Node ESM import alone does not.
  const signer = new Function('SignJWT', 'PREFERRED_SIGNING_ALG', 'base64url', 'normalizeHTU', 'v4',
    `${bundle.slice(start, end)}; return createDpopHeader;`)(
    jose.SignJWT, ['ES256'], jose.base64url, (url: string) => new URL(url).origin + new URL(url).pathname, randomUUID,
  );
  const keys = await jose.generateKeyPair('ES256');
  vi.stubGlobal('CryptoKey', keys.privateKey.constructor);
  const publicKey = await jose.exportJWK(keys.publicKey);
  const token = 'browser-encoder-fixture-token';
  const proof = await signer('https://identity.example/.account/', 'get', { privateKey: keys.privateKey, publicKey }, token);
  const { payload } = await jose.jwtVerify(proof, jose.EmbeddedJWK, { algorithms: ['ES256'] });
  expect(payload.ath).toBe(createHash('sha256').update(token).digest('base64url'));
  expect(payload).toMatchObject({ htm: 'GET', htu: 'https://identity.example/.account/' });
});
