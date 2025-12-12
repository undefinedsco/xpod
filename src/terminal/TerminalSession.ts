import { EventEmitter } from 'events';
import { getLoggerFor } from '@solid/community-server';
import type { Session, SessionStatus, SessionConfig } from './types';

// node-pty is optional - will be loaded dynamically
let pty: typeof import('node-pty') | undefined;
try {
  pty = require('node-pty');
} catch {
  // node-pty not available
}

export interface TerminalSessionEvents {
  'data': (data: string) => void;
  'exit': (code: number, signal?: string) => void;
  'error': (error: Error) => void;
}

export class TerminalSession extends EventEmitter {
  protected readonly logger = getLoggerFor(this);
  
  public readonly sessionId: string;
  public readonly userId: string;
  public readonly command: string;
  public readonly workdir: string;
  public readonly createdAt: Date;
  public readonly expiresAt: Date;
  
  private _status: SessionStatus = 'active';
  private ptyProcess?: import('node-pty').IPty;
  private idleTimer?: NodeJS.Timeout;
  private sessionTimer?: NodeJS.Timeout;
  private readonly idleTimeout: number;

  constructor(
    sessionId: string,
    userId: string,
    config: SessionConfig,
    private readonly env: Record<string, string>,
  ) {
    super();
    
    if (!pty) {
      throw new Error('node-pty is not available. Please install it: npm install node-pty');
    }
    
    this.sessionId = sessionId;
    this.userId = userId;
    this.command = config.command;
    this.workdir = config.workdir;
    this.createdAt = new Date();
    this.expiresAt = new Date(Date.now() + config.timeout * 1000);
    this.idleTimeout = 10 * 60 * 1000; // 10 minutes
    
    this.start(config);
  }

  get status(): SessionStatus {
    return this._status;
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  private start(config: SessionConfig): void {
    if (!pty) {
      throw new Error('node-pty is not available');
    }
    
    this.logger.info(`Starting terminal session ${this.sessionId}: ${config.command} ${config.args.join(' ')}`);
    
    try {
      this.ptyProcess = pty.spawn(config.command, config.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: config.workdir,
        env: {
          ...process.env,
          ...this.env,
          TERM: 'xterm-256color',
        },
      });

      this.ptyProcess.onData((data: string) => {
        this.resetIdleTimer();
        this.emit('data', data);
      });

      this.ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.logger.info(`Terminal session ${this.sessionId} exited: code=${exitCode}, signal=${signal}`);
        this._status = 'terminated';
        this.cleanup();
        this.emit('exit', exitCode, signal !== undefined ? String(signal) : undefined);
      });

      // Set session expiration timer
      this.sessionTimer = setTimeout(() => {
        this.logger.info(`Terminal session ${this.sessionId} expired`);
        this.terminate();
      }, config.timeout * 1000);

      // Start idle timer
      this.resetIdleTimer();
      
    } catch (error) {
      this.logger.error(`Failed to start terminal session ${this.sessionId}: ${error}`);
      this._status = 'terminated';
      this.emit('error', error as Error);
      throw error;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    this._status = 'active';
    
    this.idleTimer = setTimeout(() => {
      this.logger.info(`Terminal session ${this.sessionId} idle timeout`);
      this._status = 'idle';
      // Don't terminate on idle, just mark as idle
      // Could add auto-terminate after extended idle if needed
    }, this.idleTimeout);
  }

  public write(data: string): void {
    if (this._status === 'terminated') {
      throw new Error('Session is terminated');
    }
    this.resetIdleTimer();
    this.ptyProcess?.write(data);
  }

  public resize(cols: number, rows: number): void {
    if (this._status === 'terminated') {
      return;
    }
    this.ptyProcess?.resize(cols, rows);
  }

  public sendSignal(signal: string): void {
    if (this._status === 'terminated' || !this.ptyProcess) {
      return;
    }
    
    // node-pty doesn't have a direct signal method, 
    // but we can send control characters for common signals
    switch (signal) {
      case 'SIGINT':
        this.ptyProcess.write('\x03'); // Ctrl+C
        break;
      case 'SIGTSTP':
        this.ptyProcess.write('\x1a'); // Ctrl+Z
        break;
      case 'SIGQUIT':
        this.ptyProcess.write('\x1c'); // Ctrl+\
        break;
      case 'SIGTERM':
      case 'SIGKILL':
        this.terminate();
        break;
      default:
        this.logger.warn(`Unknown signal: ${signal}`);
    }
  }

  public terminate(): void {
    if (this._status === 'terminated') {
      return;
    }
    
    this.logger.info(`Terminating terminal session ${this.sessionId}`);
    this._status = 'terminated';
    
    if (this.ptyProcess) {
      this.ptyProcess.kill();
    }
    
    this.cleanup();
  }

  private cleanup(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = undefined;
    }
  }

  public toJSON(): Session {
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      command: this.command,
      workdir: this.workdir,
      status: this._status,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      ptyPid: this.pid,
    };
  }
}
