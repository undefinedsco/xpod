/**
 * Sandbox Types for Terminal Sidecar
 *
 * Common interface for cross-platform sandboxing.
 */
import { ChildProcess } from 'child_process';

export interface SandboxConfig {
  /** Working directory to allow access (user must have acl:Control) */
  workdir: string;
  /** Command to execute inside sandbox */
  command: string;
  /** Command arguments */
  args: string[];
  /** Environment variables */
  env: Record<string, string>;
  /** Whether to isolate network (default: false) */
  isolateNetwork?: boolean;
  /** Additional read-only paths */
  readonlyPaths?: string[];
}

export interface SandboxResult {
  /** The spawned child process */
  process: ChildProcess;
  /** Whether the process is running in a sandbox */
  sandboxed: boolean;
  /** The sandbox technology used */
  technology: 'bubblewrap' | 'sandbox-exec' | 'none';
}

export interface Sandbox {
  /**
   * Check if this sandbox technology is available on the current system.
   */
  isAvailable(): boolean;

  /**
   * Launch a sandboxed process.
   */
  launch(config: SandboxConfig): SandboxResult;
}
