import { installOwnedDesktop } from './packaged-desktop-installation';
import { execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from '@playwright/test';
import { resolveRuntimeLaunchCommand, desktopRuntimeArguments,
  type RuntimeLaunchCommand } from '../../desktop/src/runtime-manager';

/**
 * Closed, literal launch subphases. These are the ONLY tokens this fixture may
 * emit, so publishing a phase can never leak a path, URL, argument, message or
 * environment value. Ordering mirrors the actual launch sequence.
 */
export type LaunchSubphase =
  | 'install' | 'archive-hash' | 'version' | 'native-version' | 'electron'
  | 'window' | 'gateway' | 'service-info' | 'bridge' | 'profile';

const LAUNCH_SUBPHASES: ReadonlySet<string> = new Set<LaunchSubphase>([
  'install', 'archive-hash', 'version', 'native-version', 'electron',
  'window', 'gateway', 'service-info', 'bridge', 'profile',
]);

/** Guards an arbitrary value down to the closed enum, never coercing text. */
export function isLaunchSubphase(value: unknown): value is LaunchSubphase {
  return typeof value === 'string' && LAUNCH_SUBPHASES.has(value);
}

/** Emits one closed-enum token; a misbehaving observer must never mask a real
 * launch error, so the call is isolated and failures are swallowed. */
function emitSubphase(options: { onPhase?: (phase: LaunchSubphase) => void }, phase: LaunchSubphase): void {
  if (!options.onPhase) return;
  try { options.onPhase(phase); } catch { /* observer must not change launch semantics */ }
}

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
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(options.profile, 'bun-transpiler-cache'),
    // These existing API settings confine CLI configuration apply/rollback;
    // HOME remains the host's standard runtime input, not a configuration target.
    XPOD_AI_CLIENT_CONFIGURATION_ENABLED: 'true',
    XPOD_AI_CLIENT_CONFIGURATION_HOME_DIR: path.join(options.profile, 'client-config-home'),
    XPOD_AI_CLIENT_CONFIGURATION_BACKUP_ROOT: path.join(options.profile, 'client-config-backups'),
    XPOD_DESKTOP_URL: `http://127.0.0.1:${options.port}/device/services`,
  });
}

/**
 * The EXACT owned process identity the product constructs for this install.
 *
 * Built from the resolver command plus the product's own desktopRuntimeArguments
 * factory, so the expected argv has no hand-written flag list and no permissive
 * matching: the executable must be this exact path, followed by `start`, followed
 * by exactly the arguments the product would pass.
 */
export function expectedOwnedRuntimeArgv(input: {
  command: string; args: string[]; targetOrigin: string; env: NodeJS.ProcessEnv;
}): string[] {
  return [input.command, ...desktopRuntimeArguments(input.args, input.targetOrigin, input.env)];
}

