/**
 * Bubblewrap Sandbox for Terminal Sidecar
 *
 * Provides secure sandboxing using bubblewrap (bwrap) with:
 * - Single directory bind mount (based on ACL Control permission)
 * - Optional network isolation
 * - Process isolation via Linux namespaces
 *
 * Note: bubblewrap is Linux-only. On other platforms, falls back to unsandboxed execution.
 */
import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { getLoggerFor } from 'global-logger-factory';

export interface SandboxConfig {
  /** Working directory to bind mount (user must have acl:Control) */
  workdir: string;
  /** Command to execute inside sandbox */
  command: string;
  /** Command arguments */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** Whether to isolate network (default: false) */
  isolateNetwork?: boolean;
  /** Additional read-only bind mounts (e.g., /usr, /lib) */
  readonlyBinds?: string[];
  /** PTY columns */
  cols?: number;
  /** PTY rows */
  rows?: number;
}

export interface SandboxResult {
  process: ChildProcess;
  sandboxed: boolean;
}

// Check if bubblewrap is available
let bwrapAvailable: boolean | undefined;

function isBwrapAvailable(): boolean {
  if (bwrapAvailable === undefined) {
    try {
      const { execSync } = require('child_process');
      execSync('which bwrap', { stdio: 'ignore' });
      bwrapAvailable = true;
    } catch {
      bwrapAvailable = false;
    }
  }
  return bwrapAvailable;
}

export class BubblewrapSandbox {
  protected readonly logger = getLoggerFor(this);

  // Essential system paths that should be read-only mounted
  private static readonly SYSTEM_PATHS = [
    '/usr',
    '/lib',
    '/lib64',
    '/bin',
    '/sbin',
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/passwd',
    '/etc/group',
    '/etc/ssl',
    '/etc/ca-certificates',
  ];

  /**
   * Launch a sandboxed process.
   *
   * @param config - Sandbox configuration
   * @returns The spawned process and whether it's sandboxed
   */
  public launch(config: SandboxConfig): SandboxResult {
    if (!isBwrapAvailable()) {
      this.logger.warn('bubblewrap not available, running without sandbox');
      return this.launchUnsandboxed(config);
    }

    return this.launchSandboxed(config);
  }

  private launchSandboxed(config: SandboxConfig): SandboxResult {
    const bwrapArgs = this.buildBwrapArgs(config);

    this.logger.info(`Launching sandboxed process: bwrap ${bwrapArgs.slice(0, 10).join(' ')}...`);

    const process = spawn('bwrap', bwrapArgs, {
      env: {
        ...config.env,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { process, sandboxed: true };
  }

  private launchUnsandboxed(config: SandboxConfig): SandboxResult {
    this.logger.info(`Launching unsandboxed process: ${config.command} ${config.args.join(' ')}`);

    const childProcess = spawn(config.command, config.args, {
      cwd: config.workdir,
      env: {
        ...globalThis.process.env,
        ...config.env,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return { process: childProcess, sandboxed: false };
  }

  private buildBwrapArgs(config: SandboxConfig): string[] {
    const args: string[] = [];

    // Unshare namespaces for isolation
    args.push('--unshare-user');
    args.push('--unshare-pid');
    args.push('--unshare-uts');
    args.push('--unshare-ipc');
    args.push('--unshare-cgroup');

    if (config.isolateNetwork) {
      args.push('--unshare-net');
    }

    // Create new root filesystem
    args.push('--die-with-parent');

    // Mount essential system paths as read-only
    for (const path of BubblewrapSandbox.SYSTEM_PATHS) {
      if (existsSync(path)) {
        args.push('--ro-bind', path, path);
      }
    }

    // Mount /dev with basic devices
    args.push('--dev', '/dev');

    // Mount /proc
    args.push('--proc', '/proc');

    // Mount /tmp as tmpfs
    args.push('--tmpfs', '/tmp');

    // Mount home directory structure (empty)
    args.push('--tmpfs', '/home');

    // Additional read-only binds
    if (config.readonlyBinds) {
      for (const path of config.readonlyBinds) {
        if (existsSync(path)) {
          args.push('--ro-bind', path, path);
        }
      }
    }

    // Mount the working directory with write access
    // This is the key security control - only this directory is writable
    args.push('--bind', config.workdir, config.workdir);

    // Set working directory
    args.push('--chdir', config.workdir);

    // Set environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push('--setenv', key, value);
    }

    // Always set TERM
    args.push('--setenv', 'TERM', 'xterm-256color');

    // The command to run
    args.push(config.command);
    args.push(...config.args);

    return args;
  }

  /**
   * Check if bubblewrap is available on this system.
   */
  public static isAvailable(): boolean {
    return isBwrapAvailable();
  }
}
