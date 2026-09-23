import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  TUNNEL_PROVIDERS,
  type TunnelProviderClient,
  type TunnelProviderId,
} from './TunnelProviderCatalog';

/**
 * One resolution order for every tunnel client (audit N16).
 *
 * The providers used to spawn a bare default name each, so "which binary did it actually run"
 * was spread over three constructors, an explicit path that did not exist failed as a plain
 * ENOENT, and a release artifact that shipped a client had nowhere to say so.
 *
 * Order, highest first:
 *   1. an explicit path (provider option or the catalog's env key) — if the operator named a
 *      path, a missing file is an error, not a reason to quietly use something else;
 *   2. a binary bundled next to the package (`vendor/tunnel-clients/<binary>`);
 *   3. the bare name, which the OS resolves through PATH.
 */

export interface ResolveTunnelClientOptions {
  /** Provider option that already carries a path (e.g. `ngrokPath`). */
  explicitPath?: string;
  /** Package root that may contain `vendor/tunnel-clients/`. */
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: decides whether a resolved path is usable. */
  isExecutable?: (candidate: string) => boolean;
}

export interface ResolvedTunnelClient {
  /** What to spawn. */
  command: string;
  source: 'explicit' | 'bundled' | 'path';
  /** Absolute path when one was resolved. */
  resolvedPath?: string;
  /** Catalog facts for diagnostics. */
  client: TunnelProviderClient;
}

/** An explicit path that does not exist is a configuration error, not a fallback. */
export class TunnelClientPathError extends Error {
  public constructor(
    public readonly provider: TunnelProviderId,
    public readonly configuredPath: string,
    public readonly installHint: string,
  ) {
    super(
      `tunnel client for ${provider} is configured as "${configuredPath}", but nothing executable is there; `
      + installHint,
    );
    this.name = 'TunnelClientPathError';
  }
}

export function describeTunnelClientMissing(provider: TunnelProviderId, binary?: string): string {
  const descriptor = TUNNEL_PROVIDERS.find((entry) => entry.id === provider);
  const client = descriptor?.client;
  const name = binary ?? client?.binary ?? 'unknown';
  return `binary-missing:${provider}:${name}` + (client ? ` (${client.installHint})` : '');
}

export function resolveTunnelClient(
  provider: TunnelProviderId,
  options: ResolveTunnelClientOptions = {},
): ResolvedTunnelClient {
  const descriptor = TUNNEL_PROVIDERS.find((entry) => entry.id === provider);
  if (!descriptor) {
    throw new Error(`Unknown tunnel provider: ${provider}`);
  }
  const client = descriptor.client;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  const configuredPath = normalizePath(options.explicitPath) ?? normalizePath(env[client.envKey]);
  if (configuredPath) {
    if (!isExecutable(configuredPath)) {
      throw new TunnelClientPathError(provider, configuredPath, client.installHint);
    }
    return { command: configuredPath, source: 'explicit', resolvedPath: configuredPath, client };
  }

  const bundled = options.packageRoot
    ? path.join(options.packageRoot, 'vendor', 'tunnel-clients', client.binary)
    : undefined;
  if (bundled && isExecutable(bundled)) {
    return { command: bundled, source: 'bundled', resolvedPath: bundled, client };
  }

  // Look the name up on PATH ourselves instead of leaving it to the spawn: the settings page
  // has to be able to say "ready, at <path>, version X", and two places deciding "is it on
  // PATH" is how the check button and the preflight script ended up disagreeing.
  const onPath = findOnPath(client.binary, env, isExecutable);
  if (onPath) {
    return { command: onPath, source: 'path', resolvedPath: onPath, client };
  }

  // Not found: hand the bare name to the OS anyway, so a PATH entry this process cannot read
  // still gets its chance; a real miss surfaces as ENOENT and becomes
  // `binary-missing:<provider>:<binary>` with the install hint attached.
  return { command: client.binary, source: 'path', client };
}

/** Resolves every provider's client, for preflight/reporting. */
export function resolveAllTunnelClients(options: ResolveTunnelClientOptions = {}): Array<{
  provider: TunnelProviderId;
  resolved?: ResolvedTunnelClient;
  error?: Error;
}> {
  return TUNNEL_PROVIDERS.map((descriptor) => {
    try {
      return { provider: descriptor.id, resolved: resolveTunnelClient(descriptor.id, options) };
    } catch (error) {
      return { provider: descriptor.id, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
}

/** Providers whose client may be shipped in a release artifact, with the licence to keep. */
export function redistributableTunnelClients(): Array<{ provider: TunnelProviderId; client: TunnelProviderClient }> {
  return TUNNEL_PROVIDERS
    .filter((descriptor) => descriptor.client.redistributable)
    .map((descriptor) => ({ provider: descriptor.id, client: descriptor.client }));
}

/** One sentence stating which clients an artifact may ship, derived from the catalog. */
export function redistributePolicyNote(): string {
  const allowed = redistributableTunnelClients().map((entry) => entry.client.binary);
  const blocked = TUNNEL_PROVIDERS
    .filter((descriptor) => !descriptor.client.redistributable)
    .map((descriptor) => `${descriptor.id} (${descriptor.client.license})`);
  return `bundled clients allowed: ${allowed.join(', ') || 'none'}; not ours to ship: ${blocked.join(', ') || 'none'}`;
}

/** Finds an executable by name on the given environment's PATH (no shell involved). */
export function findOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (candidate: string) => boolean = defaultIsExecutable,
): string | undefined {
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, binary);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultIsExecutable(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) {
      const matches = safeReaddir(path.dirname(candidate))
        .filter((entry) => entry === path.basename(candidate));
      return matches.length > 0;
    }
    const stats = statSync(candidate);
    return stats.isFile() || stats.isFIFO();
  } catch {
    return false;
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
