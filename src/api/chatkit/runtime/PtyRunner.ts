import { EventEmitter } from 'node:events';
import { getLoggerFor } from 'global-logger-factory';

// node-pty is optional - load dynamically so tests can run in environments without it.
let pty: typeof import('node-pty') | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty');
} catch {
  // optional
}

export interface PtyRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export class PtyRunner extends EventEmitter {
  private readonly logger = getLoggerFor(this);
  private ptyProcess?: import('node-pty').IPty;

  start(options: PtyRunnerOptions): void {
    if (this.ptyProcess) {
      throw new Error('Runner already started');
    }
    if (!pty) {
      throw new Error('node-pty is not available');
    }

    this.ptyProcess = pty.spawn(options.command, options.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        TERM: 'xterm-256color',
        FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
      },
    });

    this.ptyProcess.onData((data: string) => {
      this.emit('data', data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      this.logger.debug(`PTY exited: code=${exitCode}, signal=${signal}`);
      this.emit('exit', Number.isFinite(exitCode) ? exitCode : null, signal !== undefined ? String(signal) : undefined);
      this.ptyProcess = undefined;
    });
  }

  write(text: string): void {
    if (!this.ptyProcess) {
      throw new Error('Runner is not started');
    }
    this.ptyProcess.write(text);
  }

  stop(signal: 'SIGINT' | 'SIGTERM' = 'SIGINT'): void {
    if (!this.ptyProcess) {
      return;
    }
    if (signal === 'SIGINT') {
      this.ptyProcess.write('\x03');
      return;
    }
    this.ptyProcess.kill();
  }

  isRunning(): boolean {
    return Boolean(this.ptyProcess);
  }
}

