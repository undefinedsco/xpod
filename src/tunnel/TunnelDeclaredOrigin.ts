import { spawn, type ChildProcess } from 'node:child_process';
import { readDashboardOrigin } from './LocalTunnelProvider';
import { resolveSakuraAssignedLocalPort } from './SakuraFrpTunnelProvider';
import { resolveTunnelClient } from './TunnelClientResolver';
import { parseTunnelProvider, tunnelProviderDescriptor } from './TunnelProviderCatalog';

/**
 * The origin port a provider *console* already declares, read back before this runtime binds
 * its tunnel entry.
 *
 * A console-owned tunnel (Cloudflare dashboard, SakuraFrp console) forwards to a number that
 * lives in that console. Asking the operator to edit the console so it matches the runtime is
 * the behaviour the operator rejected: the runtime adopts what the console already says. Both
 * readers below are the same ones the providers use for their own diagnostics, so there is
 * only ever one parser per provider.
 */

export interface DeclaredIngressOrigin {
  port: number;
  /** Scheme the console declares for its origin service, when it declares one. */
  scheme?: string;
  /** Where the value came from, for logs and evidence. */
  readBack: string;
}

export interface DeclaredOriginReadResult {
  origin?: DeclaredIngressOrigin;
  /** Why no origin could be read; never silently treated as "no console declaration". */
  error?: string;
}

export interface DeclaredOriginProfile {
  id: string;
  provider: string;
  credentialEnvKey?: string;
  credentialConfigured?: boolean;
}

export interface ReadDeclaredOriginOptions {
  env?: Record<string, string | undefined>;
  /**
   * Whether this profile is the active one. A Cloudflare read-back starts a short-lived
   * connector, so it only runs for the profile whose port the runtime is about to adopt.
   */
  active?: boolean;
  /** Explicit cloudflared path; falls back to the catalog env key and PATH. */
  cloudflaredPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sakuraApiBaseUrl?: string;
  /** Injected in tests. */
  readCloudflare?: typeof readCloudflareRemoteOrigin;
  readSakura?: typeof resolveSakuraAssignedLocalPort;
}

const DEFAULT_CLOUDFLARE_READ_TIMEOUT_MS = 20_000;

/**
 * Reads the origin the active profile's console declares, using that provider's own reader.
 *
 * A provider that owns the origin at runtime (`originOwner: 'runtime'`) has nothing to read:
 * the port is ours to choose, and pretending otherwise would invent a console value.
 */
