/**
 * Resolving a server name to somewhere requests can be sent.
 *
 * A Matrix server name is `host[:port]`, and the server may delegate its traffic to
 * another host with `/.well-known/matrix/server` or — deprecated, and only when
 * `.well-known` fails — an SRV record. The specification's resolution order matters
 * and is implemented here in that order, because getting it wrong means talking to a
 * host that cannot prove it speaks for the server name:
 *
 * 1. an IP literal is used directly (port 8448 when none is given);
 * 2. a server name with an explicit port is used directly;
 * 3. otherwise `https://<hostname>/.well-known/matrix/server` is fetched, and a valid
 *    `m.server` is processed as `host[:port]` — with delegation *not* recursing (the
 *    specification's steps 3.1–3.5 have no second `.well-known` lookup);
 * 4. when `.well-known` is missing or unusable, SRV `_matrix-fed._tcp.<hostname>`, then
 *    the deprecated `_matrix._tcp.<hostname>`;
 * 5. failing all of that, `https://<hostname>:8448`.
 *
 * Every branch keeps the *server name* as the `Host` value wherever the specification
 * requires it, which is why the result carries `baseUrl` and `hostHeader` separately:
 * when a delegation points at another host, requests still have to claim the original
 * name — that is how the target proves it is a valid delegate over TLS.
 *
 * Discovery results are cached like the specification asks: honour `Cache-Control:
 * max-age`, default to 24 hours when absent, never exceed 48 hours, cache errors for
 * an hour and back off exponentially while failures repeat. SRV answers are left to the
 * DNS resolver's own cache.
 */
import { isMatrixServerName, splitServerName } from '../protocol/serverName';

export const DEFAULT_WELL_KNOWN_CACHE_MS = 24 * 60 * 60 * 1000;
export const MAX_WELL_KNOWN_CACHE_MS = 48 * 60 * 60 * 1000;
export const ERROR_WELL_KNOWN_CACHE_MS = 60 * 60 * 1000;
/** The IANA-registered federation port, used whenever no port is given. */
export const DEFAULT_FEDERATION_PORT = 8448;

export interface MatrixSrvRecord {
  target: string;
  port: number;
  priority?: number;
  weight?: number;
}

/** Where a resolved server name should be reached, and under which `Host`. */
export interface MatrixResolvedServer {
  /** Base URL of the target, including its port. */
  baseUrl: string;
  /** `Host` header the specification requires for this branch. */
  hostHeader: string;
  /** How the target was found; kept for diagnostics and tests. */
  via:
    | 'ip-literal'
    | 'explicit-port'
    | 'well-known'
    | 'srv-fed'
    | 'srv-legacy'
    | 'implicit-port'
    /**
     * The name's own HTTPS address, with no federation port and no delegation.
     *
     * A native endpoint between two Xpod deployments is not a federation endpoint: the
     * deployment serves the server name itself, on the ordinary port, so nothing has to be
     * discovered. `.well-known` delegation is a Matrix transport concern and stays there.
     */
;
  /** The `m.server` value when a `.well-known` delegation was used. */
  delegatedTo?: string;
}

export interface MatrixServerNameResolverOptions {
  /** Fetches `/.well-known/matrix/server`; redirects are followed by the caller's fetch. */
  fetch: typeof fetch;
  /**
   * SRV lookup, consulted only when `.well-known` is unavailable. Omitted means SRV is
   * not used at all — a deployment wires `node:dns` here, and tests stay hermetic.
   */
  resolveSrv?: (name: string) => Promise<readonly MatrixSrvRecord[] | undefined>;
  now?: () => number;
  defaultCacheMs?: number;
  maxCacheMs?: number;
  errorCacheMs?: number;
  /** Injectable for the RFC 2782 weighted choice among equal-priority records. */
  random?: () => number;
}

interface WellKnownEntry {
  /** The delegated name, or `undefined` when discovery failed. */
  delegatedTo?: string;
  expiresAt: number;
  failures: number;
}

export class MatrixServerNameResolver {
  private readonly fetch: typeof fetch;
  private readonly resolveSrv?: (name: string) => Promise<readonly MatrixSrvRecord[] | undefined>;
  private readonly now: () => number;
  private readonly defaultCacheMs: number;
  private readonly maxCacheMs: number;
  private readonly errorCacheMs: number;
  private readonly random: () => number;
  private readonly wellKnown = new Map<string, WellKnownEntry>();
  private readonly inFlight = new Map<string, Promise<WellKnownEntry>>();

