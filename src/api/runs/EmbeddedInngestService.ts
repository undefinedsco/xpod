import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import { getFreePort, PACKAGE_ROOT } from '../../runtime';

export interface EmbeddedInngestServiceOptions {
  edition: 'cloud' | 'local';
  apiBaseUrl: string;
  apiPath?: string;
  databaseUrl: string;
  redisUrl?: string;
  enabled?: boolean;
  mode?: 'managed' | 'spawn';
  host?: string;
  port?: number;
  baseUrl?: string;
  eventKey?: string;
  signingKey?: string;
  binaryPath?: string;
  sqliteDir?: string;
}

export interface EmbeddedInngestRuntimeConfig {
  enabled: boolean;
  durableDelivery: boolean;
  baseUrl?: string;
  eventKey?: string;
  signingKey?: string;
  functionEndpoint?: string;
}

/**
 * Xpod-owned Inngest runtime process.
 *
 * The JS SDK is only the client/function adapter; the durable executor is the
 * Inngest CLI/server. In local mode Xpod may spawn that server as a managed
 * child process. In cloud/cluster mode the deployment supplies a stable
 * cluster-scoped Inngest URL, still owned by the Xpod deployment rather than
 * user-provided SaaS. Xpod Run/RunStep remain the business source of truth.
 */
export class EmbeddedInngestService {
  private readonly logger = getLoggerFor(this);
  private readonly options: EmbeddedInngestServiceOptions;
  private child?: ChildProcess;
  private config?: EmbeddedInngestRuntimeConfig;

  public constructor(options: EmbeddedInngestServiceOptions) {
    this.options = options;
  }

  public async start(): Promise<EmbeddedInngestRuntimeConfig> {
    if (this.config) {
      return this.config;
    }

    if (this.options.enabled === false || !this.isConfigured()) {
      this.config = {
        enabled: false,
        durableDelivery: false,
      };
      this.logger.info('Embedded Inngest disabled by config');
      return this.config;
    }

    const mode = this.options.mode ?? (this.options.edition === 'cloud' ? 'managed' : 'spawn');
    if ((this.options.edition === 'cloud' || mode === 'managed') && (!this.options.eventKey || !this.options.signingKey)) {
      throw new Error('Managed/cloud Inngest requires explicit eventKey and signingKey');
    }

    const eventKey = this.options.eventKey || 'xpod-local-event-key';
    const signingKey = this.options.signingKey || '78706f642d6c6f63616c2d7369676e696e672d6b6579';
    const host = this.options.host || '127.0.0.1';
    const port = this.options.port ?? (mode === 'spawn' ? await getFreePort(8288, host) : 8288);
    const baseUrl = this.options.baseUrl || (mode === 'spawn' ? `http://${host}:${port}` : 'http://xpod-inngest:8288');
    const functionEndpoint = new URL(this.options.apiPath ?? '/api/inngest', this.options.apiBaseUrl).toString();

    this.config = {
      enabled: true,
      durableDelivery: false,
      baseUrl,
      eventKey,
      signingKey,
      functionEndpoint,
    };

    if (mode === 'managed') {
      this.config.durableDelivery = this.config.enabled;
      this.logger.info(`Using managed embedded Inngest at ${baseUrl}, function endpoint ${functionEndpoint}`);
      return this.config;
    }

    const binary = this.resolveUsableBinaryPath();
    if (!binary) {
      this.logger.warn('Embedded Inngest binary not found; Xpod will still expose the function endpoint, but durable delivery is unavailable.');
      return this.config;
    }

    const env = this.buildEnvironment({
      baseUrl,
      eventKey,
      signingKey,
      functionEndpoint,
    });
    const args = this.buildArguments(host, port, functionEndpoint);

    this.child = spawn(binary, args, {
      cwd: PACKAGE_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (chunk) => {
      this.logger.info(`[Inngest] ${String(chunk).trim()}`);
    });
    this.child.stderr?.on('data', (chunk) => {
      this.logger.warn(`[Inngest] ${String(chunk).trim()}`);
    });
    this.child.once('exit', (code, signal) => {
      const message = `Embedded Inngest exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      if (code && code !== 0) {
        this.logger.error(message);
      } else {
        this.logger.info(message);
      }
      this.child = undefined;
    });
    this.child.once('error', (error) => {
      this.logger.error(`Failed to start embedded Inngest: ${error}`);
      this.child = undefined;
    });

    this.logger.info(`Embedded Inngest starting at ${baseUrl}, function endpoint ${functionEndpoint}`);
    this.config.durableDelivery = true;
    return this.config;
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      timer.unref?.();

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private resolveUsableBinaryPath(): string | undefined {
    const configured = this.options.binaryPath;
    if (configured) {
      return this.isUsableBinary(configured) ? configured : undefined;
    }

    const candidates = [
      path.join(PACKAGE_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'inngest.cmd' : 'inngest'),
      path.join(PACKAGE_ROOT, 'node_modules', 'inngest-cli', 'bin', process.platform === 'win32' ? 'inngest.exe' : 'inngest'),
      'inngest',
    ];

    return candidates.find((candidate) => this.isUsableBinary(candidate));
  }

  private isUsableBinary(candidate: string): boolean {
    const isPathLike = candidate.includes('/') || candidate.includes('\\');
    if (isPathLike && !fs.existsSync(candidate)) {
      return false;
    }

    const result = spawnSync(candidate, ['--help'], {
      cwd: PACKAGE_ROOT,
      env: process.env,
      stdio: 'ignore',
      timeout: 5_000,
    });
    return !result.error && result.status === 0;
  }

  private buildArguments(host: string, port: number, functionEndpoint: string): string[] {
    return [
      'dev',
      '--no-discovery',
      '--host',
      host,
      '--port',
      String(port),
      '-u',
      functionEndpoint,
    ];
  }

  private buildEnvironment(config: {
    baseUrl: string;
    eventKey: string;
    signingKey: string;
    functionEndpoint: string;
  }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INNGEST_DEV: config.baseUrl,
      INNGEST_BASE_URL: config.baseUrl,
      INNGEST_EVENT_API_BASE_URL: config.baseUrl,
      INNGEST_API_BASE_URL: config.baseUrl,
      INNGEST_EVENT_KEY: config.eventKey,
      INNGEST_SIGNING_KEY: config.signingKey,
    };

    if (this.options.edition === 'cloud') {
      if (this.isPostgresUrl(this.options.databaseUrl)) {
        env.INNGEST_POSTGRES_URI = this.options.databaseUrl;
      }
      if (this.options.redisUrl) {
        env.INNGEST_REDIS_URI = this.options.redisUrl;
      }
      return env;
    }

    const sqliteDir = this.options.sqliteDir ?? path.join(process.env.CSS_ROOT_FILE_PATH || './data', '.inngest');
    fs.mkdirSync(sqliteDir, { recursive: true });
    env.INNGEST_SQLITE_DIR = sqliteDir;
    return env;
  }

  private isConfigured(): boolean {
    return Boolean(
      this.options.mode
      || this.options.baseUrl
      || this.options.eventKey
      || this.options.signingKey
      || this.options.binaryPath
      || this.options.sqliteDir
    );
  }

  private isPostgresUrl(value: string): boolean {
    return value.startsWith('postgres://') || value.startsWith('postgresql://');
  }
}
