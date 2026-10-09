import { spawn } from 'node:child_process';
import { StartupCancellation, observeChild, stopOwnedChild } from './startup';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { AgentDirectoryClient } from './directory/client';
import { moduleRoot, moduleLauncher } from './runtime';
import { authFetch, requireAuthContext } from '@undefineds.co/xpod-cli/client';
import { fail, handleCliError, writeJson, writeJsonResult } from '@undefineds.co/xpod-cli/client';
import { installRgWrapper, renderEnvExports } from './agent-fs/install';
import { defaultBackend, describePrerequisites, MountUnavailableError, type MountBackendKind } from './agent-fs/mount';
import { startAuthProxy } from './agent-fs/auth-proxy';
import { resolveNativeBinary } from './agent-fs/native';
import { loadManagedRoots, normalizePodRoot, parseManagedRoots, type ManagedRoot } from './agent-fs/roots';
import { defaultSessionDir, observeSession } from './agent-fs/session-view';

interface AgentFsArgs {
  dir?: string;
  root?: string[];
  'native-rg'?: string;
  'session-dir'?: string;
  'pod-root'?: string;
  backend?: string;
  mountpoint?: string;
  json?: boolean;
}

function agentFsOptions<T>(yargs: Argv): Argv<T> {
  return yargs
    .option('dir', {
      type: 'string',
      description: 'Wrapper install/session directory',
    })
    .option('root', {
      type: 'array',
      string: true,
      description: 'Managed root mapping localPath=podRoot (repeatable)',
    })
    .option('native-rg', {
      type: 'string',
      description: 'Pre-resolved native ripgrep path to bake into the wrapper',
    })
    .option('session-dir', {
      type: 'string',
      description: 'Durable mount session directory',
    })
    .option('pod-root', {
      type: 'string',
      description: 'Pod container root URL (alias of --server for the helper)',
    })
    .option('backend', {
      type: 'string',
      description: 'Mount backend: nfs (macOS, userspace) or fuse (Linux)',
    })
    .option('mountpoint', {
      type: 'string',
      description: 'Mountpoint directory (defaults to <session-dir>/mnt)',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      description: 'Output JSON envelope',
    }) as unknown as Argv<T>;
}

function rootsFromArgs(argv: AgentFsArgs): ManagedRoot[] {
  if (!argv.root || argv.root.length === 0) {
    return loadManagedRoots();
  }
  const roots = argv.root.map((entry) => {
    const separator = entry.indexOf('=');
    if (separator === -1) {
      throw new Error(`Invalid --root "${entry}"; expected localPath=podRoot`);
    }
    return { localPath: entry.slice(0, separator), podRoot: entry.slice(separator + 1) };
  });
  const parsed = parseManagedRoots(roots);
  if (parsed.length !== roots.length) {
    throw new Error('Each --root must be an absolute local path and an http(s) Pod root URL');
  }
  return parsed;
}

function requireDir(argv: AgentFsArgs): string {
  if (!argv.dir) {
    throw new Error('--dir is required for this subcommand');
  }
  return path.resolve(argv.dir);
}

const installCommand: CommandModule<object, AgentFsArgs> = {
  command: 'install',
  describe: 'Write a session-scoped rg wrapper into a directory',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    try {
      const result = installRgWrapper({
        dir: requireDir(argv),
        roots: rootsFromArgs(argv),
        sessionDir: argv['session-dir'] ?? defaultSessionDir(),
        ...(argv['native-rg'] ? { nativeRg: path.resolve(argv['native-rg']) } : {}),
      });
      if (argv.json) {
        writeJsonResult({ ...result, exports: renderEnvExports(result) });
        return;
      }
      console.log(`Installed rg wrapper at ${result.wrapperPath}`);
      console.log(`Native rg: ${result.nativeRg}`);
      console.log('Add it to this session with:');
      for (const line of renderEnvExports(result)) {
        console.log(`  ${line}`);
      }
    } catch (error) {
      handleCliError(error, Boolean(argv.json));
    }
  },
};

