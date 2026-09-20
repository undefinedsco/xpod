/**
 * SakuraFRP Tunnel Provider
 *
 * 使用 SakuraFRP 提供隧道服务
 * 用于没有公网 IP 的 Local 节点
 *
 * 凭据就是控制台「配置文件」里那串启动参数 (`<访问密钥>:<隧道ID>`)。公网入口
 * **不由用户声明**：控制台只让用户选节点和本地端口，访问地址是平台分配的，因此
 * provider 用同一个凭据向 SakuraFrp 开放 API 查询分配结果（节点地址 + 远程端口），
 * 声明字段只作为 API 不可用时的可选兜底。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import { createTunnelStatus, describeSpawnError } from './TunnelLifecycle';
import type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './TunnelProvider';

/**
 * SakuraFRP Tunnel Provider 配置
 */
export interface SakuraFrpTunnelProviderOptions {
  /** SakuraFRP 启动参数 (`<访问密钥>:<隧道ID>[,<隧道ID>...]`)，来自 SAKURA_TUNNEL_TOKEN */
  token: string;

  /** Optional declared endpoint, used only when the provider cannot be asked. */
  publicUrl?: string;

  /** frpc 可执行文件路径 (默认 'frpc') */
  frpcPath?: string;

  /** 等待代理发布的毫秒数；超时后状态为 failed */
  connectTimeoutMs?: number;

  /** SakuraFRP 服务端地址 (如果需要自定义) */
  serverAddr?: string;

  /** SakuraFrp open API base, where the assigned public entry can be read back. */
  apiBaseUrl?: string;

  /** Injection point for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Where SakuraFrp assigns each tunnel's public entry. */
const DEFAULT_SAKURA_API_BASE_URL = 'https://api.natfrp.com/v4';

interface SakuraTunnelRecord {
  id?: number | string;
  node?: number | string;
  type?: string;
  remote?: string;
  extra?: string;
}

/**
 * SakuraFRP Tunnel Provider
 *
 * 通过 frpc 客户端连接 SakuraFRP 服务
 */
export class SakuraFrpTunnelProvider implements TunnelProvider {
  public readonly name = 'sakura-frp';
  private readonly logger = getLoggerFor(this);

  private readonly token: string;
  private readonly publicUrl?: string;
  private readonly frpcPath: string;
  private readonly connectTimeoutMs: number;
  private readonly serverAddr?: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  /** Endpoint the platform assigned, once discovery has answered. */
  private discoveredEndpoint?: string;

  private process: ChildProcess | null = null;
  private status: TunnelStatus = {
    running: false,
    connected: false,
  };
  private currentConfig: TunnelConfig | null = null;
  private managedByUs = false;

