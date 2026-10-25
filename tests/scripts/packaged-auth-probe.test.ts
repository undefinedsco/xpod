import { afterEach, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const load = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it.each([
  ['matching import/require builds', 'node/cjs', 'node/esm', true],
  ['ESM selected by require', 'node/esm', 'node/esm', false],
  ['CJS selected by import', 'node/cjs', 'node/cjs', false],
  ['browser selected by import', 'node/cjs', 'browser', false],
] as const)('validates the packaged JOSE contract: %s', (_name, requireBuild, importBuild, passes) => {
  const base = path.resolve('.test-data/packaged-auth-probe');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  roots.push(root);
  const jose = path.join(root, 'node_modules/jose');
  cpSync(path.dirname(load.resolve('jose/package.json')), jose, { recursive: true });
  const manifestPath = path.join(jose, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.exports['.'].bun = {
    import: `./dist/${importBuild}/index.js`,
    require: `./dist/${requireBuild}/index.js`,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const caller = path.join(root, 'package.json');
  writeFileSync(caller, '{}');
  const probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  const child = spawnSync('bun', ['--no-env-file', '--no-install', '-e', `
    const { verifyBunJoseBuilds } = require(${JSON.stringify(probe)});
    await verifyBunJoseBuilds(${JSON.stringify(caller)}, ${JSON.stringify(root)});
  `], { encoding: 'utf8', timeout: 15_000 });
  expect(child.error).toBeUndefined();
  if (passes) expect(child.status, child.stderr).toBe(0);
  else {
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('AssertionError');
  }
}, 20_000);

function installedProbeFixture(options: { hang?: boolean; badCallback?: boolean } = {}) {
  const base = path.resolve('.test-data/packaged-auth-probe'); mkdirSync(base, { recursive: true });
  const consumer = mkdtempSync(path.join(base, 'diagnostic-')); roots.push(consumer);
  const artifact = path.join(consumer, 'node_modules/@undefineds.co/xpod');
  const put = (name: string, body: string) => { const file = path.join(artifact, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body); };
  put('package.json', JSON.stringify({ name: '@undefineds.co/xpod', version: '0.0.0-fixture', type: 'commonjs' }));
  cpSync(path.dirname(load.resolve('jose/package.json')), path.join(artifact, 'node_modules/jose'), { recursive: true });
  put('node_modules/@solid/community-server/package.json', '{"name":"@solid/community-server","type":"commonjs"}');
  put('node_modules/@solid/community-server/dist/identity/configuration/IdentityProviderFactory.js', `exports.IdentityProviderFactory=class {constructor(hooks,options){this.hooks=hooks;this.options=options;} async initConfig(){${options.hang ? 'return new Promise(()=>{});' : 'return {issueRefreshToken:this.hooks.issueRefreshToken};'}} configureRoutes(config){config.interactions={url:async(_ctx,{uid})=>this.options.interactionRoute.getPath()+uid+'/'};}};`);
  put('node_modules/@solid/community-server/dist/identity/interaction/routing/IdInteractionRoute.js', 'exports.IdInteractionRoute=class {constructor(value){this.value=value;}getPath(){return this.value.getPath();}};');
  put('node_modules/oidc-provider/package.json', '{"name":"oidc-provider","type":"module","main":"lib/index.js"}');
  put('node_modules/oidc-provider/lib/index.js', 'export default {};');
  put('node_modules/oidc-provider/lib/shared/session.js', "export default async function(ctx,next){const headers=ctx.response.get();headers[0]+='; expires=fixed';ctx.response.set('set-cookie',headers);await next();}");
  for (const name of ['@inrupt/solid-client-authn-node', '@inrupt/oidc-client-ext', '@solid/access-token-verifier', 'openid-client']) {
    put('node_modules/' + name + '/package.json', JSON.stringify({ name, main: 'index.js', type: 'commonjs' })); put('node_modules/' + name + '/index.js', 'module.exports={};');
  }
  put('node_modules/@inrupt/solid-client-authn-core/package.json', '{"name":"@inrupt/solid-client-authn-core","main":"index.js","type":"commonjs"}');
  put('node_modules/@inrupt/solid-client-authn-core/index.js', "exports.EVENTS={ERROR:'error'};");
  put('node_modules/@inrupt/solid-client-authn-browser/package.json', '{"name":"@inrupt/solid-client-authn-browser","main":"index.js","type":"commonjs"}');
  put('node_modules/@inrupt/solid-client-authn-browser/index.js', `const {EventEmitter}=require('node:events');exports.Session=class {constructor(options){this.options=options;}async handleIncomingRedirect(url){let cleanup;const events=new EventEmitter();events.on('error',()=>{cleanup=this.internalLogout();});await this.options.clientAuthentication.handleIncomingRedirect(url,events);${options.badCallback ? '' : 'await cleanup;'}}};`);
  return artifact;
}
function diagnosticEvents(stderr: string) {
  return stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
}
it('keeps the complete successful assertion chain and reports both actual JOSE caller scopes', () => {
  // The provider/session are controlled fixtures; crypto and the original probe
  // assertions execute. This is a probe test, not installed-product acceptance.
  const artifact = installedProbeFixture(), probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  for (const runtime of ['node', 'bun']) {
    const result = spawnSync(runtime, [probe, artifact], { encoding: 'utf8', timeout: 35_000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('packaged authentication: scoped interaction, refresh hook, remembered cookie, callback cleanup passed');
    const stages = diagnosticEvents(result.stderr).map(event => event.stage);
    for (const stage of ['factory-init-config', 'factory-routes', 'session-cookie', 'root-rs256-keygen', 'root-rs256-reject', 'openid-rs256-keygen', 'openid-rs256-reject', 'callback-cleanup-await', 'callback-cleanup-complete', 'complete']) expect(stages).toContain(stage);
    if (runtime === 'bun') for (const scope of ['root', 'openid']) for (const part of ['cjs-resolve', 'cjs-keygen', 'cjs-export', 'esm-resolve', 'esm-keygen', 'esm-export', 'esm-complete']) expect(stages).toContain(scope + '-bun-jose-' + part);
  }
}, 40_000);
it('identifies a genuinely pending factory await with the unchanged production watchdog delay', () => {
  const artifact = installedProbeFixture({ hang: true }), probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  // Accelerate only this child's timer scheduler, after asserting the exact
  // production delay; the probe itself offers no configurable deadline.
  const program = `const assert=require('node:assert/strict');const timer=global.setTimeout;global.setTimeout=(callback,delay,...rest)=>{assert.equal(delay,30000);return timer(callback,20,...rest);};process.argv=[process.execPath,${JSON.stringify(probe)},${JSON.stringify(artifact)}];require('node:module')._load(${JSON.stringify(probe)},null,true);`;
  const result = spawnSync('node', ['-e', program], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(1); const events = diagnosticEvents(result.stderr), last = events.at(-1);
  expect(last.stage).toBe('factory-init-config'); expect(last.errorClass).toBe('TimeoutError');
  expect(last.elapsedMs).toBeLessThanOrEqual(30000); expect(result.stdout).not.toContain('callback cleanup passed');
});
it('preserves callback-cleanup failure assertions and emits only the fixed error class', () => {
  const artifact = installedProbeFixture({ badCallback: true }), probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  const result = spawnSync('node', [probe, artifact], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(1); const last = diagnosticEvents(result.stderr).at(-1);
  expect(last.stage).toBe('callback-cleanup-await'); expect(last.errorClass).toBe('AssertionError');
  expect(result.stderr).not.toContain(artifact); expect(result.stdout).not.toContain('callback cleanup passed');
});
it('whitelists stage/error tokens, bounds durations and never serializes exception payloads', () => {
  const { createProbeDiagnostics, AUTH_PROBE_DEADLINE_MS, AUTH_PROBE_SUBPROCESS_MS } = load(path.resolve('tests/scripts/packaged-auth-probe.cjs'));
  let clock = 0; const lines: string[] = [], diagnostics = createProbeDiagnostics({ write: (line: string) => lines.push(line), now: () => clock });
  diagnostics.mark('openid-rs256-sign'); clock = 1000000;
  diagnostics.failed({ name: 'secret-provider-body', message: 'token=private-key', stack: '/private/secret/path' });
  const text = lines.join(''), last = JSON.parse(lines.at(-1)!);
  expect(last).toMatchObject({ stage: 'openid-rs256-sign', elapsedMs: 30000, errorClass: 'Error' });
  for (const value of ['secret-provider-body', 'private-key', '/private/secret/path']) expect(text).not.toContain(value);
  expect(() => diagnostics.mark('/private/secret/path')).toThrow('Invalid auth probe diagnostic stage');
  let reads = 0;
  diagnostics.failed({ get name() { return reads++ === 0 ? 'Error' : 'secret-provider-body'; } });
  expect(lines.join('')).not.toContain('secret-provider-body');
  expect(AUTH_PROBE_DEADLINE_MS).toBe(30000); expect(AUTH_PROBE_SUBPROCESS_MS).toBe(10000);
});


it('relays the exact failing ESM stage without forwarding child stderr or installed paths', () => {
  const artifact = installedProbeFixture(), probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  const file = path.join(artifact, 'node_modules/jose/package.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.exports['.'].bun = { require: './dist/node/cjs/index.js', import: './dist/browser/index.js' };
  writeFileSync(file, JSON.stringify(manifest));
  const result = spawnSync('bun', [probe, artifact], { encoding: 'utf8', timeout: 15000 });
  expect(result.status).toBe(1); const last = diagnosticEvents(result.stderr).at(-1);
  expect(last.stage).toBe('root-bun-jose-esm-resolve'); expect(last.errorClass).toBe('Error');
  expect(result.stderr).not.toContain(artifact); expect(result.stderr).not.toContain('AssertionError');
});

it('retains the last legitimate error.stdout stage when sync ESM execution throws sensitive stderr', () => {
  const artifact = installedProbeFixture(), probe = path.resolve('tests/scripts/packaged-auth-probe.cjs');
  writeFileSync(path.join(artifact, 'node_modules/jose/dist/node/esm/index.js'), `
    export async function generateKeyPair(){process.stderr.write('SENSITIVE_PROVIDER_RAW_BODY');throw new Error('SENSITIVE_PRIVATE_KEY_TOKEN');}
    export async function exportJWK(){throw new Error('unreachable');}
  `);
  const result = spawnSync('bun', [probe, artifact], { encoding: 'utf8', timeout: 15000 });
  expect(result.status).toBe(1); const last = diagnosticEvents(result.stderr).at(-1);
  expect(last.stage).toBe('root-bun-jose-esm-keygen'); expect(last.errorClass).toBe('Error');
  for (const value of ['SENSITIVE_PROVIDER_RAW_BODY', 'SENSITIVE_PRIVATE_KEY_TOKEN', artifact]) {
    expect(result.stderr).not.toContain(value); expect(result.stdout).not.toContain(value);
  }
});
