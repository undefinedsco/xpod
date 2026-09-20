import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repairOrigin = 'http://127.0.0.1:5173';
// Vite's WebSocket proxy uses Node socket.destroySoon on rejected upgrades.
// Bun does not implement that API; keep this development tool on Node.
export const repairViteRuntime = 'node';
// Let Vite invalidate its cache from lockfile/config changes, not every crash.
export const repairViteArgs = ['--host', '127.0.0.1', '--port', '5173', '--strictPort'];

export function repairOptions(argv: string[]) {
  let gateway = 'http://127.0.0.1:3000';
  let desktop = false;
  let env: string | undefined;
  let config: string | undefined;
  let mode = 'local';
  let extra: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (option === '--') { extra = argv.slice(index + 1); break; }
    if (option === '--desktop') { desktop = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Incomplete option: ${option}`);
    if (option === '--gateway') gateway = value;
    else if (option === '--env' || option === '-e') env = value;
    else if (option === '--config' || option === '-c') config = value;
    else if (option === '--mode' || option === '-m') mode = value;
    else throw new Error(`Unknown option: ${option}`);
  }
  const url = new URL(gateway);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--gateway must be a local HTTP transport origin');
  }
  if (url.port === '5173') throw new Error('Gateway cannot use the Vite repair port');
  if (!['local', 'cloud'].includes(mode)) throw new Error('--mode must be local or cloud; use --config for other profiles');
  if (extra.some((value) => /^(--(host|port|foreground|env|config|mode)(=|$)|-[pemc])/.test(value))) {
    throw new Error('Use monitor options for transport/profile; CLI passthrough cannot override ownership');
  }
  return { gateway: url.origin, desktop, env: env ?? `.env.${mode}`, config, mode, extra };
}

export function repairGatewayArgs(options: ReturnType<typeof repairOptions>): string[] {
  const url = new URL(options.gateway);
  return ['--no-env-file', 'src/cli/index.ts', 'start', '--env', options.env,
    ...(options.config ? ['--config', options.config] : ['--mode', options.mode]),
    ...options.extra, '--host', url.hostname.replace(/^\[|\]$/g, ''), '--port', url.port || '80', '--foreground'];
}

export function repairDesktopEnv(env: NodeJS.ProcessEnv, profileRoot = root): NodeJS.ProcessEnv {
  // The dev shell opens the same WebID entry the packaged shell does, so the
  // dev loop exercises the product's real first screen.
  return { ...env, XPOD_DESKTOP_URL: `${repairOrigin}/ai-connections`,
    XPOD_DESKTOP_USER_DATA_DIR: path.join(profileRoot, '.test-data/dev-repair/desktop-profile') };
}

type Service = 'gateway' | 'vite' | 'desktop';
export type Change = 'server' | 'packages' | 'desktop' | `recover-${Service}`;
export function repairChange(file: string): Change | undefined {
  const normalized = file.replaceAll('\\', '/');
  if (/\.tsbuildinfo$/.test(normalized)) return;
  if (normalized.split('/').some((part) => ['dist', 'static', 'node_modules', '.test-data', '.git'].includes(part))) return;
  if (/^desktop\/(src\/|assets\/|tsconfig\.json$|package\.json$)/.test(normalized)) return 'desktop';
  if (/^(package\.json|bun\.lock)$/.test(normalized) || /^patches\//.test(normalized)) return 'packages';
  if (/^packages\//.test(normalized)) return 'packages';
  if (/^(src|config|templates)\//.test(normalized)) return 'server';
}

/** One build at a time; edits during a build stay queued for the next pass. */
export class RepairQueue {
  private pending = new Set<Change>();
  private failed = new Set<Change>();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  constructor(private readonly rebuild: (changes: Set<Change>) => Promise<void>,
    private readonly report: (error: unknown) => void, private readonly delay = 300) {}
  mark(change: Change) {
    if (this.stopped) return;
    if (!change.startsWith('recover-')) {
      for (const retry of this.failed) this.pending.add(retry);
      this.failed.clear();
    }
    this.pending.add(change);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.drain(); }, this.delay);
  }
  async drain(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      while (!this.stopped && this.pending.size) {
        const changes = this.pending;
        this.pending = new Set();
        try { await this.rebuild(changes); } catch (error) {
          const edited = [...this.pending].some((pending) => !pending.startsWith('recover-'));
          for (const change of changes) {
            this.failed.add(change);
            if (edited) this.pending.add(change);
          }
          this.report(error);
        }
      }
    })();
    try { await this.active; } finally { this.active = undefined; }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.pending.clear(); }
}

/** Retry service exits without rerunning builds or disturbing healthy children. */
export class RepairRecovery {
  private timers = new Map<Service, ReturnType<typeof setTimeout>>();
  private attempts = new Map<Service, number>();
  private started = new Map<Service, number>();
  private stopped = false;
  constructor(private readonly recover: (service: Service) => void | Promise<void>,
    private readonly report: (message: string) => void,
    private readonly delays = [500, 1000, 2000, 5000, 10000]) {}
  ready(service: Service) { this.started.set(service, Date.now()); }
  schedule(service: Service) {
    if (this.stopped || this.timers.has(service)) return;
    // A brief readiness success must not reset a crash loop's retry budget.
    const since = this.started.get(service);
    if (since !== undefined && Date.now() - since >= 30000) this.attempts.delete(service);
    this.started.delete(service);
    const attempt = this.attempts.get(service) ?? 0;
    if (attempt >= this.delays.length) {
      this.report(`${service} recovery exhausted; fix the cause and edit a source to retry`);
      return;
    }
    this.attempts.set(service, attempt + 1);
    this.report(`${service} recovery ${attempt + 1}/${this.delays.length} in ${this.delays[attempt]}ms`);
    this.timers.set(service, setTimeout(() => {
      this.timers.delete(service);
      void Promise.resolve().then(() => this.recover(service)).catch((error) => {
        this.report(String(error)); this.schedule(service);
      });
    }, this.delays[attempt]));
  }
  reset(service: Service) {
    clearTimeout(this.timers.get(service)); this.timers.delete(service);
    this.attempts.delete(service); this.started.delete(service);
  }
  stop() { this.stopped = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}

export async function waitForRepairReady(probe: () => Promise<void>, label: string,
  exited: () => boolean, stopping = () => false) {
  let successes = 0;
  for (let attempt = 0; attempt < 240 && !stopping(); attempt++) {
    if (exited()) throw new Error(`${label} exited before readiness`);
    try { await probe(); successes++; } catch { successes = 0; }
    // Wait for sustained readiness and recheck the child after probing: an old
    // listener can answer while our strict-port child is still failing startup.
    if (exited()) throw new Error(`${label} exited before readiness`);
    if (successes >= 3) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready`);
}