export async function readDeclaredIngressOrigin(
  profile: DeclaredOriginProfile,
  options: ReadDeclaredOriginOptions = {},
): Promise<DeclaredOriginReadResult> {
  const provider = parseTunnelProvider(profile.provider);
  const descriptor = tunnelProviderDescriptor(provider);
  if (!provider || !descriptor) {
    return { error: `profile ${profile.id} declares unknown provider ${profile.provider}` };
  }
  if (descriptor.originOwner !== 'console') {
    return { error: `provider ${descriptor.id} chooses its own origin port, so it declares none` };
  }

  const env = options.env ?? process.env;
  const token = (profile.credentialEnvKey ? env[profile.credentialEnvKey] : undefined)
    ?? env[descriptor.legacyCredentialEnvKey];
  if (!token?.trim()) {
    return { error: `${descriptor.id} profile ${profile.id} has no credential configured` };
  }

  if (descriptor.id === 'sakura_frp') {
    const readSakura = options.readSakura ?? resolveSakuraAssignedLocalPort;
    const port = await readSakura(token, {
      ...(options.sakuraApiBaseUrl ? { apiBaseUrl: options.sakuraApiBaseUrl } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (port === undefined) {
      return { error: 'the SakuraFrp console reported no local_port for this credential (GET /v4/tunnels)' };
    }
    return { origin: { port, readBack: 'sakura_frp:GET /v4/tunnels local_port' } };
  }

  if (descriptor.id === 'cloudflare') {
    if (options.active === false) {
      return {
        error: 'the Cloudflare dashboard origin is only read back for the active profile '
          + '(reading it starts a connector, and an inactive profile must not start one)',
      };
    }
    const readCloudflare = options.readCloudflare ?? readCloudflareRemoteOrigin;
    const resolved = await readCloudflare(token, {
      command: resolveCloudflaredCommand(options),
      timeoutMs: options.timeoutMs ?? DEFAULT_CLOUDFLARE_READ_TIMEOUT_MS,
      env,
    });
    if (!resolved.origin) {
      return { error: resolved.error };
    }
    return { origin: resolved.origin };
  }

  return { error: `provider ${descriptor.id} has no console origin reader` };
}

function resolveCloudflaredCommand(options: ReadDeclaredOriginOptions): string {
  try {
    return resolveTunnelClient('cloudflare', {
      ...(options.cloudflaredPath ? { explicitPath: options.cloudflaredPath } : {}),
      ...(options.env ? { env: options.env } : {}),
    }).command;
  } catch {
    // A configured-but-missing path must surface through the spawn error path, which reuses
    // the same `binary-missing:<provider>:<binary>` message the providers report.
    return options.cloudflaredPath ?? 'cloudflared';
  }
}

export interface CloudflareOriginReadOptions {
  command: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Injected in tests: yields the lines a real cloudflared would print. */
  spawnImpl?: typeof spawn;
}

export interface CloudflareOriginRead {
  origin?: DeclaredIngressOrigin;
  /** Lines that mentioned an ingress service, for the log line when the read fails. */
  log: string[];
  error?: string;
}

/**
 * Reads the remote configuration of a named tunnel from the connector that fetches it.
 *
 * A named tunnel's ingress is stored at Cloudflare, and the connector token is not a
 * Cloudflare API credential, so the only local read-back is what cloudflared itself echoes
 * when it fetches that configuration. The parser is `readDashboardOrigin` — the same one
 * `LocalTunnelProvider` uses for its `origin-mismatch` diagnostic — so the two cannot drift.
 *
 * The probe connector is short-lived and is always terminated; the runtime's real connector
 * starts later, and a tunnel tolerates several connectors while it is up.
 */
export async function readCloudflareRemoteOrigin(
  token: string,
  options: CloudflareOriginReadOptions,
): Promise<CloudflareOriginRead> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOUDFLARE_READ_TIMEOUT_MS;
  const log: string[] = [];

  return await new Promise<CloudflareOriginRead>((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (result: Omit<CloudflareOriginRead, 'log'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      terminate(child);
      resolve({ ...result, log });
    };

    const timer = setTimeout(() => {
      finish({
        error: `cloudflared did not report the tunnel's remote configuration within ${timeoutMs}ms `
          + '(a locally-managed tunnel keeps its ingress in a config file, which is not read back)',
      });
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawnImpl(options.command, [
        'tunnel',
        '--no-autoupdate',
        '--protocol', 'http2',
        'run',
        '--token',
        token,
      ], {
        stdio: [ 'ignore', 'pipe', 'pipe' ],
        env: options.env,
      });
    } catch (error) {
      finish({ error: `cloudflared could not be started: ${(error as Error).message}` });
      return;
    }

    const consume = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.includes('service')) {
          continue;
        }
        log.push(line.trim().slice(0, 400));
        const declared = readDashboardOrigin(line);
        if (declared) {
          finish({
            origin: {
              port: declared.port,
              scheme: declared.scheme,
              readBack: 'cloudflare:connector remote-config',
            },
          });
          return;
        }
      }
    };

    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', (error) => {
      finish({ error: describeCloudflaredFailure(options.command, error) });
    });
    child.once('exit', (code) => {
      finish({
        error: `cloudflared exited with code ${code} before reporting the tunnel's remote configuration`,
      });
    });
  });
}

function describeCloudflaredFailure(command: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return `binary-missing:cloudflare:${command} (cloudflared is not installed or not on PATH)`;
  }
  return `cloudflared could not be started: ${error.message}`;
}

function terminate(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null) {
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, 2_000);
  killTimer.unref?.();
}