  public constructor(options: MatrixServerNameResolverOptions) {
    this.fetch = options.fetch;
    this.resolveSrv = options.resolveSrv;
    this.now = options.now ?? Date.now;
    this.defaultCacheMs = options.defaultCacheMs ?? DEFAULT_WELL_KNOWN_CACHE_MS;
    this.maxCacheMs = options.maxCacheMs ?? MAX_WELL_KNOWN_CACHE_MS;
    this.errorCacheMs = options.errorCacheMs ?? ERROR_WELL_KNOWN_CACHE_MS;
    this.random = options.random ?? Math.random;
  }

  /** Resolve `serverName`, or `undefined` when it is not a usable server name. */
  public async resolve(serverName: string): Promise<MatrixResolvedServer | undefined> {
    if (!isMatrixServerName(serverName)) return undefined;
    const { host, port } = splitServerName(serverName);
    if (isIpLiteral(host)) {
      return { baseUrl: `https://${wrapIpLiteral(host)}:${port ?? DEFAULT_FEDERATION_PORT}`, hostHeader: serverName, via: 'ip-literal' };
    }
    if (port !== undefined) {
      return { baseUrl: `https://${host}:${port}`, hostHeader: serverName, via: 'explicit-port' };
    }

    const discovery = await this.wellKnownFor(host);
    if (discovery?.delegatedTo) {
      const delegated = await this.delegatedTarget(discovery.delegatedTo);
      return { ...delegated, delegatedTo: discovery.delegatedTo };
    }

    const srv = await this.srvTarget([ `_matrix-fed._tcp.${host}`, `_matrix._tcp.${host}` ]);
    if (srv) return { baseUrl: `https://${srv.host}:${srv.port}`, hostHeader: host, via: srv.via };
    return { baseUrl: `https://${host}:${DEFAULT_FEDERATION_PORT}`, hostHeader: host, via: 'implicit-port' };
  }

  /** Forget cached discovery for a hostname, so the next resolve refetches it. */
  public forget(hostname: string): void {
    this.wellKnown.delete(hostname);
  }

  /**
   * Steps 3.1–3.5: process a delegated `m.server` value. A delegated host with an
   * explicit port or an IP literal needs no DNS; otherwise SRV is tried before the
   * implicit 8448.
   */
  private async delegatedTarget(delegatedTo: string): Promise<Omit<MatrixResolvedServer, 'delegatedTo'>> {
    const { host, port } = splitServerName(delegatedTo);
    if (isIpLiteral(host)) {
      return { baseUrl: `https://${wrapIpLiteral(host)}:${port ?? DEFAULT_FEDERATION_PORT}`, hostHeader: delegatedTo, via: 'well-known' };
    }
    if (port !== undefined) {
      return { baseUrl: `https://${host}:${port}`, hostHeader: delegatedTo, via: 'well-known' };
    }
    const srv = await this.srvTarget([ `_matrix-fed._tcp.${host}`, `_matrix._tcp.${host}` ]);
    // The `Host` stays the delegated hostname even when SRV points at another target:
    // that is what the target's certificate has to cover.
    if (srv) return { baseUrl: `https://${srv.host}:${srv.port}`, hostHeader: host, via: srv.via };
    return { baseUrl: `https://${host}:${DEFAULT_FEDERATION_PORT}`, hostHeader: host, via: 'well-known' };
  }

  /** Try each SRV name in order, returning the first that yields a usable record. */
  private async srvTarget(
    names: readonly string[],
  ): Promise<{ host: string; port: number; via: 'srv-fed' | 'srv-legacy' } | undefined> {
    if (!this.resolveSrv) return undefined;
    for (const [ index, name ] of names.entries()) {
      let records: readonly MatrixSrvRecord[] | undefined;
      try {
        records = await this.resolveSrv(name);
      } catch {
        // No SRV answer (NXDOMAIN, timeout) is the ordinary "not delegated" path.
        continue;
      }
      const selected = selectSrvRecord(records ?? [], this.random);
      if (selected && isMatrixServerName(selected.target)) {
        return { host: stripTrailingDot(selected.target), port: selected.port, via: index === 0 ? 'srv-fed' : 'srv-legacy' };
      }
    }
    return undefined;
  }

