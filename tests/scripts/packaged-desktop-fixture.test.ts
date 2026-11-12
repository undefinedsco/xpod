import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { assertBundledRuntimeProcess, createPackagedFixtureEnvironment,
  assertOwnedRuntimeProfile, isMissingProcessReport, readProcessInventory,
  rememberProcessTree, remainingOwnedProcessIds, closeOwnedPackagedApp,
  isLaunchSubphase, expectedOwnedRuntimeArgv } from '../../scripts/helpers/packaged-desktop-fixture';

describe('owned packaged desktop permission fixture', () => {
  it('uses the captured OS process when close disposes the Electron channel', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    let closed = false;
    const app = {
      process: () => {
        if (closed) throw new Error('Disposed Electron dispatcher');
        return child;
      },
      close: async () => {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM'); await exited; closed = true;
      },
    };
    const captured = app.process();
    try {
      await closeOwnedPackagedApp(app, captured);
      expect(closed).toBe(true);
      expect(captured.exitCode !== null || captured.signalCode !== null).toBe(true);
      expect((await readProcessInventory()).some(row => row.pid === captured.pid)).toBe(false);
      expect(() => app.process()).toThrow('Disposed Electron dispatcher');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM'); await exited;
      }
    }
  });
  it('does not treat a resolved close channel as proof that the captured process stopped', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      await expect(closeOwnedPackagedApp({ close: async () => undefined }, child))
        .rejects.toThrow('Owned packaged App did not stop');
    } finally {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM'); await exited;
    }
  });
  it('keeps only host transport and standard runtime inputs, never inherited credentials or overrides', () => {
    const env = createPackagedFixtureEnvironment({
      inherited: { PATH: '/bin', HOME: '/Users/test', HTTP_PROXY: 'http://127.0.0.1:7897',
        XPOD_RUNTIME_COMMAND: '/other/runtime', XPOD_ENV_FILE: '/other/.env',
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/other/transpiler-cache',
        CSS_ROOT_FILE_PATH: '/other/data', OPENAI_API_KEY: 'private', XPOD_ACCEPTED_SHA: 'private' },
      profile: '/task/.test-data/profile', port: 41234, issuer: 'https://id.example/',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/Users/test');
    expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe('/task/.test-data/profile/bun-transpiler-cache');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
    expect(env.XPOD_RUNTIME_COMMAND).toBeUndefined();
    expect(env.XPOD_ENV_FILE).toBeUndefined();
    expect(env.CSS_ROOT_FILE_PATH).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.XPOD_ACCEPTED_SHA).toBeUndefined();
    expect(env.XPOD_PORT).toBe('41234');
    expect(env.XPOD_DESKTOP_USER_DATA_DIR).toBe('/task/.test-data/profile');
    expect(env.SOLID_OIDC_ISSUER).toBe('https://id.example/');
    expect(env.XPOD_DESKTOP_URL).toBe('http://127.0.0.1:41234/device/services');
    expect(env.XPOD_AI_CLIENT_CONFIGURATION_ENABLED).toBe('true');
    expect(env.XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR).toBe('/task/.test-data/profile/client-config-home');
    expect(env.XPOD_AI_CLIENT_CONFIGURATION_BACKUP_ROOT).toBe('/task/.test-data/profile/client-config-backups');
  });
  it('rejects invalid authority and ports before starting an App', () => {
    for (const issuer of ['file:///tmp/private', 'https://user:pass@id.example/', 'https://id.example/?x=1', 'https://id.example/#me']) {
      expect(() => createPackagedFixtureEnvironment({ inherited: {}, profile: '/task/profile', port: 41234, issuer })).toThrow();
    }
    for (const port of [0, 65536, 1.5, Number.NaN]) {
      expect(() => createPackagedFixtureEnvironment({ inherited: {}, profile: '/task/profile', port, issuer: 'https://id.example/' })).toThrow();
    }
  });
  it('requires the desktop-owned live process to execute exactly the extracted binary', () => {
    // Build the expectation from the PRODUCT factory, never a hand-written flag
    // list, so this test cannot drift from what RuntimeManager really spawns.
    const binary = '/task/Xpod.app/Contents/Resources/runtime/bin/bun';
    const entry = '/task/Xpod.app/Contents/Resources/runtime/node_modules/@undefineds.co/xpod-cli/dist/xpod.mjs';
    const env = { XPOD_EDITION: 'local' };
    const expected = expectedOwnedRuntimeArgv({ command: binary, args: [entry, 'start'],
      targetOrigin: 'http://127.0.0.1:41987/', env });
    const owned = expected.join(' ');
    // The product's own flags include a value containing no spaces; spaces are
    // normalised, so a valid launch with padded spacing is still accepted.
    expect(() => assertBundledRuntimeProcess({ binary, pid: 42, ownership: 'desktop',
      command: `  ${expected.join('   ')}  `, expectedArgv: expected })).not.toThrow();

    for (const value of [
      { pid: 42, ownership: 'external', command: owned },
      { pid: undefined, ownership: 'desktop', command: owned },
      // foreign entry with the SAME basename is not the installed entry
      { pid: 42, ownership: 'desktop', command: owned.replace(entry, '/tmp/foreign/xpod.mjs') },
      // prefix-similar binary is not this binary
      { pid: 42, ownership: 'desktop', command: owned.replace(binary, `${binary}-other`) },
      // the entry missing entirely (bare bun start)
      { pid: 42, ownership: 'desktop', command: `${binary} start` },
      // missing the start subcommand
      { pid: 42, ownership: 'desktop', command: `${binary} ${entry}` },
      // an extra/disallowed argument the product would never add
      { pid: 42, ownership: 'desktop', command: `${owned} --forbidden` },
      // the rejected legacy flag must not be accepted
      { pid: 42, ownership: 'desktop', command: `${owned} --foreground` },
    ]) expect(() => assertBundledRuntimeProcess({ binary, ...value, expectedArgv: expected })).toThrow();
  });
  it('does not equate transient/tool/permission failures with a missing PID', () => {
    expect(isMissingProcessReport({ code: 1, stdout: '', stderr: '' })).toBe(true);
    for (const report of [{ code: 'ENOENT', stdout: '', stderr: '' },
      { code: 1, stdout: '', stderr: 'permission denied' }, { code: 2, stdout: '', stderr: '' },
      { code: 1, stdout: 'partial', stderr: '' }, new Error('transient')]) {
      expect(isMissingProcessReport(report)).toBe(false);
    }
  });
  it('retains recorded children after their parent exits and refuses residual cleanup', () => {
    const owned = new Map();
    rememberProcessTree([{ pid: 10, ppid: 1, startedAt: 'parent-start' },
      { pid: 11, ppid: 10, startedAt: 'child-start' }, { pid: 12, ppid: 11, startedAt: 'grandchild-start' },
      { pid: 99, ppid: 1, startedAt: 'user-process' }], 10, owned);
    expect(remainingOwnedProcessIds(owned, [{ pid: 12, ppid: 1, startedAt: 'grandchild-start' },
      { pid: 99, ppid: 1, startedAt: 'user-process' }])).toEqual([12]);
    expect(remainingOwnedProcessIds(owned, [{ pid: 12, ppid: 1, startedAt: 'reused-pid' }])).toEqual([]);
  });
  it('requires actual launcher-generated storage paths to stay in the own profile', () => {
    const profile = '/task/profile';
    const lines = [`CSS_IDENTITY_DB_URL=sqlite:${path.join(profile, 'identity.sqlite')}`,
      `CSS_SPARQL_ENDPOINT=sqlite:${path.join(profile, 'quadstore.sqlite')}`,
      `CSS_RDF_INDEX_PATH=${path.join(profile, 'rdf-index.sqlite')}`,
      `CSS_ROOT_FILE_PATH=${path.join(profile, 'data')}`];
    expect(() => assertOwnedRuntimeProfile(lines.join('\n'), profile)).not.toThrow();
    expect(() => assertOwnedRuntimeProfile(lines.slice(1).join('\n'), profile)).toThrow();
    expect(() => assertOwnedRuntimeProfile(lines.join('\n') + '\nCSS_ROOT_FILE_PATH=/user/data', profile)).toThrow();
  });
  it('observes a real reparented child remaining after its owned parent stops', async () => {
    const parent = spawn(process.execPath, ['-e',
      'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000);'],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
    const owned = new Map<number, string>();
    let childPid: number | undefined;
    try {
      childPid = await new Promise<number>((resolve, reject) => {
        let output = '';
        parent.stdout!.on('data', chunk => {
          output += String(chunk);
          const match = output.match(/^(\d+)\r?\n/u);
          if (match) resolve(Number(match[1]));
        });
        parent.once('error', reject);
        parent.once('exit', () => reject(new Error('Process fixture exited before readiness')));
      });
      rememberProcessTree(await readProcessInventory(), parent.pid!, owned);
      expect(owned.has(childPid)).toBe(true);
      const exited = new Promise(resolve => parent.once('exit', resolve));
      parent.kill('SIGTERM'); await exited;
      expect(remainingOwnedProcessIds(owned, await readProcessInventory())).toContain(childPid);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        const exited = new Promise(resolve => parent.once('exit', resolve));
        parent.kill('SIGTERM'); await exited;
      }
      if (childPid !== undefined) {
        const live = await readProcessInventory();
        if (remainingOwnedProcessIds(owned, live).includes(childPid)) process.kill(childPid, 'SIGTERM');
      }
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && remainingOwnedProcessIds(owned, await readProcessInventory()).length) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(remainingOwnedProcessIds(owned, await readProcessInventory())).toEqual([]);
    }
  }, 10_000);
});

