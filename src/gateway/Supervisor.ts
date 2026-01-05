import { spawn, type ChildProcess } from 'node:child_process';
import kill from 'tree-kill';
import type { ServiceConfig, ServiceState, ServiceStatus } from './types';

export class Supervisor {
  private processes: Map<string, ChildProcess> = new Map();
  private states: Map<string, ServiceState> = new Map();
  private configs: Map<string, ServiceConfig> = new Map();

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
    state.status = 'starting';
    state.startTime = Date.now();

    const env = { ...process.env, ...config.env };

    const child = spawn(config.command, config.args, {
      stdio: 'inherit', // Pipe logs to main console
      env,
      cwd: config.cwd || process.cwd(),
    });

    this.processes.set(name, child);
    state.pid = child.pid;
    state.status = 'running';

    child.on('error', (err) => {
      console.error(`[Supervisor] Error spawning ${name}:`, err);
      state.status = 'crashed';
    });

    child.on('exit', (code, signal) => {
      console.log(`[Supervisor] ${name} exited with code ${code} signal ${signal}`);
      state.status = 'stopped';
      state.lastExitCode = code ?? undefined;
      state.pid = undefined;
      this.processes.delete(name);

      // Simple auto-restart logic
      // TODO: Add exponential backoff and max retries
      if (code !== 0 && state.status !== 'stopped') {
        state.restartCount++;
        console.log(`[Supervisor] Restarting ${name} in 1s...`);
        setTimeout(() => this.start(name), 1000);
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

      // Mark as stopped so we don't auto-restart
      const state = this.states.get(name);
      if (state) state.status = 'stopped';

      kill(child.pid, 'SIGTERM', (err) => {
        if (err) console.error(`[Supervisor] Failed to kill ${name}:`, err);
        resolve();
      });
    });
  }

  public getStatus(name: string): ServiceState | undefined {
    const state = this.states.get(name);
    if (state && state.status === 'running') {
      state.uptime = state.startTime ? Date.now() - state.startTime : 0;
    }
    return state;
  }

  public getAllStatus(): ServiceState[] {
    return Array.from(this.states.values()).map(s => {
      if (s.status === 'running') {
        return { ...s, uptime: s.startTime ? Date.now() - s.startTime : 0 };
      }
      return s;
    });
  }
}