const envCommand: CommandModule<object, AgentFsArgs> = {
  command: 'env',
  describe: 'Print shell exports for an already installed wrapper directory',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    try {
      const dir = requireDir(argv);
      const nativeRg = argv['native-rg'] ? path.resolve(argv['native-rg']) : resolveNativeBinary('rg', process.env, [ dir ]);
      if (!nativeRg) {
        throw new Error('Could not resolve a native rg binary.');
      }
      const exports = renderEnvExports({
        dir,
        wrapperPath: path.join(dir, 'rg'),
        nativeRg,
        launcher: [],
      });
      if (argv.json) {
        writeJsonResult({ dir, nativeRg, exports });
        return;
      }
      for (const line of exports) {
        console.log(line);
      }
    } catch (error) {
      handleCliError(error, Boolean(argv.json));
    }
  },
};

const shellCommand: CommandModule<object, AgentFsArgs> = {
  command: 'shell',
  describe: 'Open a shell whose PATH uses the managed rg wrapper for this session',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    try {
      const tempDir = argv.dir ? path.resolve(argv.dir) : mkdtempSync(path.join(tmpdir(), 'xpod-agent-fs-'));
      const result = installRgWrapper({
        dir: tempDir,
        roots: rootsFromArgs(argv),
        sessionDir: argv['session-dir'] ?? defaultSessionDir(),
        ...(argv['native-rg'] ? { nativeRg: path.resolve(argv['native-rg']) } : {}),
      });
      const shell = process.env.SHELL || '/bin/sh';
      const child = spawn(shell, [], {
        stdio: 'inherit',
        env: {
          ...process.env,
          PATH: `${result.dir}${path.delimiter}${process.env.PATH ?? ''}`,
          XPOD_AGENT_FS_WRAPPER_DIR: result.dir,
          XPOD_AGENT_FS_NATIVE_RG: result.nativeRg,
        },
      });
      const code = await new Promise<number>((resolve) => child.on('close', (value) => resolve(value ?? 0)));
      if (!argv.dir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
      process.exitCode = code;
    } catch (error) {
      handleCliError(error, Boolean(argv.json));
    }
  },
};

function resolvePodRoot(argv: AgentFsArgs): string {
  if (argv['pod-root']) {
    const root = normalizePodRoot(argv['pod-root']);
    if (!root) {
      throw new Error('--pod-root must be an http(s) container URL without credentials, query or fragment');
    }
    return root;
  }
  const roots = rootsFromArgs(argv);
  if (roots.length === 0) {
    throw new Error('A --pod-root (or --root localPath=podRoot) is required to mount');
  }
  return roots[0].podRoot;
}

function resolveBackend(argv: AgentFsArgs): MountBackendKind {
  const value = (argv.backend ?? defaultBackend()) as MountBackendKind;
  if (value !== 'nfs' && value !== 'fuse') {
    throw new Error(`Unsupported backend "${value}"; expected nfs or fuse`);
  }
  return value;
}

function readFirstJsonLine(stream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
      stream.removeListener('close', onEnd);
      stream.removeListener('end', onEnd);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => onError(new Error('AFS startup cancelled'));
    const onEnd = (): void => onError(new Error('auth proxy exited before reporting a port'));
    const timeout = setTimeout(() => onError(new Error('auth proxy startup timed out')), 15_000);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      if (buffer.length > 32_768) {
        onError(new Error('auth proxy startup response exceeded the limit'));
        return;
      }
      const index = buffer.indexOf('\n');
      if (index !== -1) {
        cleanup();
        resolve(buffer.slice(0, index));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    stream.on('data', onData);
    stream.once('error', onError);
    stream.once('close', onEnd);
    stream.once('end', onEnd);
  });
}

/**
 * Start the loopback auth proxy as a child process. Its stderr is redirected to a
 * private session log instead of inheriting the caller's stdio: a long-lived
 * proxy must never retain a caller's capture pipe (which would delay the
 * caller's stdout/stderr EOF until the proxy is unmounted). The capability is
 * only ever written to the proxy's stdout startup line, which is read and
 * discarded by the parent, never logged.
 */
async function spawnAuthProxyDaemon(podRoot: string, sessionDir: string): Promise<ReturnType<typeof spawn>> {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const [ cliExecutable, ...cliArgs ] = moduleLauncher();
  const logFd = openSync(path.join(sessionDir, 'proxy.log'), 'a', 0o600);
  try {
    const child = observeChild(spawn(cliExecutable, [ ...cliArgs, 'proxy', '--pod-root', podRoot ], {
      stdio: [ 'ignore', 'pipe', logFd ], detached: true,
    }));
    try {
      writeFileSync(path.join(sessionDir, 'proxy-owner.json'), JSON.stringify({ pid: child.pid, createdAt: new Date().toISOString(), detached: true }), { mode: 0o600 });
    } catch (cause) { await stopOwnedChild(child); throw cause; }
    return child;
  } finally {
    closeSync(logFd);
  }
}

