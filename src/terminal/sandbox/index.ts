/**
 * Cross-platform Sandbox Factory
 *
 * Automatically selects the appropriate sandbox technology for the current platform:
 * - Linux: bubblewrap (namespace isolation)
 * - macOS: sandbox-exec (Seatbelt)
 * - Windows: none (fallback)
 */
import { spawn } from 'child_process';
import { getLoggerFor } from '@solid/community-server';
import type { Sandbox, SandboxConfig, SandboxResult } from './types';
import { BubblewrapSandbox } from './BubblewrapSandbox';
import { MacOSSandbox } from './MacOSSandbox';

export * from './types';
export { BubblewrapSandbox } from './BubblewrapSandbox';
export { MacOSSandbox } from './MacOSSandbox';

/**
 * No-op sandbox that runs processes without isolation.
 * Used as fallback when no sandbox technology is available.
 */
class NoSandbox implements Sandbox {
  public isAvailable(): boolean {
    return true;
  }

  public launch(config: SandboxConfig): SandboxResult {
    const childProcess = spawn(config.command, config.args, {
      cwd: config.workdir,
      env: {
        ...process.env,
        ...config.env,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      process: childProcess,
      sandboxed: false,
      technology: 'none',
    };
  }
}

/**
 * Sandbox Factory
 */
export class SandboxFactory {
  protected static readonly logger = getLoggerFor('SandboxFactory');

  private static bubblewrap = new BubblewrapSandbox();
  private static macos = new MacOSSandbox();
  private static noSandbox = new NoSandbox();

  /**
   * Get the best available sandbox for the current platform.
   */
  public static getSandbox(): Sandbox {
    if (process.platform === 'linux' && this.bubblewrap.isAvailable()) {
      return this.bubblewrap;
    }

    if (process.platform === 'darwin' && this.macos.isAvailable()) {
      return this.macos;
    }

    this.logger.warn(`No sandbox available for platform ${process.platform}`);
    return this.noSandbox;
  }

  /**
   * Launch a sandboxed process.
   */
  public static launch(config: SandboxConfig): SandboxResult {
    return this.getSandbox().launch(config);
  }

  /**
   * Check if sandbox is available.
   */
  public static isAvailable(): boolean {
    if (process.platform === 'linux') {
      return this.bubblewrap.isAvailable();
    }
    if (process.platform === 'darwin') {
      return this.macos.isAvailable();
    }
    return false;
  }

  /**
   * Get the sandbox technology name.
   */
  public static getTechnology(): 'bubblewrap' | 'sandbox-exec' | 'none' {
    if (process.platform === 'linux' && this.bubblewrap.isAvailable()) {
      return 'bubblewrap';
    }
    if (process.platform === 'darwin' && this.macos.isAvailable()) {
      return 'sandbox-exec';
    }
    return 'none';
  }
}
