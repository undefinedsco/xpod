import { spawn, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './TunnelProvider';

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

    this.status = {
      running: true,
      connected: false,
      endpoint: normalizeEndpointForConfig(endpointForCli),
    };
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
      this.status = {
        running: false,
        connected: false,
        endpoint: this.status.endpoint,
        error: this.status.error ?? (code === 0 ? undefined : `ngrok exited with code ${code}`),
      };
      this.process = null;
      this.managedByUs = false;
    });

    this.process.on('error', (error) => {
      this.logger.error(`Failed to start ngrok: ${error.message}`);
      this.status = {
        running: false,
        connected: false,
        endpoint: this.status.endpoint,
        error: error.message,
      };
      this.process = null;
      this.managedByUs = false;
    });

    await this.waitForConnection();
  }

  public async stop(): Promise<void> {
    if (!this.managedByUs) {
      this.status = { running: false, connected: false, endpoint: this.status.endpoint };
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

    this.status = { running: false, connected: false, endpoint: this.status.endpoint };
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
    const normalized = normalizeEndpointForConfig(endpoint);
    if (!normalized) {
      return;
    }
    this.status.connected = true;
    this.status.endpoint = normalized;
    this.status.lastHeartbeat = new Date();
    this.currentConfig = {
      ...(this.currentConfig ?? { subdomain: 'local', provider: 'ngrok' as const, endpoint: normalized }),
      provider: 'ngrok',
      endpoint: normalized,
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

      const endpoint = await this.discoverEndpointFromAgentApi();
      if (endpoint) {
        this.markConnected(endpoint);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(25, this.connectTimeoutMs))));
    }

    if (!this.status.running && this.status.error) {
      throw new Error(`ngrok failed to start: ${this.status.error}`);
    }

    if (this.status.endpoint) {
      this.logger.warn('ngrok connection was not confirmed before timeout; keeping configured endpoint as degraded.');
      this.status.connected = false;
      return;
    }

    throw new Error('ngrok connection timeout');
  }

  private async discoverEndpointFromAgentApi(): Promise<string | undefined> {
    const base = this.agentApiUrl.replace(/\/+$/u, '');
    return await readNgrokAgentEndpoint(`${base}/api/tunnels`)
      ?? await readNgrokAgentEndpoint(`${base}/api/endpoints`);
  }
}

async function readNgrokAgentEndpoint(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return undefined;
    }
    const body = await response.json() as unknown;
    return extractEndpointFromAgentBody(body);
  } catch {
    return undefined;
  }
}

function extractEndpointFromAgentBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const lists = [record.tunnels, record.endpoints].filter(Array.isArray) as unknown[][];
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const value = item as Record<string, unknown>;
      const publicUrl = typeof value.public_url === 'string' ? value.public_url : undefined;
      const url = typeof value.url === 'string' ? value.url : undefined;
      const endpoint = normalizeEndpointForConfig(publicUrl ?? url);
      if (endpoint?.startsWith('https://')) {
        return endpoint;
      }
    }
  }
  return undefined;
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
  return lower.includes('started tunnel')
    || lower.includes('tunnel started')
    || lower.includes('client session established')
    || lower.includes('started');
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
