import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { getLoggerFor } from 'global-logger-factory';
import { PACKAGE_ROOT } from '../runtime/package-root';
import { resolveTunnelClient, type ResolvedTunnelClient } from './TunnelClientResolver';
import { TUNNEL_PROVIDERS, type TunnelProviderId } from './TunnelProviderCatalog';

/**
 * The settings page's "check" and "download" buttons for tunnel clients (audit N16).
 *
 * The plugin model says the artifacts ship no clients; the operator still deserves a button
 * instead of a shell command. "Check" reports where each provider's client would come from and
 * whether it runs; "download" fetches a client from its vendor into the plugin directory and
 * verifies it before anything is kept.
 *
 * Only clients with a stable, direct, platform-addressed download are installable this way
 * (cloudflared today). ngrok ships through a CDN whose URL scheme we do not pin, and the natfrp
 * frpc fork has no published direct asset: for those the answer is the install hint, not a guess.
 */

export type TunnelClientState = 'ready' | 'missing';

export interface TunnelClientInspection {
  provider: TunnelProviderId;
  label: string;
  binary: string;
  state: TunnelClientState;
  source: ResolvedTunnelClient['source'];
  /** Absolute path when one was resolved. */
  path?: string;
  /** `--version` output, when the client answered. */
  version?: string;
  installHint: string;
  redistributable: boolean;
  license: string;
  /** Whether the "download" action can install this client on this platform. */
  installable: boolean;
  /** Why not, when `installable` is false. */
  installableReason?: string;
}

export interface TunnelClientManagerOptions {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  /** Runs `<binary> --version`; injected in tests. */
  runVersion?: (binary: string) => Promise<string | undefined>;
  /** Extracts a `.tgz` asset; injected in tests. */
  extractTgz?: (archivePath: string, destination: string) => Promise<void>;
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'info' | 'warn'>;
}

export interface InstallTunnelClientResult {
  provider: TunnelProviderId;
  installedPath: string;
  version?: string;
  sourceUrl: string;
}

/** Download assets we are willing to fetch, per platform. */
function downloadPlan(provider: TunnelProviderId, platform: NodeJS.Platform, arch: string): {
  url: string;
  archive: 'binary' | 'tgz';
  binary: string;
} | undefined {
  if (provider !== 'cloudflare') {
    return undefined;
  }
  const architecture = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!architecture) {
    return undefined;
  }
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  if (platform === 'linux') {
    return { url: `${base}/cloudflared-linux-${architecture}`, archive: 'binary', binary: 'cloudflared' };
  }
  if (platform === 'darwin') {
    return { url: `${base}/cloudflared-darwin-${architecture}.tgz`, archive: 'tgz', binary: 'cloudflared' };
  }
  return undefined;
}

