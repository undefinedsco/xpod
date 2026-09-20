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

export interface TunnelProviderDescriptor {
  id: TunnelProviderId;
  label: string;
  /** Legacy provider-scoped credential key, still honoured for single-profile setups. */
  legacyCredentialEnvKey: string;
  /** Legacy env keys that used to declare this provider's public entry. */
  legacyPublicUrlKeys: readonly string[];
  endpointSource: TunnelEndpointSource;
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
    legacyCredentialEnvKey: 'NGROK_AUTHTOKEN',
    legacyPublicUrlKeys: [ 'NGROK_URL' ],
    endpointSource: 'discovered',
    runtimeSupported: true,
    // Nothing to declare: ngrok 3 selects the endpoint with `--url` (already carried by
    // `publicUrl`) and has no per-run region flag, so a "region" or "hostname" field here
    // would be collected and ignored.
    parameterFields: [],
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    legacyCredentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
    legacyPublicUrlKeys: [ 'CLOUDFLARE_TUNNEL_URL', 'XPOD_TUNNEL_PUBLIC_URL' ],
    // The hostname is configured in the Cloudflare dashboard and cloudflared is only
    // started with `--token` plus the local origin.
    endpointSource: 'declared',
    runtimeSupported: true,
    // The dashboard owns the tunnel id and hostname; the hostname is already carried by
    // `publicUrl`, so repeating it as a parameter would be two keys for one semantic.
    parameterFields: [],
  },
  {
    id: 'sakura_frp',
    label: 'Sakura FRP',
    legacyCredentialEnvKey: 'SAKURA_TUNNEL_TOKEN',
    legacyPublicUrlKeys: [ 'SAKURA_TUNNEL_URL', 'XPOD_TUNNEL_PUBLIC_URL' ],
    // The console only asks for a node and a local port: the public entry (node host +
    // assigned remote port, or a bound domain) is assigned by the platform, so it is read
    // back through the SakuraFrp API instead of being typed by the operator.
    endpointSource: 'discovered',
    runtimeSupported: true,
    // Node, remote port and domain are platform-assigned, so there is nothing to declare.
    parameterFields: [],
  },
  {
    id: 'frp',
    label: 'FRP',
    legacyCredentialEnvKey: 'FRP_TUNNEL_TOKEN',
    legacyPublicUrlKeys: [ 'FRP_TUNNEL_URL' ],
    endpointSource: 'declared',
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