export function assertBundledRuntimeProcess(input: {
  binary: string; command: string; pid?: number; ownership: string;
  /** The exact argv the product would spawn; required for identity proof. */
  expectedArgv?: readonly string[];
}): void {
  if (input.ownership !== 'desktop' || !Number.isSafeInteger(input.pid) || (input.pid ?? 0) < 1) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
  if (!input.expectedArgv || input.expectedArgv.length < 2) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
  if (input.expectedArgv[0] !== input.binary) {
    throw new Error('Runtime is not the owned extracted packaged binary');
  }
  // Exact argv equality, with only whitespace normalised: a foreign entry with
  // the same basename, a prefix-similar binary, a different subcommand or any
  // extra/disallowed argument all fail.
  const actual = input.command.trim().replace(/\s+/gu, ' ');
  const expected = input.expectedArgv.join(' ').trim().replace(/\s+/gu, ' ');
  if (actual !== expected) throw new Error('Runtime is not the owned extracted packaged binary');
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
  // -ww asks for the FULL command width: the owned argv now contains long staged
  // paths plus --baseUrl, which a truncated ps line would mis-report as a
  // different command and wrongly fail the strict identity comparison.
  try { return (await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='])).stdout.trim(); }
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
  /** Optional closed-enum progress observer; must not alter launch semantics. */
  onPhase?: (phase: LaunchSubphase) => void;
}): Promise<OwnedPackagedDesktop> {
  if (process.platform !== 'darwin') throw new Error('Packaged desktop acceptance requires macOS');
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+(?:\.\d+)?)?$/.test(options.version)) throw new Error('Invalid packaged version');
  await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(path.resolve(options.evidenceDirectory), 'owned-app-'));
  const archive = await describeArchive(options.archive);
  let installation: Awaited<ReturnType<typeof installOwnedDesktop>> | undefined;
  let appPath = '';
  let binary = '';
  /** Staged CLI entry that the packaged bun executes (may stay empty). */
  let runtimeEntry = '';
  /** The exact product-resolved launch (command + args prefix). */
  let launchCommand: RuntimeLaunchCommand | undefined;
  /** The exact argv the product spawns for this owned runtime. */
  let ownedArgv: string[] | undefined;
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
        // Same EXACT expected-owned-process identity used for the live assertion,
        // so a changed command is recognised instead of matching a prefix.
        const expected = ownedArgv;
        return command?.trim().replace(/\s+/gu, ' ') !== expected!.join(' ').trim().replace(/\s+/gu, ' ')
          ? true : undefined;
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
    emitSubphase(options, 'install');
    installation = await installOwnedDesktop(path.resolve(options.archive), directory);
    appPath = installation.appPath;
    // Resolve the packaged program with the PRODUCT's own resolver, exactly as
    // RuntimeManager does. `packaged: true` forbids the system-Bun fallback, so a
    // missing staged program fails closed instead of silently resolving a host
    // toolchain. No second path/args table is maintained here.
    // RuntimeManager passes the app's Resources directory; the resolver appends
    // `runtime/...`, so this must be Contents/Resources, not Contents.
    const resourcesPath = path.join(appPath, 'Contents', 'Resources');
    const launch = resolveRuntimeLaunchCommand({
      env: {},                      // filtered owned env only; never the host env
      packaged: true,
      resourcesPath,
      // The packaged branch must not consult the host: no system Bun fallback.
      resolveBunCommand: () => undefined,
    });
    if (!launch) throw new Error('Bundled runtime launcher is missing');
    // The resolver's answer has to be a physical regular file inside the
    // installed bundle - not merely a string that happens to look right.
    const installedRoot = path.resolve(appPath) + path.sep;
    const commandPath = path.resolve(launch.command);
    if (!commandPath.startsWith(installedRoot)) throw new Error('Bundled runtime launcher escapes the installed bundle');
    const commandInfo = await lstat(commandPath).catch(() => undefined);
    if (!commandInfo?.isFile() || !(commandInfo.mode & 0o111)) throw new Error('Bundled executable is missing');
    // The CLI entry is the first non-flag argument after `start`, as the product
    // constructs it; it must also be a regular file inside the bundle.
    const entryArg = launch.args.find(value => !value.startsWith('-'));
    if (!entryArg) throw new Error('Bundled runtime entry is missing');
    const entryPath = path.resolve(commandPath, '..', entryArg);
    const resolvedEntry = path.resolve(entryPath);
    if (!resolvedEntry.startsWith(installedRoot)) throw new Error('Bundled runtime entry escapes the installed bundle');
    const entryInfo = await lstat(resolvedEntry).catch(() => undefined);
    if (!entryInfo?.isFile()) throw new Error('Bundled runtime entry is missing');
    launchCommand = launch;
    binary = commandPath;
    runtimeEntry = resolvedEntry;
    emitSubphase(options, 'archive-hash');
    const afterExtract = await describeArchive(options.archive);
    if (JSON.stringify(afterExtract) !== JSON.stringify(archive)) throw new Error('Desktop archive changed during extraction');
    const binaryInfo = await lstat(binary);
    if (!binaryInfo.isFile() || !(binaryInfo.mode & 0o111)) throw new Error('Bundled executable is missing');
    emitSubphase(options, 'version');
    const bundleVersion = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')])).stdout.trim();
    if (bundleVersion !== options.version) throw new Error('Extracted desktop bundle version mismatch');
    const port = await freeLoopbackPort();
    const gateway = `http://127.0.0.1:${port}/`;
    const profile = path.join(directory, 'profile');
    const env = createPackagedFixtureEnvironment({ inherited: process.env, profile, port, issuer: options.issuer });
    // This first execution is itself an actual consumer of the extracted binary.
    // The prefix comes from the SAME resolved launch spec with `start` replaced by
    // `--version`, so no second argument table exists.
    emitSubphase(options, 'native-version');
    const versionArgs = [...launch.args];
    const startAt = versionArgs.indexOf('start');
    if (startAt < 0) throw new Error('Bundled runtime entry has no start subcommand');
    versionArgs[startAt] = '--version';
    const runtimeVersion = (await execute(launch.command, versionArgs, { env, cwd: directory, timeout: 60_000 })).stdout.trim();
    // The CLI carries its OWN package version (0.1.0-preview.N), not the desktop
    // candidate version; the product never compares the two. Assert instead that
    // --version really executed the staged CLI and that its answer matches the
    // CLI manifest shipped in the same bundle - a real binding, not a guess.
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(runtimeVersion)) {
      throw new Error('Bundled runtime version is not a valid CLI version');
    }
    const cliManifestPath = path.join(runtimeEntry, '..', '..', 'package.json');
    const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8')) as { name?: string; version?: string };
    if (cliManifest.name !== '@undefineds.co/xpod-cli' || cliManifest.version !== runtimeVersion) {
      throw new Error('Bundled runtime version differs from the staged CLI manifest');
    }
    const binarySha256 = (await describeArchive(binary)).sha256;
    ownedArgv = expectedOwnedRuntimeArgv({ command: launch.command, args: launch.args, targetOrigin: gateway, env });
    const { _electron } = await import('@playwright/test');
    emitSubphase(options, 'electron');
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
    emitSubphase(options, 'window');
    const page = await app.firstWindow({ timeout: 60_000 });
    emitSubphase(options, 'gateway');
    await waitFor(async () => {
      const response = await fetch(new URL('service/status', gateway), { signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
      return response?.ok ? true : undefined;
    }, 'Packaged Local runtime did not become ready');
    emitSubphase(options, 'service-info');
    const serviceInfo = await fetch(new URL('api/service-info', gateway), { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!serviceInfo.ok || (await serviceInfo.json() as { edition?: string }).edition !== 'local') {
      throw new Error('Owned packaged runtime does not report the Local edition');
    }
    await page.goto(new URL('device/services', gateway).href);
    emitSubphase(options, 'bridge');
    const runtime = await page.evaluate(async () => {
      const bridge = (window as unknown as { xpodDesktop?: { deviceRuntime?: {
        getRuntimeSettings(): Promise<{ state: string; ownership: string; pid?: number }>;
      } } }).xpodDesktop;
      if (!bridge?.deviceRuntime) throw new Error('Missing packaged desktop bridge');
      return bridge.deviceRuntime.getRuntimeSettings();
    });
    runtimePid = runtime.pid;
    assertBundledRuntimeProcess({ binary, pid: runtimePid, ownership: runtime.ownership,
      expectedArgv: ownedArgv,
      command: runtimePid ? await processCommand(runtimePid) ?? '' : '' });
    if (runtime.state !== 'running') throw new Error('Packaged runtime is not running');
    emitSubphase(options, 'profile');
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
