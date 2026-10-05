import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startPodContractServer, type PodContractServer } from './support/podContractServer';
import { MountCleanupGuard } from './support/mountCleanup';
import { discoverAgentFsHelper } from './support/helperDiscovery';

const helper = discoverAgentFsHelper();
const helperPresent = Boolean(helper.helperPath);
const runMount = helperPresent && process.env.XPOD_AGENTFS_RUN_MOUNT === '1';

const INSTALLED_CLI = process.env.XPOD_AGENTFS_TEST_CLI;
// Source fallback exercises the exact same command/parser path when no installed
// binary is provided; the installed binary is what root's RC actually ships.
const CLI = INSTALLED_CLI ? [ INSTALLED_CLI ] : [ 'bun', path.resolve('src/cli/index.ts') ];

const ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test/installed-cli-mount');
const TOKEN = 'installed-cli-token';
const cleanup = new MountCleanupGuard();
let primaryFailure: unknown;

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): CliRun {
  const result = spawnSync(CLI[0], [ ...CLI.slice(1), ...args ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

/** Spawn the CLI with piped stdout/stderr, exactly like a capturing operator. */
function spawnCaptured(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(CLI[0], [ ...CLI.slice(1), ...args ], {
    cwd: process.cwd(),
    stdio: [ 'ignore', 'pipe', 'pipe' ],
    env: { ...process.env, ...env },
  });
}

/** Wait for the process to close while draining both capture pipes. */
function waitForClose(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, timedOut: boolean): void => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => { finish(null, true); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { stderr += error.message; finish(null, false); });
    child.on('close', (code) => finish(code, false));
  });
}

/**
 * Minimal OIDC discovery + client-credentials token endpoint. Lets a real
 * installed CLI mount run without any operator credentials: the loopback auth
 * proxy obtains a local token and forwards the reviewed Pod contract server.
 */
async function startOidcStub(accessToken: string): Promise<{ origin: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    if (request.url === '/.well-known/openid-configuration') {
      const address = server.address() as AddressInfo;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${address.port}/token` }));
      return;
    }
    if (request.url === '/token' && request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}/`,
    requests,
    close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))); },
  };
}

async function writeCredentials(solidHome: string, oidcOrigin: string, webId: string): Promise<void> {
  const authDir = path.join(solidHome, 'auth');
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, 'credentials.json'), `${JSON.stringify({
    url: oidcOrigin,
    webId,
    authType: 'client_credentials',
    secrets: { clientId: 'local-client', clientSecret: 'local-secret' },
  }, null, 2)}\n`, 'utf8');
}

describe('agent-fs parser accepts --mountpoint (strict yargs)', () => {
  beforeAll(async () => {
    cleanup.assertAbsent(ROOT);
    await cleanup.remove(ROOT, primaryFailure);
    await mkdir(ROOT, { recursive: true });
  });

  afterAll(async () => {
    await cleanup.remove(ROOT, primaryFailure);
  });

  it('declares --mountpoint on mount and rejects an undeclared option', () => {
    const help = runCli([ 'agent-fs', 'mount', '--help' ]);
    expect(help.stdout).toContain('--mountpoint');
    expect(help.stderr).not.toContain('Unknown argument');

    const bogus = runCli([ 'agent-fs', 'mount', '--definitely-not-declared', 'x' ]);
    expect(`${bogus.stdout}${bogus.stderr}`).toMatch(/Unknown arguments?:/);
  });

  it('runs unmount --mountpoint through the real parser without an unknown-argument failure', async () => {
    const dir = await mkdtemp(path.join(ROOT, 'parse-'));
    await mkdir(path.join(dir, 'session'), { recursive: true });
    let primary: unknown;
    try {
      const result = runCli([
        'agent-fs', 'unmount',
        '--mountpoint', path.join(dir, 'mnt'),
        '--session-dir', path.join(dir, 'session'),
      ], { SOLID_HOME: path.join(dir, 'empty-auth') });
      expect(`${result.stdout}${result.stderr}`).not.toContain('Unknown argument');
    } catch (error) { primary = error; throw error; } finally {
      await cleanup.remove(dir, primary);
    }
  });
});