export async function assertRepairPortAvailable(origin: string): Promise<void> {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 80);
  const occupied = () => new Error(`Port occupied at ${origin}; stop the known development instance before starting the monitor.`);
  // Bun/macOS can bind a specific address beside a wildcard listener. A bind
  // probe alone can therefore accept a transport already serving another app.
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); reject(occupied()); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`Cannot verify transport availability at ${origin}`)); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(occupied()));
    probe.listen(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ''), () => probe.close(() => resolve()));
  });
}

export class RepairChildren {
  private owned = new Map<ChildProcess, Promise<void>>();
  private expected = new Set<ChildProcess>();
  private stopping = new Map<ChildProcess, Promise<void>>();
  constructor(private readonly unexpected: (error: Error) => void) {}
  launch(command: string, args: string[], cwd: string, env = process.env, service: boolean | ((error: Error) => void) = false, onStdout?: (output: string) => void): ChildProcess {
    const report = typeof service === 'function' ? service : this.unexpected;
    const child = spawn(command, args, { cwd, env, stdio: onStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit', detached: process.platform !== 'win32' });
    child.stdout?.on('data', (data: Buffer) => { process.stdout.write(data); onStdout?.(data.toString()); });
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0 || this.expected.has(child)) resolve();
        else reject(new Error(`${command} exited (${signal || code})`));
        if (service && !this.expected.has(child) && code === 0) report(new Error(`${command} service exited (${signal || code})`));
      });
    });
    this.owned.set(child, done);
    void done.catch((error) => { if (service && !this.expected.has(child)) report(error); });
    return child;
  }
  async completed(child: ChildProcess) {
    try { await this.owned.get(child); } finally { this.owned.delete(child); }
  }
  stop(child: ChildProcess): Promise<void> {
    const previous = this.stopping.get(child);
    if (previous) return previous;
    const done = this.stopChild(child);
    this.stopping.set(child, done);
    return done;
  }
  private async stopChild(child: ChildProcess) {
    this.expected.add(child);
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, value); else child.kill(value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const timeout = setTimeout(() => signal('SIGKILL'), 8000);
    try { await this.completed(child); } catch { /* The shutdown owns this exit. */ }
    finally { clearTimeout(timeout); this.expected.delete(child); }
  }
  async stopAll() { await Promise.all([...this.owned.keys()].map((child) => this.stop(child))); }
}

