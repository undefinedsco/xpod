import { spawn, type ChildProcess } from 'node:child_process';
import kill from 'tree-kill';
import type { ServiceConfig, ServiceState, StatusChangeHandler } from './types';
import { logger } from '../util/logger';

const MAX_RESTARTS = 5;

export class Supervisor {
  private processes: Map<string, ChildProcess> = new Map();
  private states: Map<string, ServiceState> = new Map();
  private configs: Map<string, ServiceConfig> = new Map();
  private onStatusChange?: StatusChangeHandler;
  private isShuttingDown = false;
  private logBuffer: Array<{ timestamp: string; level: 'info' | 'warn' | 'error'; source: string; message: string }> = [];
  private static readonly MAX_LOGS = 1000;

  constructor() {
    // 确保父进程退出时清理所有子进程
    process.on('exit', () => this.killAll());
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  public addLog(source: string, level: 'info' | 'warn' | 'error', message: string) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    this.logBuffer.push({ timestamp, level, source, message });
    if (this.logBuffer.length > Supervisor.MAX_LOGS) {
      this.logBuffer.shift();
    }
  }

  public getLogs() {
    return this.logBuffer;
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logger.log(`Received ${signal}, stopping all services...`);
    await this.stopAll();
    process.exit(0);
  }

  private killAll(): void {
    // 同步杀掉所有子进程（用于 process.on('exit')）
    for (const [name, child] of this.processes) {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // 进程可能已经退出
        }
      }
    }
  }

  public setStatusChangeHandler(handler: StatusChangeHandler): void {
    this.onStatusChange = handler;
  }

  public register(config: ServiceConfig): void {
    this.configs.set(config.name, config);
    this.states.set(config.name, {
      name: config.name,
      status: 'stopped',
      restartCount: 0,
    });
  }

  public async startAll(): Promise<void> {
    for (const name of this.configs.keys()) {
      this.start(name);
    }
  }

  public async stopAll(): Promise<void> {
    this.isShuttingDown = true;
    const promises: Promise<void>[] = [];
    for (const name of this.processes.keys()) {
      promises.push(this.stop(name));
    }
    await Promise.all(promises);
    this.isShuttingDown = false; // Reset for restart
  }

  /**
   * Reset restart counts for all services (used before manual restart)
   */
  public resetRestartCounts(): void {
    for (const state of this.states.values()) {
      state.restartCount = 0;
    }
  }

  public start(name: string): void {
    const config = this.configs.get(name);
    const state = this.states.get(name);
    if (!config || !state) return;

    if (state.status === 'running' || state.status === 'starting') return;

    logger.log(`Starting ${name}...`);
    this.updateState(name, { status: 'starting', startTime: Date.now() });

    const env = { ...process.env, ...config.env };

    const child = spawn(config.command, config.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: config.cwd || process.cwd(),
      detached: false, // 确保子进程不脱离父进程
    });

    this.processes.set(name, child);
    this.updateState(name, { status: 'running', pid: child.pid });

    child.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[${name}] ${msg}`);
      this.addLog(name, 'info', msg);
    });

    child.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      console.error(`[${name}] ${msg}`);
      this.addLog(name, 'error', msg);
    });

    child.on('error', (err) => {
      logger.error(`Error spawning ${name}:`, err);
      this.updateState(name, { status: 'crashed' });
    });

    child.on('exit', (code, signal) => {
      logger.log(`${name} exited with code ${code} signal ${signal}`);
      const currentState = this.states.get(name);
      const wasManualStop = currentState?.status === 'stopped';

      this.updateState(name, {
        status: 'stopped',
        lastExitCode: code ?? undefined,
        pid: undefined,
      });
      this.processes.delete(name);

      // Auto-restart on crash (not on manual stop or shutdown)
      if (code !== 0 && !wasManualStop && !this.isShuttingDown) {
        const newState = this.states.get(name);
        const restartCount = (newState?.restartCount || 0) + 1;

        if (restartCount <= MAX_RESTARTS) {
          this.updateState(name, { restartCount });
          logger.log(`Restarting ${name} in 2s... (attempt ${restartCount}/${MAX_RESTARTS})`);
          setTimeout(() => this.start(name), 2000);
        } else {
          logger.error(`${name} exceeded max restarts (${MAX_RESTARTS}), giving up`);
        }
      }
    });
  }

  public stop(name: string): Promise<void> {
    return new Promise((resolve) => {
      const child = this.processes.get(name);
      if (!child || !child.pid) {
        resolve();
        return;
      }

      // Mark as stopped first to prevent auto-restart
      this.updateState(name, { status: 'stopped' });

      kill(child.pid, 'SIGTERM', (err) => {
        if (err) logger.error(`Failed to kill ${name}:`, err);
        resolve();
      });
    });
  }

  public getStatus(name: string): ServiceState | undefined {
    const state = this.states.get(name);
    if (state && state.status === 'running' && state.startTime) {
      return { ...state, uptime: Date.now() - state.startTime };
    }
    return state;
  }

  public getAllStatus(): ServiceState[] {
    return Array.from(this.states.values()).map((s) => {
      if (s.status === 'running' && s.startTime) {
        return { ...s, uptime: Date.now() - s.startTime };
      }
      return s;
    });
  }

  private updateState(name: string, update: Partial<ServiceState>): void {
    const state = this.states.get(name);
    if (state) {
      Object.assign(state, update);
      this.onStatusChange?.(name, { ...state });
    }
  }
}