const proxyCommand: CommandModule<object, AgentFsArgs> = {
  command: 'proxy',
  describe: 'Run a loopback auth proxy restricted to one Pod (internal mount bridge)',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    try {
      const podRoot = resolvePodRoot(argv);
      const auth = await requireAuthContext();
      const proxy = await startAuthProxy({ podRoot, onShutdown: () => void shutdown() });
      console.log(JSON.stringify({ origin: proxy.origin, podRoot, identity: auth.webId, capability: proxy.capability }));
      const shutdown = async (): Promise<void> => {
        await proxy.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown());
      process.on('SIGINT', () => void shutdown());
      await new Promise<void>(() => undefined);
    } catch (error) {
      handleCliError(error, Boolean(argv.json));
    }
  },
};

const mountCommand: CommandModule<object, AgentFsArgs> = {
  command: 'mount',
  describe: 'Mount the Pod as an AgentFS filesystem (userspace NFS or Linux FUSE)',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    let proxy: ReturnType<typeof spawn> | undefined;
    let retainProxy = false;
    let helperCode: number | undefined;
    let helperStarted = false;
    let cancellationMountpoint: string | undefined;
    let cancellationSession: string | undefined;
    let cancellationHelper: string | undefined;
    let cancellationControl: { origin: string; capability: string } | undefined;
    const startup = new StartupCancellation();
    try {
      const backend = resolveBackend(argv);
      const prerequisites = describePrerequisites(moduleRoot(), process.env, backend);
      if (prerequisites.blockers.length > 0) {
        throw new MountUnavailableError(prerequisites);
      }
      const sessionDir = argv['session-dir'] ? path.resolve(argv['session-dir']) : defaultSessionDir();
      const podRoot = resolvePodRoot(argv);
      const mountpoint = path.resolve(argv.mountpoint ?? path.join(sessionDir, 'mnt'));
      mkdirSync(mountpoint, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });

      // Start the loopback auth proxy so the Rust helper never owns credentials
      // and every Pod request flows through the CLI auth lifecycle.
      proxy = await spawnAuthProxyDaemon(podRoot, sessionDir);
      const line = await readFirstJsonLine(proxy.stdout as NodeJS.ReadableStream, startup.controller.signal);
      const { origin, capability, identity } = JSON.parse(line) as { origin: string; capability: string; identity: string };
      cancellationControl = { origin, capability };
      const podPath = new URL(podRoot.endsWith('/') ? podRoot : `${podRoot}/`).pathname;
      const helperServer = `${origin}${podPath}`;

      const helper = prerequisites.helperPath as string;
      cancellationMountpoint = mountpoint; cancellationSession = sessionDir; cancellationHelper = helper;
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(helper, [
          'mount',
          '--server', helperServer,
          '--mountpoint', mountpoint,
          '--backend', backend,
          '--session-dir', sessionDir,
        ], { stdio: 'inherit', env: {
          ...process.env, XPOD_AGENTFS_CAPABILITY: capability,
          XPOD_AGENTFS_POD_ROOT: podRoot, XPOD_AGENTFS_IDENTITY: identity,
        } });
        helperStarted = true; startup.track(child);
        let spawnError: Error | undefined;
        child.once('error', error => { spawnError = error; });
        child.once('close', value => spawnError ? reject(spawnError) : resolve(value ?? 1));
      });
      if (startup.signal) { throw new Error('AFS startup cancelled'); }
      helperCode = code;
      if (code !== 0 && code !== 75) {
        await stopOwnedChild(proxy);
        process.exitCode = code;
        return;
      }
      // Pending is failure, not mounted. Once native may be serving kernel
      // flushes, neither control-record failure nor catch may stop its proxy.
      retainProxy = true;
      proxy.stdout?.destroy();
      proxy.unref();
      writeFileSync(path.join(sessionDir, 'proxy.json'), JSON.stringify({ origin, capability }), { mode: 0o600 });
      if (code === 75) {
        if (argv.json) {
          writeJson(fail('mount_pending', 'Mount startup remains unresolved; authentication proxy retained.', [], { proxyRetained: true }));
        } else {
          console.error('Mount startup remains unresolved; authentication proxy retained.');
        }
      }
      process.exitCode = code;
    } catch (error) {
      if (startup.signal && helperStarted && cancellationHelper) {
        // Cancellation after native launch cannot assume that no daemon or
        // kernel mount exists. Unmount first; uncertain teardown retains auth.
        const teardown = spawn(cancellationHelper, ['unmount', '--mountpoint', cancellationMountpoint!, '--session-dir', cancellationSession!], { stdio: 'ignore' });
        const timer = setTimeout(() => teardown.kill('SIGKILL'), 15_000);
        const result = await new Promise<number>(resolve => {
          let spawnFailed = false;
          teardown.once('error', () => { spawnFailed = true; });
          teardown.once('close', value => resolve(spawnFailed ? 1 : value ?? 1));
        });
        clearTimeout(timer);
        if (result !== 0 && proxy) {
          retainProxy = true;
          proxy.stdout?.destroy(); proxy.unref();
          writeFileSync(path.join(cancellationSession!, 'proxy.json'), JSON.stringify(cancellationControl), { mode: 0o600 });
        }
      }
      if (proxy && !retainProxy) { await stopOwnedChild(proxy); }
      if (startup.signal && !retainProxy) { process.exitCode = startup.signal === 'SIGINT' ? 130 : 143; return; }
      if (retainProxy) {
        // Never expose capability, origin or a user's Pod URL in this error.
        const reason = (error as NodeJS.ErrnoException).code;
        const secondary = reason === 'EACCES' || reason === 'ENOSPC' ? reason : 'control_write_failed';
        if (argv.json) {
          writeJson(fail('mount_control_failed', 'Mount control update failed; authentication proxy retained.', [], { proxyRetained: true, helperExit: helperCode, secondary }));
        } else {
          console.error(`Mount control update failed (${secondary}); authentication proxy retained.`);
        }
        process.exitCode = startup.signal || helperCode === 75 ? 75 : 1;
        return;
      }
      if (error instanceof MountUnavailableError) {
        if (argv.json) {
          writeJsonResult({ error: true, code: 'mount_unavailable', ...error.prerequisites });
        } else {
          console.error(error.message);
          for (const blocker of error.prerequisites.blockers) {
            console.error(`  - ${blocker}`);
          }
        }
        process.exitCode = 3;
        return;
      }
      if (argv.json) {
        const message = error instanceof Error ? error.message : String(error);
        writeJsonResult({ error: true, code: 'mount_failed', message, blockers: [ message ] });
        process.exitCode = 1;
        return;
      }
      handleCliError(error, false);
    } finally { startup.dispose(); }
  },
};