  /**
   * Step 3: the `.well-known` lookup, cached. `undefined` means discovery failed, which
   * sends the caller down the SRV and implicit-port branches.
   */
  private async wellKnownFor(hostname: string): Promise<WellKnownEntry | undefined> {
    const cached = this.wellKnown.get(hostname);
    if (cached && cached.expiresAt > this.now()) return cached.delegatedTo ? cached : undefined;
    const pending = this.inFlight.get(hostname);
    if (pending) return pending.then(entry => (entry.delegatedTo ? entry : undefined));
    const request = this.fetchWellKnown(hostname)
      .then(entry => {
        this.wellKnown.set(hostname, entry);
        return entry;
      })
      .finally(() => this.inFlight.delete(hostname));
    this.inFlight.set(hostname, request);
    const entry = await request;
    return entry.delegatedTo ? entry : undefined;
  }

  private async fetchWellKnown(hostname: string): Promise<WellKnownEntry> {
    const previous = this.wellKnown.get(hostname);
    const failures = (previous?.failures ?? 0) + 1;
    let response: Response | undefined;
    try {
      response = await this.fetch(`https://${hostname}/.well-known/matrix/server`, {
        headers: { accept: 'application/json' },
        redirect: 'follow',
      });
    } catch {
      return this.failedDiscovery(failures);
    }
    if (!response.ok) return this.failedDiscovery(failures);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return this.failedDiscovery(failures);
    }
    const delegatedTo = readMServer(body);
    if (!delegatedTo) return this.failedDiscovery(failures);

    const maxAge = readMaxAge(response.headers.get('cache-control'));
    const cacheMs = maxAge === 'no-store'
      ? 0
      : Math.min(maxAge ?? this.defaultCacheMs, this.maxCacheMs);
    return { delegatedTo, expiresAt: this.now() + cacheMs, failures: 0 };
  }

  private failedDiscovery(failures: number): WellKnownEntry {
    // Repeated failures back off exponentially, still bounded by the maximum cache time.
    const backoffMs = Math.min(this.errorCacheMs * 2 ** (failures - 1), this.maxCacheMs);
    return { expiresAt: this.now() + backoffMs, failures };
  }
}

/** `m.server` from a discovery document, or `undefined` when it is unusable. */
export function readMServer(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)['m.server'];
  if (typeof value !== 'string') return undefined;
  return isMatrixServerName(value) ? value : undefined;
}

/**
 * RFC 2782 selection: lowest priority wins, and among equal priorities a record is
 * chosen in proportion to its weight (all-zero weights fall back to a uniform choice).
 */
export function selectSrvRecord(records: readonly MatrixSrvRecord[], random: () => number): MatrixSrvRecord | undefined {
  const usable = records.filter(record => record.port > 0 && record.port <= 65535);
  if (usable.length === 0) return undefined;
  const bestPriority = Math.min(...usable.map(record => record.priority ?? 0));
  const candidates = usable.filter(record => (record.priority ?? 0) === bestPriority);
  const totalWeight = candidates.reduce((sum, record) => sum + Math.max(record.weight ?? 0, 0), 0);
  if (totalWeight <= 0) return candidates[Math.min(Math.floor(random() * candidates.length), candidates.length - 1)];
  let target = random() * totalWeight;
  for (const record of candidates) {
    target -= Math.max(record.weight ?? 0, 0);
    if (target < 0) return record;
  }
  return candidates[candidates.length - 1];
}

function readMaxAge(cacheControl: string | null): number | 'no-store' | undefined {
  if (!cacheControl) return undefined;
  const directives = cacheControl.split(',').map(part => part.trim().toLowerCase());
  if (directives.includes('no-store')) return 'no-store';
  for (const directive of directives) {
    const match = /^max-age\s*=\s*(\d+)$/u.exec(directive);
    if (match) return Number(match[1]) * 1000;
  }
  return undefined;
}

function isIpLiteral(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) || host.includes(':');
}

function wrapIpLiteral(host: string): string {
  return host.includes(':') ? `[${stripBrackets(host)}]` : host;
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}