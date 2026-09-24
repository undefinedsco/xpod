import { getLoggerFor } from 'global-logger-factory';
import { findGatewayIngressPort, isFreePortForWildcard } from './port-finder';
import { identifyIngressPortOccupants } from './ingress-occupant';
import { readDeclaredIngressOrigin, type DeclaredOriginReadResult } from '../tunnel/TunnelDeclaredOrigin';
import { tunnelProviderDescriptor } from '../tunnel/TunnelProviderCatalog';

/**
 * Where the tunnel entry (the listener every remote forwarder terminates on) is bound.
 *
 * Order, strictest first:
 *   1. an explicit `XPOD_GATEWAY_INGRESS_PORT` — an operator or harness pin is never overridden
 *      and never silently moved to another port;
 *   2. the port the *active* profile's provider console already declares (SakuraFrp
 *      `GET /v4/tunnels` `local_port`; the Cloudflare dashboard's remote configuration read
 *      back through the connector) — adopted when it is free, so the operator does not have to
 *      edit the console to match the runtime;
 *   3. `findGatewayIngressPort(gatewayPort)` — the predictable, dynamic gateway+3..+9 entry.
 *
 * Both strict sources are strict about *being taken*: a port somebody else holds fails the
 * start with the occupant named (pid, command line, cwd). Nothing here signals a process, and
 * nothing silently falls back — a tunnel that forwards to a number must never find a different
 * process listening on it.
 */

export type IngressPortSource = 'explicit' | 'console-declared' | 'gateway-default';

export interface IngressProfileLike {
  id: string;
  provider: string;
  credentialEnvKey?: string;
  credentialConfigured?: boolean;
}

/** A port a provider console declares for this runtime's origin. */
export interface IngressPortDeclaration {
  profileId: string;
  provider: string;
  port: number;
  readBack: string;
  scheme?: string;
}

export interface IngressPortResolution {
  port: number;
  source: IngressPortSource;
  /** The active profile's declaration that was adopted, when there was one. */
  declared?: IngressPortDeclaration;
  /**
   * Declarations from profiles that are *not* active.
   *
   * They are reported because two profiles naming different ports is exactly the confusion
   * this resolution exists to end; only the active one may decide the listener.
   */
  inactiveDeclarations: IngressPortDeclaration[];
}

export interface IngressPortLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface IngressPortDeps {
  findDefaultPort(mainPort: number): Promise<number>;
  isFree(port: number): Promise<boolean>;
  identifyOccupants(port: number): string;
  readDeclaredOrigin(
    profile: IngressProfileLike,
    options: { env: Record<string, string | undefined>; active: boolean },
  ): Promise<DeclaredOriginReadResult>;
  logger: IngressPortLogger;
}

export interface IngressPortRequest {
  mainPort: number;
  env?: Record<string, string | undefined>;
  profiles?: readonly IngressProfileLike[];
  activeProfileId?: string;
  /** Service ports this run serves (gateway/CSS/API): never a valid tunnel origin. */
  reservedPorts?: Iterable<number>;
  deps?: Partial<IngressPortDeps>;
}

/** A strict port that could not be taken: the occupant is named, and nothing was signalled. */
export class IngressPortConflictError extends Error {
  public constructor(
    public readonly port: number,
    public readonly occupant: string,
  ) {
    super(`tunnel entry port ${port} is already in use by ${occupant}`);
    this.name = 'IngressPortConflictError';
  }
}

export function defaultIngressPortDeps(): IngressPortDeps {
  const logger = getLoggerFor('IngressPort');
  return {
    findDefaultPort: findGatewayIngressPort,
    isFree: isFreePortForWildcard,
    identifyOccupants: (port) => identifyIngressPortOccupants(port).description,
    readDeclaredOrigin: async(profile, options) => await readDeclaredIngressOrigin(profile, {
      env: options.env,
      active: options.active,
    }),
    logger: {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
    },
  };
}

/**
 * Validates a port that came from outside this runtime (an operator pin or a console).
 *
 * Zero, out-of-range and privileged ports are refused with the reason spelled out: binding
 * them either fails later with a bare errno, or needs privileges the runtime should not hold.
 */
export function assertUsableIngressPort(
  port: number,
  options: { label: string; reservedPorts?: ReadonlySet<number> },
): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `${options.label} is not a usable port (expected 1-65535); `
      + 'a tunnel origin has to be a real port number',
    );
  }
  if (port < 1024) {
    throw new Error(
      `${options.label} is a privileged port (1-1023); this runtime does not take root `
      + 'to bind a tunnel origin, so point the tunnel at a port at or above 1024',
    );
  }
  if (options.reservedPorts?.has(port)) {
    throw new Error(
      `${options.label} is a port this runtime already serves (gateway/CSS/API); `
      + 'the tunnel entry has to be its own listener, or forwarded traffic would land on another service',
    );
  }
}

/** Reads the explicit pin strictly: present but malformed is an error, not an absent value. */
export function parseExplicitIngressPort(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`XPOD_GATEWAY_INGRESS_PORT="${trimmed}" is not a valid port number (expected 1-65535)`);
  }
  return Number.parseInt(trimmed, 10);
}

