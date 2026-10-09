import { installOwnedDesktop } from './packaged-desktop-installation';
import { execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from '@playwright/test';

const execute = promisify(execFile);
const { describeArchive } = createRequire(import.meta.url)('../desktop-permission-acceptance.cjs') as {
  describeArchive(file: string): Promise<{ size: number; sha256: string; sha512: string }>;
};

/** Avoid importing the caller's server profile or reusable authentication material. */
export function createPackagedFixtureEnvironment(options: {
  inherited: NodeJS.ProcessEnv; profile: string; port: number; issuer: string;
}): Record<string, string> {
  const issuer = new URL(options.issuer);
  if (!['http:', 'https:'].includes(issuer.protocol) || issuer.username || issuer.password
    || issuer.search || issuer.hash || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Invalid packaged fixture authority or port');
  }
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'SHELL', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = options.inherited[key];
    if (value !== undefined) env[key] = value;
  }
  return Object.assign(env, {
    NO_PROXY: [...new Set(['localhost', '127.0.0.1', '::1', ...(env.NO_PROXY ?? '').split(',').filter(Boolean)])].join(','),
    XPOD_PORT: String(options.port), XPOD_EDITION: 'local', SOLID_OIDC_ISSUER: issuer.href,
    XPOD_DESKTOP_ACCEPTANCE: '1', XPOD_DESKTOP_ALLOW_PARALLEL_ACCEPTANCE: '1',
    XPOD_DESKTOP_USER_DATA_DIR: options.profile,
    XPOD_BUN_SINGLE_CACHE_DIR: path.join(options.profile, 'runtime-cache'),
    // These existing API settings confine CLI configuration apply/rollback;
    // HOME remains the host's standard runtime input, not a configuration target.
    XPOD_AI_CLIENT_CONFIGURATION_ENABLED: 'true',
    XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR: path.join(options.profile, 'client-config-home'),
    XPOD_AI_CLIENT_CONFIGURATION_BACKUP_ROOT: path.join(options.profile, 'client-config-backups'),
    XPOD_DESKTOP_URL: `http://127.0.0.1:${options.port}/device/services`,
  });
}

export function assertBundledRuntimeProcess(input: {
  binary: string; command: string; pid?: number; ownership: string;
}): void {
  if (input.ownership !== 'desktop' || !Number.isSafeInteger(input.pid) || (input.pid ?? 0) < 1
    || input.command.trim() !== `${input.binary} start --foreground`) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function processCommand(pid: number): Promise<string | undefined> {
  try { return (await execute('/bin/ps', ['-p', String(pid), '-o', 'command='])).stdout.trim(); }
  catch (error) { if (isMissingProcessReport(error)) return undefined; throw error; }
}

export function isMissingProcessReport(error: unknown): boolean {
  const report = error as { code?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
  return report?.code === 1 && typeof report.stdout === 'string' && !report.stdout.trim()
    && typeof report.stderr === 'string' && !report.stderr.trim();
}

export interface ProcessIdentity { pid: number; ppid: number; startedAt: string }
/** Only process identities, never the user's argument or environment contents. */
export async function readProcessInventory(): Promise<ProcessIdentity[]> {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (!match) throw new Error('Incomplete process inventory');
    return { pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3] };
  });
}

export function rememberProcessTree(inventory: ProcessIdentity[], rootPid: number, owned: Map<number, string>): void {
  const active = new Set(inventory.filter(row => owned.get(row.pid) === row.startedAt).map(row => row.pid));
  if (!owned.size) {
    const root = inventory.find(row => row.pid === rootPid);
    if (!root) throw new Error('Missing owned App in process inventory');
    owned.set(root.pid, root.startedAt); active.add(root.pid);
  }
  let added = true;
  while (added) {
    added = false;
    for (const row of inventory) {
      if (!active.has(row.pid) && active.has(row.ppid)) {
        active.add(row.pid); owned.set(row.pid, row.startedAt); added = true;
      }
    }
  }
}

export function remainingOwnedProcessIds(owned: Map<number, string>, inventory: ProcessIdentity[]): number[] {
  return inventory.filter(row => owned.get(row.pid) === row.startedAt).map(row => row.pid);
}