const unmountCommand: CommandModule<object, AgentFsArgs> = {
  command: 'unmount',
  describe: 'Unmount the AgentFS Pod filesystem',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    const prerequisites = describePrerequisites(moduleRoot());
    const sessionDir = argv['session-dir'] ? path.resolve(argv['session-dir']) : defaultSessionDir();
    if (!prerequisites.helperPresent) {
      if (argv.json) {
        writeJsonResult({ error: true, code: 'mount_unavailable', ...prerequisites });
      } else {
        console.error(`AgentFS Pod helper not built; nothing is mounted.`);
      }
      process.exitCode = 3;
      return;
    }
    const mountpoint = path.resolve(argv.mountpoint ?? path.join(sessionDir, 'mnt'));
    const code = await new Promise<number>((resolve, reject) => {
      const args = [ 'unmount' ];
      if (mountpoint) {
        args.push('--mountpoint', mountpoint);
      }
      args.push('--session-dir', sessionDir);
      const child = spawn(prerequisites.helperPath as string, args, { stdio: 'inherit' });
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      child.once('close', value => spawnError ? reject(spawnError) : resolve(value ?? 1));
    });
    if (code === 0) {
      const controlFile = path.join(sessionDir, 'proxy.json');
      try {
        const control = JSON.parse(readFileSync(controlFile, 'utf8')) as { origin: string; capability: string };
        const origin = new URL(control.origin);
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
            origin.href !== `${origin.origin}/` || !/^[a-f0-9]{64}$/.test(control.capability)) {
          throw new Error('invalid auth proxy control record');
        }
        const response = await fetch(`${origin.origin}/-/agentfs-proxy/shutdown`, {
          method: 'POST', headers: { 'x-xpod-agentfs-capability': control.capability },
          signal: AbortSignal.timeout(5000),
        });
        if (response.status !== 204) {
          throw new Error(`auth proxy shutdown returned ${response.status}`);
        }
        rmSync(controlFile, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`Filesystem unmounted; proxy cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    process.exitCode = code;
  },
};

const statusCommand: CommandModule<object, AgentFsArgs> = {
  command: 'status',
  describe: 'Report AgentFS Pod prototype prerequisites and pending write-back',
  builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
  handler: async (argv) => {
    try {
      const prerequisites = describePrerequisites(moduleRoot());
      const sessionDir = argv['session-dir'] ? path.resolve(argv['session-dir']) : defaultSessionDir();
      const pendingCount = observeSession(sessionDir).pending;
      const payload = { ...prerequisites, pendingOperations: pendingCount, sessionDir, roots: rootsFromArgs(argv) };
      if (argv.json) {
        writeJsonResult(payload);
        return;
      }
      const payloadPendingCount = pendingCount;
      console.log(`platform: ${prerequisites.platform}`);
      console.log(`helper: ${prerequisites.helperPath ?? '(not built)'}`);
      console.log(`check binary: ${prerequisites.checkBinaryPath ?? '(not built)'}`);
      console.log(`fuse: ${prerequisites.fuseAvailable ? 'available' : 'unavailable'}`);
      console.log(`upstream: ${prerequisites.upstream.repository}@${prerequisites.upstream.commit}`);
      console.log(`pending operations: ${payloadPendingCount}`);
      for (const blocker of prerequisites.blockers) {
        console.log(`blocker: ${blocker}`);
      }
    } catch (error) {
      handleCliError(error, Boolean(argv.json));
    }
  },
};

function sessionCommand(action: 'commit' | 'recover'): CommandModule<object, AgentFsArgs> {
  return {
    command: action,
    describe: action === 'commit' ? 'Write back the native session overlay to the Pod over authenticated HTTP' :
      'Reconcile ambiguous requests by reading the Pod; preserve changed remote versions',
    builder: (yargs) => agentFsOptions<AgentFsArgs>(yargs),
    handler: async (argv) => {
      let proxy: ReturnType<typeof spawn> | undefined;
      try {
        const podRoot = resolvePodRoot(argv);
        const sessionDir = argv['session-dir'] ? path.resolve(argv['session-dir']) : defaultSessionDir();
        const prerequisites = describePrerequisites(moduleRoot(), process.env, resolveBackend(argv));
        if (!prerequisites.helperPresent) {
          throw new Error(`AgentFS Pod helper not built; cannot ${action}`);
        }
        proxy = await spawnAuthProxyDaemon(podRoot, sessionDir);
        const line = await readFirstJsonLine(proxy.stdout as NodeJS.ReadableStream);
        const { origin, capability, identity } = JSON.parse(line) as { origin: string; capability: string; identity: string };
        const podPath = new URL(podRoot.endsWith('/') ? podRoot : `${podRoot}/`).pathname;
        const code = await new Promise<number>((resolve, reject) => {
          const child = spawn(prerequisites.helperPath as string, [
            action, '--pod-root', `${origin}${podPath}`, '--session-dir', sessionDir,
            ...(action === 'recover' && argv.json ? [ '--json' ] : []),
          ], { stdio: 'inherit', env: {
            ...process.env, XPOD_AGENTFS_CAPABILITY: capability,
            XPOD_AGENTFS_POD_ROOT: podRoot, XPOD_AGENTFS_IDENTITY: identity,
          } });
          let spawnError: Error | undefined;
          child.once('error', error => { spawnError = error; });
          child.once('close', value => spawnError ? reject(spawnError) : resolve(value ?? 1));
        });
        await stopOwnedChild(proxy);
        process.exitCode = code;
      } catch (error) {
        if (proxy) {
          await stopOwnedChild(proxy);
        }
        handleCliError(error, Boolean(argv.json));
      }
    },
  };
}

const commitCommand = sessionCommand('commit');
const recoverCommand = sessionCommand('recover');

export const agentFsCommand: CommandModule = {
  command: 'agent-fs',
  describe: 'Agent directory HTTP backend wrappers (rg) and AgentFS Pod mount prototype',
  builder: (yargs) => yargs
    .command(installCommand)
    .command(envCommand)
    .command(shellCommand)
    .command(proxyCommand)
    .command(mountCommand)
    .command(unmountCommand)
    .command(statusCommand)
    .command(commitCommand)
    .command(recoverCommand)
    .demandCommand(1, 'Please specify an agent-fs subcommand')
    .help(),
  handler: () => undefined,
};