  constructor(options: SakuraFrpTunnelProviderOptions) {
    this.token = options.token;
    this.publicUrl = normalizePublicEndpoint(options.publicUrl);
    this.frpcPath = options.frpcPath ?? 'frpc';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    this.serverAddr = options.serverAddr;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_SAKURA_API_BASE_URL).replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Reads back the entry the platform assigned to this tunnel.
   *
   * The console never asks for a domain: for a TCP tunnel it assigns a node host and a
   * remote port, and for a bound tunnel it assigns the domain itself. Asking the provider
   * is therefore the only honest way to learn the entry, and a failure to ask changes
   * nothing except that the status stops short of naming an endpoint.
   */
  private async discoverEndpoint(): Promise<string | undefined> {
    const { accessKey, tunnelIds } = parseSakuraCredential(this.token);
    if (!accessKey) {
      return undefined;
    }
    try {
      const tunnels = await this.fetchJson<SakuraTunnelRecord[]>('/tunnels', accessKey);
      if (!Array.isArray(tunnels)) {
        return undefined;
      }
      const selected = tunnelIds.length > 0
        ? tunnels.filter((tunnel) => tunnelIds.includes(String(tunnel?.id ?? '')))
        : tunnels;
      const tunnel = selected[0];
      if (!tunnel) {
        return undefined;
      }
      const remote = typeof tunnel.remote === 'string' ? tunnel.remote.trim() : '';
      if (!remote) {
        return undefined;
      }
      // A bound domain arrives as the remote value itself; a TCP tunnel arrives as a
      // remote port and needs the node's host to become an address.
      if (/[a-z]/iu.test(remote) && !remote.startsWith(':')) {
        return `https://${remote.replace(/^https?:\/\//u, '')}/`;
      }
      const nodeHost = await this.resolveNodeHost(tunnel.node, accessKey);
      if (!nodeHost) {
        return undefined;
      }
      const scheme = /auto_https\s*=\s*(auto|on|true)/iu.test(tunnel.extra ?? '') || tunnel.type === 'https'
        ? 'https'
        : 'http';
      return `${scheme}://${nodeHost}:${remote}/`;
    } catch (error) {
      this.logger.warn(`Could not read the assigned SakuraFrp endpoint: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async resolveNodeHost(node: number | string | undefined, accessKey: string): Promise<string | undefined> {
    if (node === undefined) {
      return undefined;
    }
    const nodes = await this.fetchJson<Record<string, { host?: string }>>('/nodes', accessKey);
    const record = nodes?.[String(node)];
    const host = record?.host?.trim();
    if (!host) {
      return undefined;
    }
    return host.replace(/^https?:\/\//u, '').replace(/\/+$/u, '');
  }

  private async fetchJson<T>(path: string, accessKey: string): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${accessKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`${path} answered ${response.status}`);
    }
    return await response.json() as T;
  }

  /** The endpoint to report: what the platform assigned, else what was declared. */
  private currentEndpoint(): string | undefined {
    return normalizePublicEndpoint(this.discoveredEndpoint) ?? this.publicUrl ?? this.status.endpoint;
  }

  /**
   * Setup: 解析 Token 获取配置
   */
  async setup(_options: TunnelSetupOptions): Promise<TunnelConfig> {
    // SakuraFRP Token 格式通常包含隧道信息
    // 这里返回基本配置，实际配置由 frpc 从 Token 获取
    const config: TunnelConfig = {
      subdomain: 'sakura',
      provider: 'sakura_frp',
      endpoint: this.publicUrl ?? '',
      tunnelToken: this.token,
    };

    this.currentConfig = config;
    return config;
  }

  /**
   * 启动 frpc 客户端
   */
  async start(config?: TunnelConfig): Promise<void> {
    const actualConfig = config ?? {
      subdomain: 'sakura',
      provider: 'sakura_frp',
      endpoint: this.publicUrl ?? '',
      tunnelToken: this.token,
    };

    // Ask the platform where this tunnel is reachable before claiming any endpoint.
    this.discoveredEndpoint = await this.discoverEndpoint();
    if (this.discoveredEndpoint) {
      this.logger.info(`SakuraFrp assigned ${this.discoveredEndpoint}`);
    }

    // A foreign frpc is not ours to adopt: another instance's tunnel would be reported as
    // this provider's readiness and its stop would kill a process we do not own.
    if (this.isFrpcRunning()) {
      this.logger.warn('Another frpc process is already running; refusing to take it over');
      this.status = createTunnelStatus('failed', {
        endpoint: this.currentEndpoint(),
        error: 'frpc-already-running',
      });
      this.currentConfig = actualConfig;
      this.managedByUs = false;
      return;
    }

    if (this.process) {
      this.logger.info('Already running (managed by us)');
      return;
    }

    const token = actualConfig.tunnelToken ?? this.token;
    if (!token) {
      throw new Error('SakuraFRP token is required');
    }

    this.logger.info('Starting SakuraFRP tunnel...');
    this.status = createTunnelStatus('process-started', { endpoint: this.currentEndpoint() });
    this.managedByUs = true;

    // SakuraFRP 使用 frpc 客户端
    // 命令格式: frpc -f <token>
    const args = ['-f', token];
    if (this.serverAddr) {
      args.push('-s', this.serverAddr);
    }

    this.process = spawn(this.frpcPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        this.logger.info(`[frpc] ${output}`);
        this.checkConnectionStatus(output);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        this.logger.warn(`[frpc] ${output}`);
        this.checkConnectionStatus(output);
      }
    });

    this.process.on('exit', (code) => {
      this.logger.info(`frpc exited with code ${code}`);
      this.status = createTunnelStatus('failed', {
        endpoint: this.currentEndpoint(),
        error: this.status.error ?? (code === 0 ? 'frpc-exited' : `frpc exited with code ${code}`),
      });
      this.process = null;
      this.managedByUs = false;
    });

    this.process.on('error', (error) => {
      const described = describeSpawnError('sakura-frp', this.frpcPath, error);
      this.logger.error(`Failed to start frpc: ${described}`);
      this.status = createTunnelStatus('failed', { endpoint: this.currentEndpoint(), error: described });
      this.process = null;
      this.managedByUs = false;
    });

    this.currentConfig = actualConfig;

    // 等待连接
    await this.waitForConnection(this.connectTimeoutMs);
  }

  private checkConnectionStatus(output: string): void {
    const lower = output.toLowerCase();

    // 代理已发布才算就绪
    if (lower.includes('start proxy success') || lower.includes('tunnel running')) {
      this.status = createTunnelStatus('proxy-ready', {
        endpoint: this.currentEndpoint(),
        lastHeartbeat: new Date(),
        error: this.status.error,
      });
      this.logger.info('SakuraFRP tunnel connected');
    } else if (lower.includes('login to server success') && this.status.stage !== 'proxy-ready') {
      // 控制连接成功说明凭据可用，但代理还没起来
      this.status = createTunnelStatus('control-connected', {
        endpoint: this.currentEndpoint(),
        error: this.status.error,
      });
    }

    // 检测错误：代理启动失败必须撤销"已连接"
    if (lower.includes('start proxy error') || lower.includes('start error')) {
      this.status = createTunnelStatus('failed', {
        endpoint: this.currentEndpoint(),
        error: output,
      });
      return;
    }
    if (lower.includes('error') || lower.includes('failed')) {
      this.status = { ...this.status, error: output };
    }
  }

  /**
   * 停止隧道
   */
  async stop(): Promise<void> {
    if (!this.managedByUs) {
      this.logger.info('Not managed by us, skipping stop');
      this.status = createTunnelStatus('stopped', { endpoint: this.status.endpoint, error: this.status.error });
      return;
    }

    if (this.process) {
      this.logger.info('Stopping SakuraFRP tunnel...');
      this.process.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.logger.info('Force killing frpc...');
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
      this.logger.info('SakuraFRP tunnel stopped');
    }

    this.status = createTunnelStatus('stopped', { endpoint: this.status.endpoint, error: this.status.error });
    this.managedByUs = false;
  }

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  getEndpoint(): string | undefined {
    return this.currentEndpoint();
  }

  async cleanup(_config: TunnelConfig): Promise<void> {
    await this.stop();
    this.currentConfig = null;
  }

  /**
   * 检测 frpc 是否已经在运行
   */
  private isFrpcRunning(): boolean {
    try {
      if (process.platform === 'win32') {
        execSync('tasklist /FI "IMAGENAME eq frpc.exe" | find "frpc"', {
          stdio: 'ignore',
        });
      } else {
        execSync('pgrep -x frpc', { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false;
    }
  }

  private async waitForConnection(timeout = 30000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (this.status.connected) {
        return;
      }

      if (!this.status.running && this.status.error) {
        throw new Error(`SakuraFRP failed to start: ${this.status.error}`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    // Timeout is a visible failure: frpc is running but no proxy was published.
    this.status = createTunnelStatus('failed', {
      endpoint: this.currentEndpoint(),
      error: this.status.error ?? 'frpc-connect-timeout',
    });
    this.logger.warn('frpc did not publish a proxy before the timeout');
    throw new Error('SakuraFRP connection timeout');
  }

  isManagedByUs(): boolean {
    return this.managedByUs;
  }
}

/** Splits the console's startup parameter into the access key and the tunnel ids. */
export function parseSakuraCredential(value: string | undefined): { accessKey?: string; tunnelIds: string[] } {
  const raw = value?.trim();
  if (!raw) {
    return { tunnelIds: [] };
  }
  const separator = raw.indexOf(':');
  if (separator < 0) {
    // Older setups stored the bare access key; the platform then decides the tunnel.
    return { accessKey: raw, tunnelIds: [] };
  }
  return {
    accessKey: raw.slice(0, separator).trim() || undefined,
    tunnelIds: raw.slice(separator + 1).split(',').map((id) => id.trim()).filter(Boolean),
  };
}

function normalizePublicEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString().replace(/\/+$/u, '') + '/';
  } catch {
    return value.trim();
  }
}
