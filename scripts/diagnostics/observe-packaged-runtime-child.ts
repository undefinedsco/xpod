/**
 * DIAGNOSTIC_NOT_QUALIFICATION.
 *
 * Observes the packaged App's own CLI ChildProcess stdout/stderr from the Electron
 * MAIN process, so CI can see real child output the product's startup frame never
 * records. The product, its RuntimeManager and the existing diagnostic script are
 * NOT modified.
 *
 * Reviewed constraints:
 *  - _electron.launch override persists for the whole process (the diagnostic
 *    script calls `void main()`, so its dynamic import resolves before any await).
 *  - The child is matched ONLY by exact spawnfile/spawnargs equality against the
 *    product-computed launch. No name or pid heuristics.
 *  - Matching runs in the MAIN process on a background poll and returns an ACK
 *    immediately, so the product 60s budget and the fixture deadline are untouched.
 *  - Raw output goes ONLY to a 0600 O_NOFOLLOW capped private file; the public safe
 *    record never carries pid/argv/path/env/message/URLs.
 */
import { createRequire } from 'node:module';
import { mkdir, lstat, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RAW_LIMIT = 128 * 1024;

export type ProbeInput = {
  expectedCommand: string; expectedArgs: string[]; rawPath: string; statePath: string;
  limit: number; matchWindowMs: number;
};

export type ProbeAck = {
  status: string; builtinApi: string; scheduled: boolean;
};

type ProbeState = { status: string; matched: boolean; bytes: number; truncated: boolean; closed: boolean };

/**
 * MAIN-process probe. Serialized by Playwright, so it MUST NOT close over module
 * scope: only parameters plus Node globals (process/Buffer/Date/setTimeout) are
 * used. ElectronApplication.evaluate passes (electronModule, arg) — hence the
 * unused first parameter.
 */
export async function mainProcessProbe(
  _electronMain: unknown,
  input: ProbeInput,
): Promise<ProbeAck> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const proc: any = process as any;
  // Capability test FIRST; do not assume any Node version lacks getBuiltinModule.
  let fs: any; let api = 'none';
  if (typeof proc.getBuiltinModule === 'function') {
    try { fs = proc.getBuiltinModule('node:fs'); api = 'getBuiltinModule'; } catch { fs = undefined; }
  }
  if (!fs) {
    // Checked main-global fallback only; no external require closure is captured.
    const fallback = typeof require === 'function' ? require : undefined;
    if (fallback) {
      try { fs = fallback('node:fs'); api = 'require'; } catch { fs = undefined; }
    }
  }
  if (!fs) return { status: 'unsupported-api', builtinApi: 'none', scheduled: false };

  const writeState = (state: ProbeState): void => {
    try {
      const body = Buffer.from(JSON.stringify(state));
      const fd = fs.openSync(input.statePath, fs.constants.O_CREAT | fs.constants.O_WRONLY
        | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    } catch { /* state is advisory only */ }
  };

  const matches = (handle: any): boolean => {
    try {
      if (!handle || typeof handle !== 'object') return false;
      const { spawnfile, spawnargs } = handle;
      if (typeof spawnfile !== 'string' || !Array.isArray(spawnargs)) return false;
      if (spawnfile !== input.expectedCommand) return false;
      // spawnargs[0] is the EXECUTABLE; expectedOwnedRuntimeArgv includes it.
      if (spawnargs.length !== input.expectedArgs.length) return false;
      for (let i = 0; i < spawnargs.length; i += 1) {
        if (spawnargs[i] !== input.expectedArgs[i]) return false;
      }
      return typeof handle.stdout?.on === 'function' || typeof handle.stderr?.on === 'function';
    } catch { return false; }
  };

  writeState({ status: 'polling', matched: false, bytes: 0, truncated: false, closed: false });

  // Background poll: the caller's await returns as soon as this is scheduled.
  void (async (): Promise<void> => {
    const deadline = Date.now() + input.matchWindowMs;
    let candidate: any;
    while (Date.now() < deadline) {
      let found: any[] = [];
      try {
        const handles: any[] = typeof proc._getActiveHandles === 'function' ? proc._getActiveHandles() : [];
        found = handles.filter(matches);
      } catch { found = []; }
      if (found.length > 1) {
        writeState({ status: 'ambiguous', matched: false, bytes: 0, truncated: false, closed: false });
        return;
      }
      if (found.length === 1) { candidate = found[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!candidate) {
      writeState({ status: 'not-attached', matched: false, bytes: 0, truncated: false, closed: true });
      return;
    }
    let fd: number | undefined;
    try {
      const parent = fs.lstatSync(input.rawPath.slice(0, input.rawPath.lastIndexOf('/')));
      if (!parent.isDirectory() || parent.isSymbolicLink()
        || (typeof proc.getuid === 'function' && parent.uid !== proc.getuid())) throw new Error('unowned');
      fd = fs.openSync(input.rawPath, fs.constants.O_WRONLY | fs.constants.O_APPEND
        | fs.constants.O_NOFOLLOW, 0o600);
    } catch {
      writeState({ status: 'observer-failed', matched: true, bytes: 0, truncated: false, closed: true });
      return;
    }
    const state: ProbeState = { status: 'attached', matched: true, bytes: 0, truncated: false, closed: false };
    writeState(state);
    const write = (stream: string, chunk: any): void => {
      try {
        if (state.bytes >= input.limit) { state.truncated = true; return; }
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        // Cap by UTF-8 BYTES, not string length.
        const full = Buffer.from(`[${new Date().toISOString()}] ${stream} ${text}\n`);
        const room = input.limit - state.bytes;
        const body = full.length > room ? full.subarray(0, room) : full;
        fs.writeSync(fd, body);
        state.bytes += body.length;
        if (full.length > room) state.truncated = true;
        writeState(state);
      } catch { state.truncated = true; }
    };
    for (const stream of ['stdout', 'stderr'] as const) {
      const source = candidate[stream];
      if (!source || typeof source.on !== 'function') continue;
      source.on('data', (chunk: any) => write(stream, chunk));
    }
    // Keep draining past the cap until the child closes, then close our FD.
    candidate.once?.('close', () => {
      state.closed = true;
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* already closed */ }
      writeState(state);
    });
  })();

  return { status: 'scheduled', builtinApi: api, scheduled: true };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function scriptArgument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function installObserver(): Promise<void> {
  const output = path.resolve(scriptArgument('output') ?? '');
  const privateDir = path.join(output, 'child-private');
  const rawPath = path.join(privateDir, 'runtime-child.private.log');
  const statePath = path.join(privateDir, 'runtime-child.state.json');

  // Parent-owned 0700 dir, 0600 O_EXCL|O_NOFOLLOW file, closed properly.
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const dir = await lstat(privateDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('private directory is not owned');
  if (process.getuid && dir.uid !== process.getuid()) throw new Error('private directory is not owned');
  const handle = await open(rawPath,
    // eslint-disable-next-line no-bitwise
    (await import('node:fs')).constants.O_CREAT | (await import('node:fs')).constants.O_EXCL
    | (await import('node:fs')).constants.O_NOFOLLOW | (await import('node:fs')).constants.O_WRONLY,
    0o600);
  await handle.close();

  const require = createRequire(import.meta.url);
  const { _electron } = require('@playwright/test') as { _electron: { launch: (...a: unknown[]) => Promise<unknown> } };
  const original = _electron.launch;
  _electron.launch = async function patched(this: unknown, ...args: unknown[]): Promise<unknown> {
    const app: any = await (original as (...a: unknown[]) => Promise<any>).apply(this, args);
    try {
      const options = (args[0] ?? {}) as { executablePath?: string; env?: Record<string, string> };
      const resources = options.executablePath ? path.resolve(options.executablePath, '..', '..', 'Resources') : undefined;
      const { resolveRuntimeLaunchCommand } = require('../../desktop/src/runtime-manager') as {
        resolveRuntimeLaunchCommand(i: { env: NodeJS.ProcessEnv; packaged: boolean; resourcesPath: string }): { command: string; args: string[] } | undefined;
      };
      const { expectedOwnedRuntimeArgv } = require('../helpers/packaged-desktop-fixture') as {
        expectedOwnedRuntimeArgv(i: { command: string; args: string[]; targetOrigin: string; env: NodeJS.ProcessEnv; ownedProfile?: string }): string[];
      };
      const env = (options.env ?? {}) as NodeJS.ProcessEnv;
      const launch = resources ? resolveRuntimeLaunchCommand({ env, packaged: true, resourcesPath: resources }) : undefined;
      const port = env.XPOD_PORT; const profile = env.XPOD_DESKTOP_USER_DATA_DIR;
      if (!launch || !port || !profile) return app;
      const expectedArgs = expectedOwnedRuntimeArgv({
        command: launch.command, args: launch.args, targetOrigin: `http://127.0.0.1:${port}`, env, ownedProfile: profile,
      });
      await app.evaluate(mainProcessProbe, {
        expectedCommand: launch.command, expectedArgs, rawPath, statePath,
        limit: RAW_LIMIT, matchWindowMs: 15_000,
      });
    } catch { /* observer must never change launch semantics */ }
    return app;
  } as typeof _electron.launch;

  await import('./desktop-launch-diagnostic');
}

async function writeSafeRecord(): Promise<void> {
  const output = path.resolve(scriptArgument('output') ?? '');
  const privateDir = path.join(output, 'child-private');
  const statePath = path.join(privateDir, 'runtime-child.state.json');
  const rawPath = path.join(privateDir, 'runtime-child.private.log');
  let state: ProbeState = { status: 'not-attached', matched: false, bytes: 0, truncated: false, closed: true };
  try {
    const value: unknown = JSON.parse(await readFile(statePath, 'utf8'));
    const candidate = value as Partial<ProbeState>;
    if (candidate && typeof candidate === 'object'
      && ['polling', 'not-attached', 'attached', 'ambiguous', 'unsupported-api', 'observer-failed'].includes(String(candidate.status))
      && typeof candidate.matched === 'boolean' && Number.isSafeInteger(candidate.bytes)
      && Number(candidate.bytes) >= 0 && Number(candidate.bytes) <= RAW_LIMIT
      && typeof candidate.truncated === 'boolean' && typeof candidate.closed === 'boolean') {
      state = candidate as ProbeState;
    }
  } catch { /* no state: fall through to actual size */ }
  // Never claim capture that did not happen: reconcile with the real file size.
  let actualBytes = 0;
  try { actualBytes = (await lstat(rawPath)).size; } catch { actualBytes = 0; }
  if (actualBytes > RAW_LIMIT) { state.status = 'observer-failed'; state.truncated = true; }
  state.bytes = Math.min(actualBytes, RAW_LIMIT);
  const safe = {
    schema: 'xpod-runtime-child-observer/1', classification: 'NOT_QUALIFICATION',
    status: state.status, matched: state.matched === true,
    bytes: state.bytes, truncated: state.truncated === true, closed: state.closed === true,
    rawCaptured: state.status === 'attached' && state.bytes > 0 && actualBytes > 0 && actualBytes <= RAW_LIMIT,
  };
  await writeFile(path.join(output, 'child-observer-safe.json'), `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
}

// Side effects ONLY when executed directly; importing for tests must be inert.
if ((import.meta as { main?: boolean }).main) {
  process.once('beforeExit', () => { void writeSafeRecord(); });
  void installObserver();
}