export class TunnelClientManager {
  private readonly logger: Pick<ReturnType<typeof getLoggerFor>, 'info' | 'warn'>;
  private readonly packageRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  public constructor(private readonly options: TunnelClientManagerOptions = {}) {
    this.logger = options.logger ?? getLoggerFor('TunnelClientManager');
    this.packageRoot = options.packageRoot ?? PACKAGE_ROOT;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  /** Where downloaded clients live; also the resolver's second source. */
  public pluginDirectory(): string {
    return path.join(this.packageRoot, 'vendor', 'tunnel-clients');
  }

  public async inspectAll(): Promise<TunnelClientInspection[]> {
    return await Promise.all(TUNNEL_PROVIDERS.map(async (descriptor) => this.inspect(descriptor.id)));
  }

  public async inspect(provider: TunnelProviderId): Promise<TunnelClientInspection> {
    const descriptor = TUNNEL_PROVIDERS.find((entry) => entry.id === provider);
    if (!descriptor) {
      throw new Error(`Unknown tunnel provider: ${provider}`);
    }
    const client = descriptor.client;
    const plan = downloadPlan(provider, this.platform, this.arch);

    let resolved: ResolvedTunnelClient | undefined;
    let resolutionError: string | undefined;
    try {
      resolved = resolveTunnelClient(provider, { packageRoot: this.packageRoot, env: this.options.env });
    } catch (error) {
      resolutionError = error instanceof Error ? error.message : String(error);
    }

    const resolvedPath = resolved?.resolvedPath;
    const version = resolvedPath
      ? await (this.options.runVersion ?? runBinaryVersion)(resolvedPath)
      : undefined;
    // A PATH-resolved name is only "ready" once it actually answers: the bare name tells us
    // nothing until something runs.
    const state: TunnelClientState = resolvedPath && version ? 'ready' : 'missing';
    const installable = Boolean(plan) && this.platform !== 'win32';

    return {
      provider,
      label: descriptor.label,
      binary: client.binary,
      state,
      source: resolved?.source ?? 'path',
      ...(resolvedPath ? { path: resolvedPath } : {}),
      ...(version ? { version } : {}),
      installHint: client.installHint,
      redistributable: client.redistributable,
      license: client.license,
      installable,
      ...(installable
        ? {}
        : {
          installableReason: resolutionError
            ?? (plan ? `platform ${this.platform}/${this.arch} has no pinned asset` : 'no pinned direct download; install it yourself'),
        }),
    };
  }

  /**
   * Downloads a client into the plugin directory and keeps it only if it runs.
   *
   * Verification is "does the freshly written binary answer `--version`"; a file that cannot run
   * is deleted again, so a broken or bogus download never looks installed.
   */
  public async install(provider: TunnelProviderId, options: { signal?: AbortSignal } = {}): Promise<InstallTunnelClientResult> {
    const descriptor = TUNNEL_PROVIDERS.find((entry) => entry.id === provider);
    const plan = descriptor ? downloadPlan(provider, this.platform, this.arch) : undefined;
    if (!descriptor || !plan) {
      throw new Error(`No pinned download is available for ${provider} on ${this.platform}/${this.arch}; ${descriptor?.client.installHint ?? 'install it manually'}`);
    }

    const directory = this.pluginDirectory();
    await fs.mkdir(directory, { recursive: true });
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(plan.url, {
      ...(options.signal ? { signal: options.signal } : {}),
      redirect: 'follow',
    });
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status} from ${plan.url}`);
    }

    const target = path.join(directory, plan.binary);
    if (plan.archive === 'binary') {
      await writeBody(response, target);
    } else {
      const archivePath = `${target}.tgz`;
      await writeBody(response, archivePath);
      try {
        await (this.options.extractTgz ?? extractTgzWithTar)(archivePath, directory);
      } finally {
        await fs.rm(archivePath, { force: true });
      }
    }
    await fs.chmod(target, 0o755);

    const version = await (this.options.runVersion ?? runBinaryVersion)(target);
    if (!version) {
      await fs.rm(target, { force: true });
      throw new Error(`the downloaded ${plan.binary} did not run, so it was removed: ${plan.url}`);
    }
    this.logger.info(`installed ${plan.binary} ${version} into ${directory}`);
    return { provider, installedPath: target, version, sourceUrl: plan.url };
  }
}

async function writeBody(response: Response, target: string): Promise<void> {
  if (!response.body) {
    throw new Error('download returned no body');
  }
  // Stream to disk: a tunnel client is tens of megabytes and must not be buffered in memory.
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(target, { mode: 0o755 }));
}

async function runBinaryVersion(binary: string): Promise<string | undefined> {
  if (!existsSync(binary)) {
    return undefined;
  }
  return await new Promise<string | undefined>((resolve) => {
    const child = spawn(binary, [ '--version' ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const first = output.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
      resolve(code === 0 && first ? first : undefined);
    });
  });
}

async function extractTgzWithTar(archivePath: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', [ '-xzf', archivePath, '-C', destination ], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`))));
  });
}
