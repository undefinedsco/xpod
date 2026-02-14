import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';

export interface PtyRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

/**
 * "PTY" runner (implementation uses stdio pipes).
 *
 * Why not node-pty:
 * - In sandboxed/runtime-restricted environments node-pty can fail to spawn.
 * - For MVP, stdio-based streaming is enough for agents that support non-TTY output.
 *
 * We keep the name stable so higher-level code doesn't churn.
 */
export class PtyRunner extends EventEmitter {
  private readonly logger = getLoggerFor(this);
  private proc?: ChildProcessWithoutNullStreams;

  start(options: PtyRunnerOptions): void {
    if (this.proc) {
      throw new Error('Runner already started');
    }

    this.proc = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
      } as NodeJS.ProcessEnv,
      stdio: 'pipe',
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (data: string) => {
      this.emit('data', data);
    });
    this.proc.stderr.on('data', (data: string) => {
      // Merge stderr into the same stream for now (MVP).
      this.emit('data', data);
    });

    this.proc.on('exit', (code, signal) => {
      this.logger.debug(`Process exited: code=${code}, signal=${signal}`);
      this.emit('exit', code ?? null, signal ?? undefined);
      this.proc = undefined;
    });

    this.proc.on('error', (err) => {
      this.logger.error(`Process spawn error: ${err}`);
      this.emit('error', err);
    });
  }

  write(text: string): void {
    if (!this.proc) {
      throw new Error('Runner is not started');
    }
    this.proc.stdin.write(text);
  }

  stop(signal: 'SIGINT' | 'SIGTERM' = 'SIGINT'): void {
    if (!this.proc) {
      return;
    }
    // Best-effort. If a process doesn't handle SIGINT, caller can follow with SIGTERM.
    this.proc.kill(signal);
  }

  isRunning(): boolean {
    return Boolean(this.proc);
  }
}

