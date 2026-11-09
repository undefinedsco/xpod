// Run against an installed JS package, never against repository dependencies.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const AUTH_PROBE_DEADLINE_MS = 30_000;
const AUTH_PROBE_SUBPROCESS_MS = 10_000;
const AUTH_PROBE_STAGES = Object.freeze(["bootstrap", "factory-load", "factory-init-config", "factory-routes", "session-cookie", "caller-resolution", "callback-setup", "callback-cleanup-await", "callback-cleanup-release", "callback-cleanup-complete", "complete", "root-bun-jose-cjs-resolve", "root-bun-jose-cjs-keygen", "root-bun-jose-cjs-export", "root-bun-jose-esm-start", "root-bun-jose-esm-resolve", "root-bun-jose-esm-keygen", "root-bun-jose-esm-export", "root-bun-jose-esm-complete", "root-rs256-keygen", "root-rs256-export", "root-rs256-import", "root-rs256-sign", "root-rs256-verify", "root-rs256-reject", "openid-bun-jose-cjs-resolve", "openid-bun-jose-cjs-keygen", "openid-bun-jose-cjs-export", "openid-bun-jose-esm-start", "openid-bun-jose-esm-resolve", "openid-bun-jose-esm-keygen", "openid-bun-jose-esm-export", "openid-bun-jose-esm-complete", "openid-rs256-keygen", "openid-rs256-export", "openid-rs256-import", "openid-rs256-sign", "openid-rs256-verify", "openid-rs256-reject"]);
const stageTokens = new Set(AUTH_PROBE_STAGES);
function createProbeDiagnostics({ write = line => process.stderr.write(line), now = () => performance.now() } = {}) {
  const started = now(); let stage = 'bootstrap';
  const record = errorClass => {
    const elapsed = now() - started;
    const elapsedMs = Number.isFinite(elapsed) ? Math.max(0, Math.min(AUTH_PROBE_DEADLINE_MS, Math.floor(elapsed))) : 0;
    write(JSON.stringify({ kind: 'packaged-auth-probe-stage', stage, elapsedMs, ...(errorClass ? { errorClass } : {}) }) + '\n');
  };
  return Object.freeze({
    mark(value) { if (!stageTokens.has(value)) throw new TypeError('Invalid auth probe diagnostic stage'); stage = value; record(); },
    failed(error) {
      const allowed = ['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError', 'TimeoutError'];
      let name = 'Error'; try { const candidate = error?.name; if (error?.code === 'ETIMEDOUT') name = 'TimeoutError'; else if (allowed.includes(candidate)) name = candidate; } catch {}
      record(name);
    },
    timedOut() { record('TimeoutError'); },
  });
}
const probeDiagnostics = createProbeDiagnostics();
function relayChildStages(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) return;
  for (const line of bytes.toString('utf8').split('\n')) {
    try { const value = JSON.parse(line);
      if (value.kind === 'packaged-auth-probe-stage' && stageTokens.has(value.stage)
        && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= AUTH_PROBE_SUBPROCESS_MS)
        probeDiagnostics.mark(value.stage);
    } catch {}
  }
}

