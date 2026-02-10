import { spawn, type ChildProcess } from 'node:child_process';
import kill from 'tree-kill';
import type { ServiceConfig, ServiceState, StatusChangeHandler } from './types';

const MAX_RESTARTS = 5;
const MAX_LOGS = 500;

export interface SupervisorLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export class Supervisor {
  private processes: Map<string, ChildProcess> = new Map();
  private states: Map<string, ServiceState> = new Map();
  private configs: Map<string, ServiceConfig> = new Map();
  private logs: SupervisorLog[] = [];
  private onStatusChange?: StatusChangeHandler;
  private isShuttingDown = false;

  constructor() {
    // 确保父进程退出时清理所有子进程
    process.on('exit', () => this.killAll());
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log(`[Supervisor] Received ${signal}, stopping all services...`);
    await this.stopAll();
    process.exit(0);
  }

  private killAll(): void {
    // 同步杀掉所有子进程（用于 process.on('exit')）
    for (const [, child] of this.processes) {
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

  public addLog(source: string, level: SupervisorLog['level'], message: string): void {
    this.logs.push({
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    });

    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
  }

  public getLogs(filters?: {
    level?: string;
    source?: string;
    limit?: number;
  }): SupervisorLog[] {
    let rows = this.logs;

    if (filters?.level) {
      rows = rows.filter((item) => item.level === filters.level);
    }
    if (filters?.source) {
      rows = rows.filter((item) => item.source === filters.source);
    }

    const limit = filters?.limit;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return rows.slice(-limit);
    }

    return rows;
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
  }

  public start(name: string): void {
    const config = this.configs.get(name);
    const state = this.states.get(name);
    if (!config || !state) return;

    if (state.status === 'running' || state.status === 'starting') return;

    console.log(`[Supervisor] Starting ${name}...`);
    this.addLog(name, 'info', 'Service starting');
    this.updateState(name, { status: 'starting', startTime: Date.now() });

    const env = { ...process.env, ...config.env };

    const child = spawn(config.command, config.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: config.cwd || process.cwd(),
      detached: false,
    });

    this.processes.set(name, child);
    this.updateState(name, { status: 'running', pid: child.pid });

    const prefixLog = (source: string, data: Buffer, isError = false): void => {
      const output = data.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (isError) {
          console.error(`[${source}] ${trimmed}`);
          this.addLog(source, 'error', trimmed);
        } else {
          console.log(`[${source}] ${trimmed}`);
          this.addLog(source, 'info', trimmed);
        }
      }
    };

    child.stdout?.on('data', (data) => {
      prefixLog(name, data, false);
    });

    child.stderr?.on('data', (data) => {
      prefixLog(name, data, true);
    });

    child.on('error', (err) => {
      console.error(`[Supervisor] Error spawning ${name}:`, err);
      this.addLog(name, 'error', `Spawn error: ${String(err)}`);
      this.updateState(name, { status: 'crashed' });
    });

    child.on('exit', (code, signal) => {
      console.log(`[Supervisor] ${name} exited with code ${code} signal ${signal}`);
      this.addLog(name, code === 0 ? 'info' : 'error', `Exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);
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
          console.log(`[Supervisor] Restarting ${name} in 2s... (attempt ${restartCount}/${MAX_RESTARTS})`);
          this.addLog(name, 'warn', `Restarting in 2s (attempt ${restartCount}/${MAX_RESTARTS})`);
          setTimeout(() => this.start(name), 2000);
        } else {
          console.error(`[Supervisor] ${name} exceeded max restarts (${MAX_RESTARTS}), giving up`);
          this.addLog(name, 'error', `Exceeded max restarts (${MAX_RESTARTS})`);
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
      this.addLog(name, 'info', 'Stopping service');

      kill(child.pid, 'SIGTERM', (err) => {
        if (err) {
          console.error(`[Supervisor] Failed to kill ${name}:`, err);
          this.addLog(name, 'error', `Failed to stop: ${String(err)}`);
        }
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