describe('launch subphase diagnostics', () => {
  it('accepts only the closed literal enum and never coerces arbitrary text', () => {
    // Every reviewed token is accepted.
    for (const phase of ['install', 'archive-hash', 'version', 'native-version', 'electron',
      'window', 'gateway', 'service-info', 'bridge', 'profile']) {
      expect(isLaunchSubphase(phase)).toBe(true);
    }
    // Anything else - including plausible-looking but unreviewed values - is refused.
    for (const bad of ['unknown', 'INSTALL', 'install ', '', 'launch', 'win\u0000dow',
      '/Users/someone/secret', 'http://127.0.0.1:1/', '--token=abc', null, undefined, 1, {}, []]) {
      expect(isLaunchSubphase(bad)).toBe(false);
    }
  });

  it('rejects injection attempts aimed at the phase field', () => {
    // A value that would leak a path, URL, argument or message must not pass.
    const injections = [
      '{"stage":"launch","phase":"install","error":"secret"}',
      'install"; DROP TABLE x; --',
      '\\n{"phase":"window"}',
      'ghp_' + 'a'.repeat(36),
      'C:\\Users\\runner\\secret',
    ];
    for (const value of injections) expect(isLaunchSubphase(value)).toBe(false);
  });

  it('keeps the phase vocabulary immutable', () => {
    // The guard must not be satisfiable by mutating a shared store.
    const before = isLaunchSubphase('install');
    expect(() => { (globalThis as any).__phase = 'injected'; }).not.toThrow();
    expect(isLaunchSubphase('install')).toBe(before);
    expect(isLaunchSubphase('injected')).toBe(false);
  });
});

