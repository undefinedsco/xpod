/**
 * Bubblewrap Sandbox (Linux)
 *
 * Uses Linux namespaces via bubblewrap for process isolation.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { getLoggerFor } from 'global-logger-factory';
import type { Sandbox, SandboxConfig, SandboxResult } from './types';

let bwrapAvailable: boolean | undefined;

export class BubblewrapSandbox implements Sandbox {
  protected readonly logger = getLoggerFor(this);

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

  public isAvailable(): boolean {
    if (bwrapAvailable === undefined) {
      try {
        execSync('which bwrap', { stdio: 'ignore' });
        bwrapAvailable = true;
      } catch {
        bwrapAvailable = false;
      }
    }
    return bwrapAvailable;
  }

  public launch(config: SandboxConfig): SandboxResult {
    const args = this.buildArgs(config);

    this.logger.info(`Launching bubblewrap sandbox: ${config.command}`);

    const childProcess = spawn('bwrap', args, {
      env: {
        ...config.env,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      process: childProcess,
      sandboxed: true,
      technology: 'bubblewrap',
    };
  }

  private buildArgs(config: SandboxConfig): string[] {
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

    args.push('--die-with-parent');

    // Mount essential system paths as read-only
    for (const path of BubblewrapSandbox.SYSTEM_PATHS) {
      if (existsSync(path)) {
        args.push('--ro-bind', path, path);
      }
    }

    // Mount /dev, /proc, /tmp
    args.push('--dev', '/dev');
    args.push('--proc', '/proc');
    args.push('--tmpfs', '/tmp');
    args.push('--tmpfs', '/home');

    // Additional read-only paths
    if (config.readonlyPaths) {
      for (const path of config.readonlyPaths) {
        if (existsSync(path)) {
          args.push('--ro-bind', path, path);
        }
      }
    }

    // Mount the working directory with write access
    args.push('--bind', config.workdir, config.workdir);
    args.push('--chdir', config.workdir);

    // Environment variables
    for (const [key, value] of Object.entries(config.env)) {
      args.push('--setenv', key, value);
    }
    args.push('--setenv', 'TERM', 'xterm-256color');

    // Command
    args.push(config.command);
    args.push(...config.args);

    return args;
  }
}