describe.runIf(runMount)('installed CLI mount releases its capture pipes without an unmount', () => {
  let server: PodContractServer;
  let oidc: Awaited<ReturnType<typeof startOidcStub>>;
  const sessionDirs: string[] = [];
  const owned: { mountpoint: string; sessionDir: string; childPID?: number }[] = [];

  async function mount(useDefaultMountpoint: boolean): Promise<{ result: Awaited<ReturnType<typeof waitForClose>>; sessionDir: string; mountpoint: string }> {
    cleanup.assertAbsent(ROOT);
    const caseDir = await mkdtemp(path.join(ROOT, 'case-'));
    sessionDirs.push(caseDir);
    const sessionDir = path.join(caseDir, 'session');
    const explicitMountpoint = path.join(caseDir, 'explicit-mnt');
    await mkdir(sessionDir, { recursive: true });
    const solidHome = path.join(caseDir, 'solid-home');
    await writeCredentials(solidHome, oidc.origin, `${server.origin}/pod/profile/card#me`);

    const args = [
      'agent-fs', 'mount',
      '--pod-root', server.podRoot,
      '--backend', 'nfs',
      '--session-dir', sessionDir,
      ...(useDefaultMountpoint ? [] : [ '--mountpoint', explicitMountpoint ]),
    ];
    const child = spawnCaptured(args, { SOLID_HOME: solidHome });
    const mountpoint = useDefaultMountpoint ? path.join(sessionDir, 'mnt') : explicitMountpoint;
    owned.push({ mountpoint, sessionDir, childPID: child.pid });
    // Deliberately do NOT unmount here: with the stdio-lifetime bug the CLI
    // never emits EOF while its persistent proxy holds the capture pipe.
    const result = await waitForClose(child, 45_000);
    return { result, sessionDir, mountpoint };
  }

  afterEach(async context => {
    if (context.task.result?.state === 'fail') primaryFailure ??= context.task.result;
    let secondary: unknown;
    for (const { mountpoint, sessionDir, childPID } of owned.splice(0)) {
      try {
        await cleanup.unmount(mountpoint, async () => runCli([ 'agent-fs', 'unmount', '--mountpoint', mountpoint, '--session-dir', sessionDir ]),
          { mountpoint, sessionDir, childPID: String(childPID ?? 'unavailable') }, primaryFailure ?? secondary);
      } catch (error) { secondary ??= error; }
    }
    for (const dir of sessionDirs.splice(0)) {
      try { await cleanup.remove(dir, primaryFailure ?? secondary); } catch (error) { secondary ??= error; }
    }
    if (secondary !== undefined) { primaryFailure ??= secondary; throw secondary; }
  });

  afterAll(async () => {
    await oidc?.close();
    await server?.close();
    await cleanup.remove(ROOT, primaryFailure);
  });

  beforeAll(async () => {
    cleanup.assertAbsent(ROOT);
    await cleanup.remove(ROOT, primaryFailure);
    await mkdir(ROOT, { recursive: true });
  });

  it('returns code0 with piped stdio, then mounts/reads and cleans up', async () => {
    cleanup.assertAbsent(ROOT);
    const caseDir = await mkdtemp(path.join(ROOT, 'fixture-'));
    sessionDirs.push(caseDir);
    server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': 'INSTALLED_BODY_0123456789\n' } });
    oidc = await startOidcStub(TOKEN);

    const { result, sessionDir, mountpoint } = await mount(false);
    expect(result.timedOut, `mount did not release its capture pipes: stdout=${result.stdout} stderr=${result.stderr}`).toBe(false);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);

    const entries = (await readdir(mountpoint)).sort();
    expect(entries).toContain('alpha.txt');
    expect(await readFile(path.join(mountpoint, 'alpha.txt'), 'utf8')).toBe('INSTALLED_BODY_0123456789\n');

    // The persistent proxy's diagnostics live in a private session log and must
    // never contain the per-mount capability.
    const control = JSON.parse(await readFile(path.join(sessionDir, 'proxy.json'), 'utf8')) as { capability: string };
    const log = await readFile(path.join(sessionDir, 'proxy.log'), 'utf8').catch(() => '');
    expect(log).not.toContain(control.capability);
  }, 90_000);

  it('also returns code0 with the default mountpoint', async () => {
    if (!server) {
      server = await startPodContractServer({ token: TOKEN, files: { 'alpha.txt': 'DEFAULT_BODY\n' } });
    }
    if (!oidc) {
      oidc = await startOidcStub(TOKEN);
    }
    const { result, mountpoint } = await mount(true);
    expect(result.timedOut, `default mountpoint did not release its capture pipes: stdout=${result.stdout} stderr=${result.stderr}`).toBe(false);
    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    const entries = await readdir(mountpoint);
    expect(entries.length).toBeGreaterThan(0);
  }, 90_000);
});

describe.skipIf(runMount)('installed CLI mount acceptance (gated)', () => {
  it('is opt-in because a real NFS mount must be cleaned up explicitly (set XPOD_AGENTFS_RUN_MOUNT=1)', () => {
    expect(runMount).toBe(false);
  });
});
