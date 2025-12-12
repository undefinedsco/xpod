/**
 * macOS Sandbox (sandbox-exec / Seatbelt)
 *
 * Uses macOS sandbox-exec with Seatbelt profiles for process isolation.
 */
import { spawn, execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getLoggerFor } from '@solid/community-server';
import type { Sandbox, SandboxConfig, SandboxResult } from './types';

let sandboxExecAvailable: boolean | undefined;

export class MacOSSandbox implements Sandbox {
  protected readonly logger = getLoggerFor(this);

  public isAvailable(): boolean {
    if (sandboxExecAvailable === undefined) {
      try {
        // Check if we're on macOS and sandbox-exec exists
        if (process.platform !== 'darwin') {
          sandboxExecAvailable = false;
        } else {
          execSync('which sandbox-exec', { stdio: 'ignore' });
          sandboxExecAvailable = true;
        }
      } catch {
        sandboxExecAvailable = false;
      }
    }
    return sandboxExecAvailable;
  }

  public launch(config: SandboxConfig): SandboxResult {
    const profilePath = this.createProfile(config);

    this.logger.info(`Launching macOS sandbox: ${config.command}`);

    const childProcess = spawn('sandbox-exec', ['-f', profilePath, config.command, ...config.args], {
      cwd: config.workdir,
      env: {
        ...process.env,
        ...config.env,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Clean up profile after process exits
    childProcess.on('exit', () => {
      try {
        unlinkSync(profilePath);
      } catch {
        // Ignore cleanup errors
      }
    });

    return {
      process: childProcess,
      sandboxed: true,
      technology: 'sandbox-exec',
    };
  }

  /**
   * Create a Seatbelt profile for the sandbox.
   *
   * Strategy: Allow most operations by default, then deny writes outside workdir.
   * This is more robust than deny-by-default which breaks many macOS subsystems.
   *
   * Profile:
   * - Allow default (reading, processes, etc.)
   * - Deny writes to root filesystem
   * - Allow writes only to: workdir, temp dirs, var/folders
   * - Optionally deny network
   */
  private createProfile(config: SandboxConfig): string {
    const profileId = randomUUID().replace(/-/g, '').slice(0, 8);
    const profilePath = join(tmpdir(), `xpod-sandbox-${profileId}.sb`);

    const rules: string[] = [
      '(version 1)',
      '',
      '; Allow most operations by default (macOS needs many subsystems)',
      '(allow default)',
      '',
      '; Deny writes to the entire filesystem by default',
      '(deny file-write* (subpath "/"))',
      '',
      '; Allow writes to workdir',
      `(allow file-write* (subpath "${config.workdir}"))`,
      '',
      '; Allow writes to temp directories',
      '(allow file-write* (subpath "/private/tmp"))',
      '(allow file-write* (subpath "/tmp"))',
      `(allow file-write* (subpath "${tmpdir()}"))`,
      '(allow file-write* (subpath "/var/folders"))',
      '(allow file-write* (subpath "/private/var/folders"))',
    ];

    // Network isolation
    if (config.isolateNetwork) {
      rules.push('');
      rules.push('; Deny network access');
      rules.push('(deny network*)');
    }

    // Additional read-only paths (already readable by default)
    if (config.readonlyPaths) {
      rules.push('');
      rules.push('; Additional read-only paths (already allowed by default)');
      for (const p of config.readonlyPaths) {
        rules.push(`; readonly: ${p}`);
      }
    }

    const profile = rules.join('\n');
    writeFileSync(profilePath, profile);

    this.logger.debug(`Created sandbox profile: ${profilePath}`);
    return profilePath;
  }
}
