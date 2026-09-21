import { spawn, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './TunnelProvider';
import { createTunnelStatus, describeSpawnError } from './TunnelLifecycle';

export interface NgrokTunnelProviderOptions {
  /** ngrok authtoken. Prefer local env/config; do not persist it from xpod. */
  authtoken?: string;

  /** Fixed ngrok endpoint/custom domain passed to `ngrok http --url`. */
  url?: string;

  /** ngrok executable path. */
  ngrokPath?: string;

  /** ngrok local Agent API, used to discover generated dev domains. */
  agentApiUrl?: string;

  /** Startup wait timeout. */
  connectTimeoutMs?: number;
}

/**
 * Starts a user-owned ngrok agent for Local SP access.
 *
 * This provider does not create ngrok resources or write Xpod DNS. A configured
 * url can be a fixed ngrok dev domain or a paid custom domain already owned by
 * the user's ngrok account. When url is omitted, the endpoint is discovered from
 * the local ngrok Agent API after `ngrok http` starts.
 */
export class NgrokTunnelProvider implements TunnelProvider {
  public readonly name = 'ngrok';
  private readonly logger = getLoggerFor(this);

  private readonly authtoken?: string;
  private readonly configuredUrl?: string;
  private readonly ngrokPath: string;
  private readonly agentApiUrl: string;
  private readonly connectTimeoutMs: number;

  private process: ChildProcess | null = null;
  private status: TunnelStatus = {
    running: false,
    connected: false,
  };
  private currentConfig: TunnelConfig | null = null;
  private managedByUs = false;
  /** Origin this instance asked ngrok to expose; the agent answer must match it. */
  private expectedLocalOrigin?: string;

  public constructor(options: NgrokTunnelProviderOptions = {}) {
    this.authtoken = options.authtoken;
    this.configuredUrl = normalizeEndpointForCli(options.url);
    this.ngrokPath = options.ngrokPath ?? 'ngrok';
    this.agentApiUrl = options.agentApiUrl ?? 'http://127.0.0.1:4040';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  }

  public async setup(options: TunnelSetupOptions): Promise<TunnelConfig> {
    const localProtocol = options.localProtocol ?? 'http';
    const originUrl = `${localProtocol}://127.0.0.1:${options.localPort}`;
    const config: TunnelConfig = {
      subdomain: options.subdomain,
      provider: 'ngrok',
      endpoint: normalizeEndpointForConfig(this.configuredUrl) ?? '',
      originUrl,
    };

    this.expectedLocalOrigin = originUrl;
    this.currentConfig = config;
    return config;
  }

  public async start(config?: TunnelConfig): Promise<void> {
    const actualConfig = config ?? this.currentConfig;
    if (!actualConfig?.originUrl) {
      throw new Error('ngrok originUrl is required');
    }

    if (this.process) {
      this.logger.info('ngrok already running (managed by us)');
      return;
    }

    const endpointForCli = normalizeEndpointForCli(actualConfig.endpoint) ?? this.configuredUrl;
    const args = [
      'http',
      '--log', 'stdout',
      '--log-format', 'json',
    ];
    if (endpointForCli) {
      args.push('--url', endpointForCli);
    }
    args.push(actualConfig.originUrl);

    this.status = createTunnelStatus('process-started', {
      endpoint: normalizeEndpointForConfig(endpointForCli),
    });
    this.currentConfig = {
      ...actualConfig,
      endpoint: this.status.endpoint ?? actualConfig.endpoint,
    };
    this.managedByUs = true;

    const env = {
      ...process.env,
      ...(this.authtoken ? { NGROK_AUTHTOKEN: this.authtoken } : {}),
    };

    this.process = spawn(this.ngrokPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    this.process.stdout?.on('data', (data: Buffer) => this.handleOutput(data.toString()));
    this.process.stderr?.on('data', (data: Buffer) => this.handleOutput(data.toString()));

    this.process.on('exit', (code) => {
      this.logger.info(`ngrok exited with code ${code}`);
      this.status = createTunnelStatus('failed', {
        endpoint: this.status.endpoint,
        error: this.status.error ?? (code === 0 ? 'ngrok-exited' : `ngrok exited with code ${code}`),
      });
      this.process = null;
      this.managedByUs = false;
    });

    this.process.on('error', (error) => {
      const described = describeSpawnError('ngrok', this.ngrokPath, error);
      this.logger.error(`Failed to start ngrok: ${described}`);
      this.status = createTunnelStatus('failed', {
        endpoint: this.status.endpoint,
        error: described,
      });
      this.process = null;
      this.managedByUs = false;
    });

    await this.waitForConnection();
  }

  public async stop(): Promise<void> {
    if (!this.managedByUs) {
      // Keep the last error: stopping must not turn a failed tunnel into a clean one.
      this.status = createTunnelStatus('stopped', { endpoint: this.status.endpoint, error: this.status.error });
      return;
    }

    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5_000);
        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.process = null;
    }

    this.status = createTunnelStatus('stopped', { endpoint: this.status.endpoint, error: this.status.error });
    this.managedByUs = false;
  }

  public getStatus(): TunnelStatus {
    return { ...this.status };
  }

  public getEndpoint(): string | undefined {
    return this.currentConfig?.endpoint || this.status.endpoint;
  }

  public async cleanup(_config: TunnelConfig): Promise<void> {
    await this.stop();
    this.currentConfig = null;
  }

  public isManagedByUs(): boolean {
    return this.managedByUs;
  }

  private handleOutput(raw: string): void {
    for (const line of raw.split('\n')) {
      const output = line.trim();
      if (!output) {
        continue;
      }

      const endpoint = extractEndpoint(output);
      if (endpoint) {
        this.markConnected(endpoint);
      } else if (this.status.endpoint && isConnectionLine(output)) {
        this.markConnected(this.status.endpoint);
      }

      const error = extractError(output);
      if (error) {
        this.status.error = mergeError(this.status.error, error);
      }
    }
  }

  private markConnected(endpoint: string): void {
    // Readiness requires a process we still own: without one, any endpoint we just learned
    // about (for example from the machine-wide agent API) belongs to someone else.
    if (!this.process || !this.managedByUs) {
      return;
    }
    const discovered = normalizeEndpointForConfig(endpoint);
    const declared = normalizeEndpointForConfig(this.configuredUrl);
    // A discovered entry has to be a real public endpoint: the local agent's own web
    // interface is not one, and accepting it made a tunnel that published nothing look up.
    if (!declared && (!discovered || isLocalAgentUrl(discovered))) {
      return;
    }
    const effective = declared ?? discovered;
    if (!effective) {
      return;
    }
    if (declared && discovered && normalizeOrigin(declared) !== normalizeOrigin(discovered)) {
      // The operator declared one entry and ngrok published another; report the declared
      // one but leave the discrepancy in the log for whoever has to explain reachability.
      this.logger.warn(`ngrok published ${discovered} while ${declared} is declared; keeping the declared entry`);
    }
    this.status = createTunnelStatus('proxy-ready', {
      endpoint: effective,
      lastHeartbeat: new Date(),
      error: this.status.error,
    });
    this.currentConfig = {
      ...(this.currentConfig ?? { subdomain: 'local', provider: 'ngrok' as const, endpoint: effective }),
      provider: 'ngrok',
      endpoint: effective,
    };
  }

  private async waitForConnection(): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.connectTimeoutMs) {
      if (this.status.connected) {
        return;
      }
      if (!this.status.running && this.status.error) {
        throw new Error(`ngrok failed to start: ${this.status.error}`);
      }

      // The agent API is machine-wide: another instance's agent answers on the same port.
      // Only consult it while this provider actually has a process, otherwise a provider
      // that failed to start would adopt someone else's tunnel as its own.
      if (this.process && this.managedByUs) {
        const endpoint = await this.discoverEndpointFromAgentApi();
        if (endpoint) {
          this.markConnected(endpoint);
          // Discovery may have been refused (foreign entry, no live process); only an
          // actual readiness transition ends the wait.
          if (this.status.connected) {
            return;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(25, this.connectTimeoutMs))));
    }

    if (!this.status.running && this.status.error) {
      throw new Error(`ngrok failed to start: ${this.status.error}`);
    }

    // A timeout must not be reported as a running tunnel that merely lacks a heartbeat:
    // the endpoint is recorded, but the stage says nothing is serving yet.
    this.status = createTunnelStatus('failed', {
      endpoint: this.status.endpoint,
      error: this.status.error ?? 'ngrok-connect-timeout',
    });
    throw new Error(`ngrok connection timeout${this.status.endpoint ? ` for ${this.status.endpoint}` : ''}`);
  }

  private async discoverEndpointFromAgentApi(): Promise<string | undefined> {
    const base = this.agentApiUrl.replace(/\/+$/u, '');
    return await readNgrokAgentEndpoint(`${base}/api/tunnels`, this.expectedLocalOrigin)
      ?? await readNgrokAgentEndpoint(`${base}/api/endpoints`, this.expectedLocalOrigin);
  }
}

