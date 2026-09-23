/**
 * The single declaration of the tunnel provider axis.
 *
 * Every provider-specific fact lives here exactly once: the display label, the legacy
 * credential key, where the public entry comes from, whether the local runtime can start
 * it, and the extra parameters the settings form renders. The API serves this catalog to
 * the UI, so the settings page looks a fact up instead of keeping its own copy of the
 * provider list (the drift between those copies is what produced the audit's N09).
 */

export const TUNNEL_PROVIDER_IDS = [ 'ngrok', 'cloudflare', 'sakura_frp', 'frp' ] as const;

export type TunnelProviderId = (typeof TUNNEL_PROVIDER_IDS)[number];
export type ActiveTunnelProvider = TunnelProviderId | 'none';

/**
 * Where a provider's public entry comes from:
 * - `discovered`: the provider reports it (ngrok agent API / logs), so nobody types it.
 * - `declared`: it is a fact of the provider's own console, so an operator may declare it
 *   for display and DNS diagnostics — a declaration is never proof that it is reachable.
 */
export type TunnelEndpointSource = 'discovered' | 'declared';

export interface TunnelProviderParameterField {
  key: string;
  label: string;
}

/**
 * The local client this provider needs (audit N16).
 *
 * Declared here so there is one place that knows the executable name, how an operator points at
 * a specific build, whether the artifact may ship the binary at all, and what to tell them when
 * it is missing. Providers consume it instead of each keeping its own default string.
 */
export interface TunnelProviderClient {
  /** Executable name; also the name reported in `binary-missing:<provider>:<binary>`. */
  binary: string;
  /** Env var that names an explicit path; highest precedence, and never silently ignored. */
  envKey: string;
  /** Where an operator can get it (shown next to a missing-binary failure). */
  installHint: string;
  /**
   * Whether the release artifact may ship this binary. ngrok and the natfrp frpc fork are not
   * ours to redistribute; cloudflared and upstream frpc are Apache-2.0 and could be bundled.
   */
  redistributable: boolean;
  /** Upstream licence / redistribution note, for whoever changes that decision later. */
  license: string;
}

export interface TunnelProviderDescriptor {
  id: TunnelProviderId;
  label: string;
  client: TunnelProviderClient;
  /** Legacy provider-scoped credential key, still honoured for single-profile setups. */
  legacyCredentialEnvKey: string;
  /** Legacy env keys that used to declare this provider's public entry. */
  legacyPublicUrlKeys: readonly string[];
  endpointSource: TunnelEndpointSource;
  /**
   * Who decides which local port the tunnel forwards to.
   *
   * `runtime` means we dial the provider, so the port is ours to choose; `console` means the
   * provider console holds that value and the operator has to copy this runtime's ingress
   * address into it. The settings page renders the copy affordance from this fact instead of
   * branching on a provider id.
   */
  originOwner: 'runtime' | 'console';
  /**
   * Where the operator creates or edits this provider's tunnel.
   *
   * The settings page links to it, because a remotely-managed tunnel's origin (port) is a
   * fact of that console: the operator copies this runtime's ingress address there.
   */
  consoleUrl?: string;
  /** Whether the local runtime has an implementation that can actually start it. */
  runtimeSupported: boolean;
  parameterFields: readonly TunnelProviderParameterField[];
}

/**
 * Generic FRP is the one axis whose endpoints are its own facts, so it is also the only one
 * that declares parameters. A field may only be declared here when an implementation
 * consumes it: a field that reaches no provider makes the settings form collect values with
 * no effect, which is what the provider-contract audit (N09/N10) was about.
 */
const FRP_PARAMETER_FIELDS: readonly TunnelProviderParameterField[] = [
  { key: 'serverHost', label: 'Server host' },
  { key: 'serverPort', label: 'Server port' },
  { key: 'remotePort', label: 'Remote port' },
];