async function checkGateway(origin: string) {
  const response = await fetch(`${origin}/service/status`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Gateway: HTTP ${response.status}`);
  const services = await response.json() as { name: string; status: string }[];
  if (!Array.isArray(services) || !['css', 'api'].every((name) => services.some((service) => service.name === name && service.status === 'running'))) {
    throw new Error('Gateway CSS/API services must be running');
  }
}

export async function runDevRepair(argv: string[]) {
  const options = repairOptions(argv);
  if (!existsSync(path.resolve(root, options.env))) throw new Error(`Env file not found: ${options.env}`);
  if (options.config && !existsSync(path.resolve(root, options.config))) throw new Error(`Config file not found: ${options.config}`);
  await assertRepairPortAvailable(options.gateway);
  await assertRepairPortAvailable(repairOrigin);
  let stopping = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  let fatal: Error | undefined;
  const children = new RepairChildren((error) => { fatal = error; shutdown(); });
  const watchers: FSWatcher[] = [];
  let queue: RepairQueue | undefined;
  let initialized = false;
  const recovery = new RepairRecovery((service) => { queue?.mark(`recover-${service}`); },
    (message) => console.error(`[monitor] ${message}`));
  const shutdown = () => {
    if (stopping) return;
    stopping = true; recovery.stop(); queue?.stop(); for (const watcher of watchers) watcher.close();
    void children.stopAll(); finish();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const command = async (args: string[], cwd = root) => {
    if (stopping) throw new Error('Monitor stopping');
    await children.completed(children.launch('bun', args, cwd));
  };
  let gateway: ChildProcess | undefined;
  let vite: ChildProcess | undefined;
  let desktop: ChildProcess | undefined;
  const startGateway = async () => {
    if (stopping) return;
    await assertRepairPortAvailable(options.gateway);
    gateway = children.launch('bun', repairGatewayArgs(options), root, { ...process.env, NODE_ENV: 'development' }, (error) => {
      console.error('[monitor] Gateway stopped:', error.message); recovery.schedule('gateway');
    });
    await waitForRepairReady(() => checkGateway(options.gateway), 'Gateway', () => gateway!.exitCode !== null || gateway!.signalCode !== null, () => stopping);
    recovery.ready('gateway');
    console.log(`[monitor] Gateway ready pid=${gateway.pid} transport=${options.gateway}`);
  };
  const startVite = async () => {
    if (stopping) return;
    await assertRepairPortAvailable(repairOrigin);
    const uiRequire = createRequire(path.join(root, 'ui/package.json'));
    const viteBin = path.resolve(path.dirname(uiRequire.resolve('vite/package.json')), 'bin/vite.js');
    let output = '';
    let listening = false;
    vite = children.launch(repairViteRuntime, [viteBin, ...repairViteArgs], path.join(root, 'ui'), {
      ...process.env, XPOD_DEV_GATEWAY_URL: options.gateway,
    }, (error) => { console.error('[monitor] Vite stopped:', error.message); recovery.schedule('vite'); }, (chunk) => {
      output = (output + chunk).slice(-4096);
      // Vite emits this only after its own strict-port listener has bound.
      listening ||= /VITE[^\n]*ready in/.test(output);
    });
    await waitForRepairReady(async () => {
      if (!listening) throw new Error('Owned Vite listener not ready');
      const response = await fetch(`${repairOrigin}/@vite/client`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('Vite not ready');
    }, 'Vite', () => vite!.exitCode !== null || vite!.signalCode !== null, () => stopping);
    recovery.ready('vite');
  };
  const startDesktop = () => {
    if (stopping) return;
    const desktopRequire = createRequire(path.join(root, 'desktop/package.json'));
    desktop = children.launch(desktopRequire('electron') as string, ['dist/main.js'], path.join(root, 'desktop'), repairDesktopEnv(process.env), (error) => {
      // Electron exits successfully when an existing shell owns the profile.
      if (desktop?.exitCode === 0) return;
      console.error('[monitor] Desktop stopped:', error.message); recovery.schedule('desktop');
    });
  };
  const restart = async (service: Service) => {
    const child = { gateway, vite, desktop }[service];
    if (child) await children.stop(child);
    try {
      if (service === 'gateway') await startGateway();
      else if (service === 'vite') await startVite();
      else { startDesktop(); recovery.ready('desktop'); }
    } catch (error) {
      console.error(`[monitor] ${service} restart failed:`, (error as Error).message);
      const failed = { gateway, vite, desktop }[service];
      if (failed) await children.stop(failed);
      recovery.schedule(service);
    }
  };
  try {
    queue = new RepairQueue(async (changes) => {
      if (stopping) return;
      const services = ['gateway', 'vite', 'desktop'] as const;
      const sourceChanges = [...changes].some((change) => !change.startsWith('recover-'));
      if (!sourceChanges) {
        for (const service of services) {
          if (!changes.has(`recover-${service}`)) continue;
          const child = { gateway, vite, desktop }[service];
          if (!child || child.exitCode !== null || child.signalCode !== null) await restart(service);
        }
        return;
      }
      for (const service of services) recovery.reset(service);
      const packagesChanged = !initialized || changes.has('packages');
      const serverChanged = !initialized || changes.has('server') || packagesChanged;
      const desktopChanged = !initialized || changes.has('desktop');
      console.log(`[monitor] Rebuilding ${[...changes].join(', ')}`);
      // Keep running services alive until every required build succeeds.
      if (packagesChanged) await command(['run', 'build:packages']);
      if (serverChanged) { await command(['run', 'build:ts']); await command(['run', 'build:components']); }
      if (options.desktop && desktopChanged) await command(['run', 'build'], path.join(root, 'desktop'));
      if (stopping) return;
      if (serverChanged || !gateway || gateway.exitCode !== null || gateway.signalCode !== null) await restart('gateway');
      if (!vite || vite.exitCode !== null || vite.signalCode !== null) await restart('vite');
      if (options.desktop && (desktopChanged || !desktop || desktop.exitCode !== null || desktop.signalCode !== null)) await restart('desktop');
      initialized = true;
      console.log('[monitor] Changes applied');
    }, (error) => console.error('[monitor] Build/reload failed; watching for the next edit:', (error as Error).message));
    // Watch before the first build so startup edits also enter the dirty queue.
    const watchDirectory = (directory: string) => {
      if (!existsSync(path.join(root, directory))) return;
      const watcher = watch(path.join(root, directory), { recursive: true }, (_event, file) => {
        const change = file && repairChange(`${directory}/${file}`);
        if (change) queue?.mark(change);
      });
      watcher.on('error', (error) => { fatal = error; shutdown(); });
      watchers.push(watcher);
    };
    for (const directory of ['src', 'config', 'templates', 'packages', 'patches', 'desktop']) watchDirectory(directory);
    // Explicit profile files may live outside the standard watched directories.
    for (const file of [options.env, options.config, 'package.json', 'bun.lock'].filter((value): value is string => Boolean(value))) {
      const absolute = path.resolve(root, file);
      if (!existsSync(path.dirname(absolute))) continue;
      watchers.push(watch(path.dirname(absolute), (_event, changed) => {
        if (changed?.toString() === path.basename(absolute)) queue?.mark(repairChange(path.relative(root, absolute)) ?? 'server');
      }));
    }
    console.log(`[monitor] Watching sources. UI: ${repairOrigin}/.account/login/password/`);
    queue.mark('packages');
    await queue.drain();
    await finished;
    if (fatal) throw fatal;
  } finally {
    shutdown();
    await children.stopAll();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Bun must not freeze a dotenv snapshot into the monitor's parent environment.
  // Each Gateway child reads the selected profile afresh; explicit shell env wins.
  if (!process.execArgv.includes('--no-env-file')) {
    console.error('Use bun run dev, or bun --no-env-file scripts/dev-repair.ts.');
    process.exitCode = 1;
  } else {
    runDevRepair(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