/** Loopback endpoints belong to the agent itself, never to a published tunnel. */
export function isLocalAgentUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const normalized = hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
    return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
  } catch {
    return true;
  }
}

async function readNgrokAgentEndpoint(url: string, expectedLocalOrigin?: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }
    const body = await response.json() as unknown;
    return extractEndpointFromAgentBody(body, expectedLocalOrigin);
  } catch {
    return undefined;
  }
}

function extractEndpointFromAgentBody(body: unknown, expectedLocalOrigin?: string): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const lists = [record.tunnels, record.endpoints].filter(Array.isArray) as unknown[][];
  const candidates: Array<{ endpoint: string; address?: string }> = [];
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const value = item as Record<string, unknown>;
      const publicUrl = typeof value.public_url === 'string' ? value.public_url : undefined;
      const url = typeof value.url === 'string' ? value.url : undefined;
      const endpoint = normalizeEndpointForConfig(publicUrl ?? url);
      if (!endpoint?.startsWith('https://') || isLocalAgentUrl(endpoint)) {
        continue;
      }
      const config = value.config;
      const address = config && typeof config === 'object'
        ? (config as Record<string, unknown>).addr
        : undefined;
      candidates.push({ endpoint, ...(typeof address === 'string' ? { address } : {}) });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }
  if (!expectedLocalOrigin) {
    return candidates[0].endpoint;
  }
  // An entry exposing our own origin is ours. When the agent reports no address at all we
  // can only accept it if there is exactly one candidate, otherwise ownership is a guess.
  const matched = candidates.find((candidate) => candidate.address
    && normalizeOrigin(candidate.address) === normalizeOrigin(expectedLocalOrigin));
  if (matched) {
    return matched.endpoint;
  }
  return candidates.length === 1 && !candidates[0].address ? candidates[0].endpoint : undefined;
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
    // `localhost`, `::1` and `127.x` are the same machine; agents spell them differently.
    const host = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
      ? '127.0.0.1'
      : hostname;
    return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return value.trim().replace(/\/+$/u, '');
  }
}