describe('launch subphase boundary placement', () => {
  it('declares the bridge and profile phases the fixture actually emits', async () => {
    // Guard against a phase being declared but never emitted (the RC410 review
    // caught exactly that). Read the fixture source: every non-optional phase
    // must appear inside an emitSubphase(...) call.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../scripts/helpers/packaged-desktop-fixture.ts', import.meta.url), 'utf8');
    for (const phase of ['install', 'archive-hash', 'version', 'native-version', 'electron',
      'window', 'gateway', 'service-info', 'bridge', 'profile']) {
      expect(source.includes(`emitSubphase(options, '${phase}')`)).toBe(true);
    }
    // bridge is emitted immediately before the bridge evaluate, and profile right
    // before the actual profile assertion - not merely somewhere earlier.
    const bridgeAt = source.indexOf("emitSubphase(options, 'bridge')");
    const evaluateAt = source.indexOf('await page.evaluate');
    const profileAt = source.indexOf("emitSubphase(options, 'profile')");
    const assertAt = source.indexOf('await assertOwnedRuntimeProfile');
    expect(bridgeAt).toBeGreaterThan(0);
    expect(bridgeAt).toBeLessThan(evaluateAt);
    expect(profileAt).toBeGreaterThan(0);
    expect(profileAt).toBeLessThan(assertAt);
  });
});