export const TUNNEL_PROVIDERS: readonly TunnelProviderDescriptor[] = [
  {
    id: 'ngrok',
    label: 'ngrok',
    client: {
      binary: 'ngrok',
      envKey: 'NGROK_BIN',
      installHint: 'install the ngrok agent and put it on PATH (or set NGROK_BIN)',
      // ngrok's agent is proprietary: bundling it in our artifact needs their permission.
      redistributable: false,
      license: 'proprietary (ngrok terms of service)',
    },
    legacyCredentialEnvKey: 'NGROK_AUTHTOKEN',
    legacyPublicUrlKeys: [ 'NGROK_URL' ],
    endpointSource: 'discovered',
    originOwner: 'runtime',
    consoleUrl: 'https://dashboard.ngrok.com/',
    runtimeSupported: true,
    // Nothing to declare: ngrok 3 selects the endpoint with `--url` (already carried by
    // `publicUrl`) and has no per-run region flag, so a "region" or "hostname" field here
    // would be collected and ignored.
    parameterFields: [],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    client: {
      binary: 'cloudflared',
      envKey: 'CLOUDFLARED_BIN',
      installHint: 'install cloudflared and put it on PATH (or set CLOUDFLARED_BIN)',
      redistributable: true,
      license: 'Apache-2.0',
    },
    legacyCredentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
    legacyPublicUrlKeys: [ 'CLOUDFLARE_TUNNEL_URL', 'XPOD_TUNNEL_PUBLIC_URL' ],
    // The hostname is configured in the Cloudflare dashboard and cloudflared is only
    // started with `--token` plus the local origin.
    endpointSource: 'declared',
    originOwner: 'console',
    consoleUrl: 'https://one.dash.cloudflare.com/',
    runtimeSupported: true,
    // The dashboard owns the tunnel id and hostname; the hostname is already carried by
    // `publicUrl`, so repeating it as a parameter would be two keys for one semantic.
    parameterFields: [],
  },
  {
    id: 'sakura_frp',
    label: 'Sakura FRP',
    client: {
      binary: 'frpc',
      envKey: 'FRPC_BIN',
      // The official client is required: upstream frpc cannot express `-f <token>`.
      installHint: 'install the natfrp client (its frpc accepts `-f <token>`) and put it on PATH',
      redistributable: false,
      license: 'natfrp fork (no published source; redistribution needs their permission)',
    },
    legacyCredentialEnvKey: 'SAKURA_TUNNEL_TOKEN',
    legacyPublicUrlKeys: [ 'SAKURA_TUNNEL_URL', 'XPOD_TUNNEL_PUBLIC_URL' ],
    // The console only asks for a node and a local port: the public entry (node host +
    // assigned remote port, or a bound domain) is assigned by the platform, so it is read
    // back through the SakuraFrp API instead of being typed by the operator.
    endpointSource: 'discovered',
    originOwner: 'console',
    consoleUrl: 'https://www.natfrp.com/tunnel/',
    runtimeSupported: true,
    // Node, remote port and domain are platform-assigned, so there is nothing to declare.
    parameterFields: [],
  },
  {
    id: 'frp',
    label: 'FRP',
    client: {
      binary: 'frpc',
      envKey: 'FRPC_BIN',
      installHint: 'install upstream frpc and put it on PATH (or set FRPC_BIN)',
      redistributable: true,
      license: 'Apache-2.0',
    },
    legacyCredentialEnvKey: 'FRP_TUNNEL_TOKEN',
    legacyPublicUrlKeys: [ 'FRP_TUNNEL_URL' ],
    endpointSource: 'declared',
    originOwner: 'console',
    // Local mode registers no implementation for the generic FRP axis yet; declaring
    // this true would let the UI save a profile that can never start.
    runtimeSupported: false,
    parameterFields: FRP_PARAMETER_FIELDS,
  },
];

const PROVIDER_ALIASES: Record<string, ActiveTunnelProvider> = {
  none: 'none',
  ngrok: 'ngrok',
  cloudflare: 'cloudflare',
  'sakura-frp': 'sakura_frp',
  sakura_frp: 'sakura_frp',
  frp: 'frp',
};

/** Normalizes any stored/legacy spelling onto the canonical provider vocabulary. */
export function parseTunnelProvider(value: unknown): ActiveTunnelProvider | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return PROVIDER_ALIASES[value.trim().toLowerCase()];
}

export function isTunnelProviderId(value: unknown): value is TunnelProviderId {
  return parseTunnelProvider(value) !== undefined && parseTunnelProvider(value) !== 'none';
}

export function tunnelProviderDescriptor(id: unknown): TunnelProviderDescriptor | undefined {
  const provider = parseTunnelProvider(id);
  if (!provider || provider === 'none') {
    return undefined;
  }
  return TUNNEL_PROVIDERS.find((descriptor) => descriptor.id === provider);
}

export function tunnelProviderIds(): TunnelProviderId[] {
  return TUNNEL_PROVIDERS.map((descriptor) => descriptor.id);
}

/** Credential key namespace for one profile, so two profiles never share a secret. */
export const TUNNEL_PROFILE_CREDENTIAL_PREFIX = 'XPOD_TUNNEL_PROFILE_';

/** Env key holding one profile's credential; the `_TOKEN` suffix keeps it secret-classified. */
export function tunnelProfileCredentialEnvKey(profileId: string): string {
  const sanitized = profileId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return `${TUNNEL_PROFILE_CREDENTIAL_PREFIX}${sanitized || 'DEFAULT'}_TOKEN`;
}

export function isTunnelProfileCredentialEnvKey(key: string): boolean {
  return key.startsWith(TUNNEL_PROFILE_CREDENTIAL_PREFIX) && key.endsWith('_TOKEN');
}