function extractEndpoint(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const direct = typeof parsed.url === 'string' ? parsed.url : undefined;
    const publicUrl = typeof parsed.public_url === 'string' ? parsed.public_url : undefined;
    const msg = typeof parsed.msg === 'string' ? parsed.msg : undefined;
    const endpoint = normalizeEndpointForConfig(direct ?? publicUrl) ?? (msg ? extractEndpointFromText(msg) : undefined);
    if (endpoint) {
      return endpoint;
    }
  } catch {
    // Fall through to text parsing.
  }
  return extractEndpointFromText(output);
}

function extractEndpointFromText(value: string): string | undefined {
  const match = value.match(/https:\/\/[^\s"'<>]+/u);
  return normalizeEndpointForConfig(match?.[0]);
}

function isConnectionLine(output: string): boolean {
  const lower = output.toLowerCase();
  // A bare "started" is not evidence that a tunnel exists: the agent logs it for its own
  // web interface as well.
  return lower.includes('started tunnel')
    || lower.includes('tunnel started')
    || lower.includes('client session established')
    || lower.includes('started tunnel session');
}

function extractError(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed.err === 'string') {
      const error = normalizeNgrokError(parsed.err);
      if (error) {
        return error;
      }
    }
    const level = typeof parsed.lvl === 'string' ? parsed.lvl.toLowerCase() : '';
    const message = typeof parsed.msg === 'string' ? parsed.msg.trim() : '';
    if ((level === 'eror' || level === 'crit') && message) {
      return message;
    }
    return undefined;
  } catch {
    // Fall through to text parsing.
  }

  const lower = output.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('err ') || lower.includes('err_')) {
    return output;
  }
  return undefined;
}

function normalizeNgrokError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower === '<nil>' || lower === 'nil' || lower === 'null' || lower === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function mergeError(previous: string | undefined, next: string): string {
  if (!previous) {
    return next;
  }
  if (/ERR_[A-Z0-9_]+/u.test(previous) && !/ERR_[A-Z0-9_]+/u.test(next)) {
    return previous;
  }
  if (next.trim() === 'ERROR:' && previous.trim().length > next.trim().length) {
    return previous;
  }
  return next.length > previous.length ? next : previous;
}

function normalizeEndpointForConfig(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }
    if (isNgrokNonTunnelUrl(url)) {
      return undefined;
    }
    return url.toString().replace(/\/+$/u, '') + '/';
  } catch {
    return undefined;
  }
}


function isNgrokNonTunnelUrl(url: URL): boolean {
  return (url.hostname === 'ngrok.com' && url.pathname.startsWith('/docs/errors/'))
    || url.hostname === 'dashboard.ngrok.com'
    || url.hostname.endsWith('.ngrok-agent.com');
}

function normalizeEndpointForCli(value: string | undefined): string | undefined {
  const normalized = normalizeEndpointForConfig(value);
  return normalized ? normalized.replace(/\/+$/u, '') : undefined;
}