export function assertOwnedRuntimeProfile(content: string, profile: string): void {
  const values = new Map(content.split('\n').filter(line => /^[A-Z_]+=/u.test(line))
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
  const expected = {
    CSS_IDENTITY_DB_URL: `sqlite:${path.join(profile, 'identity.sqlite')}`,
    CSS_SPARQL_ENDPOINT: `sqlite:${path.join(profile, 'quadstore.sqlite')}`,
    CSS_RDF_INDEX_PATH: path.join(profile, 'rdf-index.sqlite'),
    CSS_ROOT_FILE_PATH: path.join(profile, 'data'),
  };
  if (Object.entries(expected).some(([key, value]) => values.get(key) !== value)) {
    throw new Error('Packaged launcher data paths are not confined to its owned profile');
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

export interface OwnedPackagedDesktop {
  app: ElectronApplication;
  page: Page;
  gateway: string;
  directory: string;
  archive: { size: number; sha256: string; sha512: string };
  runtime: { version: string; edition: 'local'; ownership: 'desktop'; binarySha256: string;
    bundled: true; installed: true; noExternalOverride: true; freshEndpoint: true };
  close(): Promise<{ appStopped: true; runtimeStopped: true; ownedDataRemoved: true; remainingOwnedPids: 0 }>;
}

/** Keep process exit evidence independent of the disposed Playwright channel. */
export async function closeOwnedPackagedApp(app: Pick<ElectronApplication, 'close'>,
  captured: ChildProcess): Promise<void> {
  await app.close();
  if (captured.exitCode === null && captured.signalCode === null) {
    throw new Error('Owned packaged App did not stop');
  }
}

/** Real App + its packaged runtime, installed from DMG with its own application directory and profile.
 * It only establishes provenance/lifecycle; it cannot claim permissions or Chat passed.
 */
export async function launchOwnedPackagedDesktop(options: {
  archive: string; version: string; issuer: string; evidenceDirectory: string;
}): Promise<OwnedPackagedDesktop> {
  if (process.platform !== 'darwin') throw new Error('Packaged desktop acceptance requires macOS');
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+(?:\.\d+)?)?$/.test(options.version)) throw new Error('Invalid packaged version');
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(path.resolve(options.evidenceDirectory), 'owned-app-'));
  const archive = await describeArchive(options.archive);
  let installation: Awaited<ReturnType<typeof installOwnedDesktop>> | undefined;
  let appPath = '';
  let binary = '';
  let app: ElectronApplication | undefined;
  let appProcess: ChildProcess | undefined;
  let launchAttempted = false;
  let runtimePid: number | undefined;
  let closed = false;
  let observer: ReturnType<typeof setInterval> | undefined;
  let observation: Promise<void> | undefined;
  let observationFailed = false;
  const owned = new Map<number, string>();
  async function observeTree(): Promise<void> {
    const pid = appProcess?.pid;
    if (!pid) throw new Error('Missing owned App pid');
    rememberProcessTree(await readProcessInventory(), pid, owned);
  }
  async function close(): Promise<{ appStopped: true; runtimeStopped: true; ownedDataRemoved: true; remainingOwnedPids: 0 }> {
    if (closed) throw new Error('Packaged fixture was already closed');
    if (app) {
      await observeTree().catch(() => { observationFailed = true; });
      try {
        if (!appProcess) throw new Error('Missing captured owned App process');
        // Existing before-quit path stops only the desktop-owned runtime.
        await closeOwnedPackagedApp(app, appProcess);
      } finally {
        if (observer) clearInterval(observer);
        await observation;
      }
    }
    if (observer) clearInterval(observer);
    await observation;
    if (observationFailed) throw new Error('Owned process tree observation was incomplete');
    if (launchAttempted && runtimePid === undefined) {
      throw new Error('Cannot prove runtime cleanup before its owned process was identified');
    }
    if (runtimePid !== undefined) {
      await waitFor(async () => {
        const command = await processCommand(runtimePid!);
        return command !== `${binary} start --foreground` ? true : undefined;
      }, 'Owned packaged runtime did not stop');
    }
    const remaining = await waitFor(async () => {
      const ids = remainingOwnedProcessIds(owned, await readProcessInventory());
      return ids.length === 0 ? ids.length : undefined;
    }, 'Owned desktop child processes remain');
    await installation?.remove();
    await rm(directory, { recursive: true, force: true });
    closed = true;
    return { appStopped: true, runtimeStopped: true, ownedDataRemoved: true, remainingOwnedPids: remaining as 0 };
  }
  try {
    installation = await installOwnedDesktop(path.resolve(options.archive), directory);
    appPath = installation.appPath;
    binary = path.join(appPath, 'Contents', 'Resources', 'runtime', 'xpod');
    const afterExtract = await describeArchive(options.archive);
    if (JSON.stringify(afterExtract) !== JSON.stringify(archive)) throw new Error('Desktop archive changed during extraction');
    const binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || !(binaryInfo.mode & 0o111)) throw new Error('Bundled executable is missing');
    const bundleVersion = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')])).stdout.trim();
    if (bundleVersion !== options.version) throw new Error('Extracted desktop bundle version mismatch');
    const port = await freeLoopbackPort();
    const gateway = `http://127.0.0.1:${port}/`;
    const profile = path.join(directory, 'profile');
    const env = createPackagedFixtureEnvironment({ inherited: process.env, profile, port, issuer: options.issuer });
    // This first execution is itself an actual consumer of the extracted binary.
    const runtimeVersion = (await execute(binary, ['--version'], { env, cwd: directory, timeout: 60_000 })).stdout.trim();
    if (runtimeVersion !== options.version) throw new Error('Bundled runtime version mismatch');
    const binarySha256 = (await describeArchive(binary)).sha256;
    const { _electron } = await import('@playwright/test');
    launchAttempted = true;
    app = await _electron.launch({ executablePath: path.join(appPath, 'Contents', 'MacOS', 'Xpod'), cwd: directory, env, timeout: 60_000 });
    appProcess = app.process();
    await observeTree();
    observer = setInterval(() => {
      if (observation) return;
      observation = observeTree().catch(() => { observationFailed = true; }).finally(() => { observation = undefined; });
    }, 250);
    observer.unref();
    // The product's cold RuntimeManager startup already has a 60s budget;
    // its first window is created after that startup, not at Electron launch.
    const page = await app.firstWindow({ timeout: 60_000 });
    await waitFor(async () => {
      const response = await fetch(new URL('service/status', gateway), { signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
      return response?.ok ? true : undefined;
    }, 'Packaged Local runtime did not become ready');
    const serviceInfo = await fetch(new URL('api/service-info', gateway), { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!serviceInfo.ok || (await serviceInfo.json() as { edition?: string }).edition !== 'local') {
      throw new Error('Owned packaged runtime does not report the Local edition');
    }
    await page.goto(new URL('device/services', gateway).href);
    const runtime = await page.evaluate(async () => {
      const bridge = (window as unknown as { xpodDesktop?: { deviceRuntime?: {
        getRuntimeSettings(): Promise<{ state: string; ownership: string; pid?: number }>;
      } } }).xpodDesktop;
      if (!bridge?.deviceRuntime) throw new Error('Missing packaged desktop bridge');
      return bridge.deviceRuntime.getRuntimeSettings();
    });
    runtimePid = runtime.pid;
    assertBundledRuntimeProcess({ binary, pid: runtimePid, ownership: runtime.ownership,
      command: runtimePid ? await processCommand(runtimePid) ?? '' : '' });
    if (runtime.state !== 'running') throw new Error('Packaged runtime is not running');
    await assertOwnedRuntimeProfile(await readFile(path.join(profile, '.env'), 'utf8'), profile);
    await page.goto(new URL('ai-connections', gateway).href);
    return { app, page, gateway, directory, archive,
      runtime: { version: runtimeVersion, edition: 'local', ownership: 'desktop', binarySha256,
        bundled: true, installed: true, noExternalOverride: true, freshEndpoint: true }, close };
  } catch (error) {
    // Keep owned files if lifecycle cleanup cannot be proven. Never clean another App/profile.
    await close().catch(() => undefined);
    if (observer) clearInterval(observer);
    throw error;
  }
}