export async function resolveIngressPort(request: IngressPortRequest): Promise<IngressPortResolution> {
  const deps: IngressPortDeps = { ...defaultIngressPortDeps(), ...request.deps };
  const env = request.env ?? process.env;
  const reservedPorts = new Set<number>(request.reservedPorts ?? []);
  const profiles = request.profiles ?? [];
  const activeProfileId = request.activeProfileId?.trim();
  const active = activeProfileId && activeProfileId !== 'none'
    ? profiles.find((profile) => profile.id === activeProfileId)
    : undefined;

  const explicit = parseExplicitIngressPort(env.XPOD_GATEWAY_INGRESS_PORT);
  if (explicit !== undefined) {
    assertUsableIngressPort(explicit, {
      label: `XPOD_GATEWAY_INGRESS_PORT=${explicit}`,
      reservedPorts,
    });
    await requireFree(explicit, `XPOD_GATEWAY_INGRESS_PORT=${explicit}`, deps);
    deps.logger.info(
      `Tunnel entry pinned to ${explicit} by XPOD_GATEWAY_INGRESS_PORT `
      + '(a provider console value is not read while an explicit pin is present)',
    );
    return { port: explicit, source: 'explicit', inactiveDeclarations: [] };
  }

  const inactiveDeclarations = await readInactiveConsoleDeclarations({ profiles, active, env, deps });
  for (const declaration of inactiveDeclarations) {
    deps.logger.warn(
      `profile ${declaration.profileId} (${declaration.provider}) is not active, but its console declares `
      + `tunnel origin ${declaration.port} (${declaration.readBack}); `
      + `the active profile is ${active?.id ?? 'none'}, so its entry decides this runtime's listener`,
    );
  }

  const activeDescriptor = active ? tunnelProviderDescriptor(active.provider) : undefined;
  if (active && activeDescriptor?.originOwner === 'console') {
    const read = await deps.readDeclaredOrigin(active, { env, active: true });
    if (read.origin) {
      const label = `the ${activeDescriptor.label} console's declared tunnel origin ${read.origin.port}`;
      assertUsableIngressPort(read.origin.port, { label, reservedPorts });
      await requireFree(read.origin.port, label, deps);
      if (read.origin.scheme && read.origin.scheme !== 'http') {
        deps.logger.warn(
          `${activeDescriptor.label} declares the origin as ${read.origin.scheme}://localhost:${read.origin.port}, `
          + `but this runtime's tunnel entry speaks plain HTTP; the port is adopted, the scheme is not `
          + '(terminate TLS in the provider, or point the console at http://)',
        );
      }
      deps.logger.info(
        `Adopting the ${activeDescriptor.label} console's tunnel origin ${read.origin.port} `
        + `(${read.origin.readBack}); the operator does not have to edit the console`,
      );
      return {
        port: read.origin.port,
        source: 'console-declared',
        declared: {
          profileId: active.id,
          provider: activeDescriptor.id,
          port: read.origin.port,
          readBack: read.origin.readBack,
          ...(read.origin.scheme ? { scheme: read.origin.scheme } : {}),
        },
        inactiveDeclarations,
      };
    }
    // The console owns the number, so the runtime cannot invent a different one and still be
    // reachable. The declaration is unreadable here, which is reported loudly; an explicit pin
    // (handled above) is the deterministic way out.
    deps.logger.warn(
      `the ${activeDescriptor.label} console's tunnel origin could not be read `
      + `(${read.error ?? 'no reason reported'}); this runtime will serve the default tunnel entry `
      + 'instead, and the tunnel provider will report its own failure. '
      + 'Pin XPOD_GATEWAY_INGRESS_PORT to decide the entry explicitly',
    );
  }

  const port = await deps.findDefaultPort(request.mainPort);
  deps.logger.info(
    `Tunnel entry ${port} chosen from the gateway port ${request.mainPort} (gateway+3..+9, first free port)`,
  );
  return { port, source: 'gateway-default', inactiveDeclarations };
}

/** A strict port is taken as-is or not at all; the occupant is named, never signalled. */
async function requireFree(port: number, label: string, deps: IngressPortDeps): Promise<void> {
  if (await deps.isFree(port)) {
    return;
  }
  const occupant = deps.identifyOccupants(port);
  throw new IngressPortConflictError(port, occupant);
}

async function readInactiveConsoleDeclarations(input: {
  profiles: readonly IngressProfileLike[];
  active?: IngressProfileLike;
  env: Record<string, string | undefined>;
  deps: IngressPortDeps;
}): Promise<IngressPortDeclaration[]> {
  const declarations: IngressPortDeclaration[] = [];
  for (const profile of input.profiles) {
    if (profile.id === input.active?.id) {
      continue;
    }
    if (tunnelProviderDescriptor(profile.provider)?.originOwner !== 'console') {
      continue;
    }
    const read = await input.deps.readDeclaredOrigin(profile, { env: input.env, active: false });
    if (read.origin) {
      declarations.push({
        profileId: profile.id,
        provider: profile.provider,
        port: read.origin.port,
        readBack: read.origin.readBack,
        ...(read.origin.scheme ? { scheme: read.origin.scheme } : {}),
      });
    }
  }
  return declarations;
}
