// Run against an installed JS package, never against repository dependencies.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

async function verifyBunJoseBuilds(caller, packageRoot) {
  const load = createRequire(caller);
  // The patched Bun condition selects Node CJS for require and Node ESM for import.
  assert.match(load.resolve('jose').replace(/\\/gu, '/'), /\/dist\/node\/cjs\/index\.js$/u);
  const { generateKeyPair, exportJWK } = load('jose');
  const { privateKey } = await generateKeyPair('ES256');
  assert.equal((await exportJWK(privateKey)).kty, 'EC');
  execFileSync(process.execPath, ['--no-install', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const resolved = fileURLToPath(import.meta.resolve('jose'));
    assert(resolved.startsWith(${JSON.stringify(packageRoot)} + path.sep), 'ESM JOSE escaped the installed artifact');
    assert.match(resolved.split(path.sep).join('/'), /\\/dist\\/node\\/esm\\/index\\.js$/u);
    const { generateKeyPair, exportJWK } = await import('jose');
    const { privateKey } = await generateKeyPair('ES256');
    assert.equal((await exportJWK(privateKey)).kty, 'EC');
  `], { cwd: path.dirname(caller), env: { ...process.env, NODE_PATH: '' }, timeout: 10_000 });
}

async function main() {
  const packageRoot = require('node:fs').realpathSync(path.resolve(process.argv[2]));
  const consumerRoot = require('node:fs').realpathSync(path.resolve(packageRoot, '..', '..', '..'));
  const Module = require('node:module');
  const resolve = Module._resolveFilename;
  if (!process.versions.bun) Module._resolveFilename = function (...args) {
    const resolved = resolve.apply(this, args);
    if (path.isAbsolute(resolved)) assert(resolved.startsWith(`${consumerRoot}${path.sep}`), `Dependency escaped clean consumer: ${resolved}`);
    return resolved;
  };
  const load = createRequire(path.join(packageRoot, 'package.json'));
  const css = path.dirname(load.resolve('@solid/community-server/package.json'));
  assert(css.startsWith(`${packageRoot}${path.sep}`), 'CSS must be bundled in the installed artifact');
  const { IdentityProviderFactory } = load(path.join(css, 'dist/identity/configuration/IdentityProviderFactory.js'));
  const { IdInteractionRoute } = load(path.join(css, 'dist/identity/interaction/routing/IdInteractionRoute.js'));
  const hook = async () => true;
  const factory = new IdentityProviderFactory({ issueRefreshToken: hook }, {
    baseUrl: 'https://id.example/', oidcPath: '/.oidc',
    interactionRoute: new IdInteractionRoute({ getPath: () => 'https://id.example/interaction/' }, 'interactionId'),
  });
  factory.generateCookieKeys = async () => ['packaged-test-key'];
  const config = await factory.initConfig({ alg: 'RS256' });
  assert.equal(config.issueRefreshToken, hook);
  factory.configureRoutes(config);
  assert.equal(await config.interactions.url({}, { uid: 'first-authorization' }), 'https://id.example/interaction/first-authorization/');

  const providerRoot = path.dirname(path.dirname(load.resolve('oidc-provider')));
  const { default: sessionHandler } = await import(pathToFileURL(path.join(providerRoot, 'lib/shared/session.js')).href);
  let headers = ['session=remembered'];
  await sessionHandler({
    oidc: { provider: { Session: { get: async () => ({ new: true, transient: false, exp: 2_000_000_000 }) }, cookieName: () => 'session' } },
    response: { get: () => [...headers], set: (_name, value) => { headers = value; } },
  }, async () => {});
  assert.match(headers[0], /; expires=/, 'remembered cookie updates must survive copy-on-read headers');

  for (const caller of ['@inrupt/solid-client-authn-node', '@inrupt/oidc-client-ext', '@solid/access-token-verifier']) {
    const callerLoad = createRequire(load.resolve(caller));
    assert.equal(callerLoad.resolve('jose'), load.resolve('jose'), `${caller} must resolve patched jose`);
    if (caller.startsWith('@inrupt/')) assert.equal(callerLoad.resolve('@inrupt/solid-client-authn-core'), load.resolve('@inrupt/solid-client-authn-core'), `${caller} must resolve patched core`);
  }
  const openidLoad = createRequire(load.resolve('openid-client'));
  assert(openidLoad.resolve('jose').startsWith(`${packageRoot}${path.sep}`), 'openid-client must retain its bundled jose version');
  if (process.versions.bun) {
    await verifyBunJoseBuilds(path.join(packageRoot, 'package.json'), packageRoot);
    await verifyBunJoseBuilds(load.resolve('openid-client'), packageRoot);
  }
  for (const scopedLoad of [load, openidLoad]) {
    const jose = scopedLoad('jose'); // Must be synchronously loadable by its actual callers.
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    const publicJwk = await jose.exportJWK(publicKey);
    const verificationKey = await jose.importJWK(publicJwk, 'RS256');
    const token = await new jose.SignJWT({ fixture: 'packaged-auth' })
      .setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
    const { payload } = await jose.jwtVerify(token, verificationKey, { algorithms: ['RS256'] });
    assert.equal(payload.fixture, 'packaged-auth');
    await assert.rejects(jose.jwtVerify(token, verificationKey, { algorithms: ['ES256'] }));
  }
  const { Session } = load('@inrupt/solid-client-authn-browser');
  const { EVENTS } = load('@inrupt/solid-client-authn-core');
  const session = new Session({ clientAuthentication: {
    handleIncomingRedirect: async (_url, events) => { events.emit(EVENTS.ERROR, 'fixture'); return undefined; },
  } });
  let release;
  let finished = false;
  session.internalLogout = () => new Promise((resolve) => { release = resolve; });
  const callback = session.handleIncomingRedirect('https://app.example/callback').then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'callback must await failed-session cleanup');
  assert.equal(typeof release, 'function');
  release();
  await callback;
  assert.equal(finished, true);
  console.log('packaged authentication: scoped interaction, refresh hook, remembered cookie, callback cleanup passed');
}
if (require.main === module) {
  const watchdog = setTimeout(() => {
    console.error('Packaged authentication probe did not complete');
    process.exit(1);
  }, 30_000);
  main().then(
    () => clearTimeout(watchdog),
    (error) => { clearTimeout(watchdog); console.error(error); process.exitCode = 1; },
  );
}

module.exports = { verifyBunJoseBuilds };