async function verifyBunJoseBuilds(caller, packageRoot, scope = 'root') {
  if (!['root', 'openid'].includes(scope)) throw new TypeError('Invalid JOSE diagnostic scope');
  probeDiagnostics.mark(scope + '-bun-jose-cjs-resolve');
  const load = createRequire(caller);
  // The patched Bun condition selects Node CJS for require and Node ESM for import.
  assert.match(load.resolve('jose').replace(/\\/gu, '/'), /\/dist\/node\/cjs\/index\.js$/u);
  const { generateKeyPair, exportJWK } = load('jose');
  probeDiagnostics.mark(scope + '-bun-jose-cjs-keygen');
  const { privateKey } = await generateKeyPair('ES256');
  probeDiagnostics.mark(scope + '-bun-jose-cjs-export');
  assert.equal((await exportJWK(privateKey)).kty, 'EC');
  probeDiagnostics.mark(scope + '-bun-jose-esm-start');
  try {
  const child = execFileSync(process.execPath, ['--no-install', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const started = performance.now();
    const mark = part => process.stdout.write(JSON.stringify({ kind:'packaged-auth-probe-stage',stage:${JSON.stringify(scope)}+'-bun-jose-esm-'+part,elapsedMs:Math.max(0,Math.min(${AUTH_PROBE_SUBPROCESS_MS},Math.floor(performance.now()-started))) })+'\\n');
    mark('resolve');
    const resolved = fileURLToPath(import.meta.resolve('jose'));
    assert(resolved.startsWith(${JSON.stringify(packageRoot)} + path.sep), 'ESM JOSE escaped the installed artifact');
    assert.match(resolved.split(path.sep).join('/'), /\\/dist\\/node\\/esm\\/index\\.js$/u);
    const { generateKeyPair, exportJWK } = await import('jose');
    mark('keygen');
    const { privateKey } = await generateKeyPair('ES256');
    mark('export');
    assert.equal((await exportJWK(privateKey)).kty, 'EC');
    mark('complete');
  `], { cwd: path.dirname(caller), env: { ...process.env, NODE_PATH: '' }, timeout: AUTH_PROBE_SUBPROCESS_MS, stdio: ['pipe', 'pipe', 'pipe'] });
  // Successful child diagnostics are retained through the same bounded channel.
  relayChildStages(child);
  } catch (error) { relayChildStages(error?.stdout); throw error; }
}

async function main() {
  probeDiagnostics.mark('bootstrap');
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
  probeDiagnostics.mark('factory-load');
  const { IdentityProviderFactory } = load(path.join(css, 'dist/identity/configuration/IdentityProviderFactory.js'));
  const { IdInteractionRoute } = load(path.join(css, 'dist/identity/interaction/routing/IdInteractionRoute.js'));
  const hook = async () => true;
  const factory = new IdentityProviderFactory({ issueRefreshToken: hook }, {
    baseUrl: 'https://id.example/', oidcPath: '/.oidc',
    interactionRoute: new IdInteractionRoute({ getPath: () => 'https://id.example/interaction/' }, 'interactionId'),
  });
  factory.generateCookieKeys = async () => ['packaged-test-key'];
  probeDiagnostics.mark('factory-init-config');
  const config = await factory.initConfig({ alg: 'RS256' });
  assert.equal(config.issueRefreshToken, hook);
  probeDiagnostics.mark('factory-routes');
  factory.configureRoutes(config);
  assert.equal(await config.interactions.url({}, { uid: 'first-authorization' }), 'https://id.example/interaction/first-authorization/');

  probeDiagnostics.mark('session-cookie');
  const providerRoot = path.dirname(path.dirname(load.resolve('oidc-provider')));
  const { default: sessionHandler } = await import(pathToFileURL(path.join(providerRoot, 'lib/shared/session.js')).href);
  let headers = ['session=remembered'];
  await sessionHandler({
    oidc: { provider: { Session: { get: async () => ({ new: true, transient: false, exp: 2_000_000_000 }) }, cookieName: () => 'session' } },
    response: { get: () => [...headers], set: (_name, value) => { headers = value; } },
  }, async () => {});
  assert.match(headers[0], /; expires=/, 'remembered cookie updates must survive copy-on-read headers');

  probeDiagnostics.mark('caller-resolution');
  for (const caller of ['@inrupt/solid-client-authn-node', '@inrupt/oidc-client-ext', '@solid/access-token-verifier']) {
    const callerLoad = createRequire(load.resolve(caller));
    assert.equal(callerLoad.resolve('jose'), load.resolve('jose'), `${caller} must resolve patched jose`);
    if (caller.startsWith('@inrupt/')) assert.equal(callerLoad.resolve('@inrupt/solid-client-authn-core'), load.resolve('@inrupt/solid-client-authn-core'), `${caller} must resolve patched core`);
  }
  const openidLoad = createRequire(load.resolve('openid-client'));
  assert(openidLoad.resolve('jose').startsWith(`${packageRoot}${path.sep}`), 'openid-client must retain its bundled jose version');
  if (process.versions.bun) {
    await verifyBunJoseBuilds(path.join(packageRoot, 'package.json'), packageRoot, 'root');
    await verifyBunJoseBuilds(load.resolve('openid-client'), packageRoot, 'openid');
  }
  for (const [index, scopedLoad] of [load, openidLoad].entries()) {
    const scope = index === 0 ? 'root' : 'openid';
    probeDiagnostics.mark(scope + '-rs256-keygen');
    const jose = scopedLoad('jose'); // Must be synchronously loadable by its actual callers.
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    probeDiagnostics.mark(scope + '-rs256-export');
    const publicJwk = await jose.exportJWK(publicKey);
    probeDiagnostics.mark(scope + '-rs256-import');
    const verificationKey = await jose.importJWK(publicJwk, 'RS256');
    probeDiagnostics.mark(scope + '-rs256-sign');
    const token = await new jose.SignJWT({ fixture: 'packaged-auth' })
      .setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
    probeDiagnostics.mark(scope + '-rs256-verify');
    const { payload } = await jose.jwtVerify(token, verificationKey, { algorithms: ['RS256'] });
    assert.equal(payload.fixture, 'packaged-auth');
    probeDiagnostics.mark(scope + '-rs256-reject');
    await assert.rejects(jose.jwtVerify(token, verificationKey, { algorithms: ['ES256'] }));
  }
  probeDiagnostics.mark('callback-setup');
  const { Session } = load('@inrupt/solid-client-authn-browser');
  const { EVENTS } = load('@inrupt/solid-client-authn-core');
  const session = new Session({ clientAuthentication: {
    handleIncomingRedirect: async (_url, events) => { events.emit(EVENTS.ERROR, 'fixture'); return undefined; },
  } });
  let release;
  let finished = false;
  session.internalLogout = () => new Promise((resolve) => { release = resolve; });
  probeDiagnostics.mark('callback-cleanup-await');
  const callback = session.handleIncomingRedirect('https://app.example/callback').then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, 'callback must await failed-session cleanup');
  assert.equal(typeof release, 'function');
  probeDiagnostics.mark('callback-cleanup-release');
  release();
  await callback;
  probeDiagnostics.mark('callback-cleanup-complete');
  assert.equal(finished, true);
  probeDiagnostics.mark('complete');
  console.log('packaged authentication: scoped interaction, refresh hook, remembered cookie, callback cleanup passed');
}
if (require.main === module) {
  const watchdog = setTimeout(() => {
    probeDiagnostics.timedOut();
    process.exit(1);
  }, AUTH_PROBE_DEADLINE_MS);
  main().then(
    () => clearTimeout(watchdog),
    (error) => { clearTimeout(watchdog); probeDiagnostics.failed(error); process.exitCode = 1; },
  );
}

module.exports = { verifyBunJoseBuilds, createProbeDiagnostics, probeDiagnostics, AUTH_PROBE_STAGES, AUTH_PROBE_DEADLINE_MS, AUTH_PROBE_SUBPROCESS_MS };
