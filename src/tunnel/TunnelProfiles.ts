export const TUNNEL_PROVIDER_VALUES = ['ngrok', 'cloudflare', 'sakura_frp', 'frp'] as const;
export type TunnelProfileProvider = (typeof TUNNEL_PROVIDER_VALUES)[number];
export type ActiveTunnelProvider = TunnelProfileProvider | 'none';

export interface TunnelProfile {
  id: string;
  provider: TunnelProfileProvider;
  label?: string;
  publicUrl?: string;
  credentialEnvKey?: string;
  credentialConfigured?: boolean;
}

export interface TunnelProfileState {
  profiles: TunnelProfile[];
  activeProfileId?: string;
  activeProfile?: TunnelProfile;
  inactiveProfiles: TunnelProfile[];
  activeProvider: ActiveTunnelProvider;
}

type EnvLike = Record<string, string | undefined>;

type LegacyProviderSpec = {
  provider: TunnelProfileProvider;
  id: string;
  label: string;
  publicUrlKeys: string[];
  credentialEnvKey?: string;
};

const LEGACY_PROVIDER_SPECS: LegacyProviderSpec[] = [
  {
    provider: 'ngrok',
    id: 'ngrok',
    label: 'ngrok',
    publicUrlKeys: ['NGROK_URL'],
    credentialEnvKey: 'NGROK_AUTHTOKEN',
  },
  {
    provider: 'cloudflare',
    id: 'cloudflare',
    label: 'Cloudflare Tunnel',
    publicUrlKeys: ['CLOUDFLARE_TUNNEL_URL', 'XPOD_TUNNEL_PUBLIC_URL'],
    credentialEnvKey: 'CLOUDFLARE_TUNNEL_TOKEN',
  },
  {
    provider: 'sakura_frp',
    id: 'sakura_frp',
    label: 'Sakura FRP',
    publicUrlKeys: ['SAKURA_TUNNEL_URL', 'XPOD_TUNNEL_PUBLIC_URL'],
    credentialEnvKey: 'SAKURA_TUNNEL_TOKEN',
  },
  {
    provider: 'frp',
    id: 'frp',
    label: 'FRP',
    publicUrlKeys: ['FRP_TUNNEL_URL'],
    credentialEnvKey: 'FRP_TUNNEL_TOKEN',
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

export function resolveTunnelProfileState(env: EnvLike): TunnelProfileState {
  const explicitProfiles = parseTunnelProfiles(env.XPOD_TUNNEL_PROFILES, env);
  const profiles = explicitProfiles.length > 0 ? explicitProfiles : buildLegacyTunnelProfiles(env);
  const activeProfileId = resolveActiveProfileId(env, profiles);
  return selectActiveTunnelProfile(profiles, activeProfileId);
}

export function selectActiveTunnelProfile(
  inputProfiles: readonly TunnelProfile[],
  activeProfileId?: string,
): TunnelProfileState {
  const profiles = normalizeProfiles(inputProfiles);
  const requestedId = readString(activeProfileId);
  const activeProfile = profiles.find((profile) => profile.id === requestedId && canActivateProfile(profile));
  const inactiveProfiles = profiles.filter((profile) => profile.id !== activeProfile?.id);

  return {
    profiles,
    activeProfileId: requestedId,
    activeProfile,
    inactiveProfiles,
    activeProvider: activeProfile?.provider ?? 'none',
  };
}

function buildLegacyTunnelProfiles(env: EnvLike): TunnelProfile[] {
  const profiles: TunnelProfile[] = [];
  for (const spec of LEGACY_PROVIDER_SPECS) {
    const publicUrl = readFirstUrl(env, spec.publicUrlKeys);
    const credentialConfigured = spec.credentialEnvKey ? Boolean(readString(env[spec.credentialEnvKey])) : undefined;
    if (!publicUrl && !credentialConfigured && readLegacyProvider(env.XPOD_TUNNEL_PROVIDER) !== spec.provider) {
      continue;
    }
    profiles.push({
      id: spec.id,
      provider: spec.provider,
      label: spec.label,
      publicUrl,
      credentialEnvKey: spec.credentialEnvKey,
      credentialConfigured,
    });
  }

  return profiles;
}

function parseTunnelProfiles(value: string | undefined, env: EnvLike): TunnelProfile[] {
  const raw = readString(value);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item): TunnelProfile[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return [];
      }
      const record = item as Record<string, unknown>;
      const id = readString(record.id);
      const provider = readProvider(record.provider);
      if (!id || !provider || provider === 'none') {
        return [];
      }
      const credentialEnvKey = readString(record.credentialEnvKey) ?? defaultCredentialEnvKey(provider);
      return [{
        id,
        provider,
        label: readString(record.label),
        publicUrl: normalizeUrl(readString(record.publicUrl)),
        credentialEnvKey,
        credentialConfigured: credentialEnvKey ? Boolean(readString(env[credentialEnvKey])) : undefined,
      }];
    });
  } catch {
    return [];
  }
}

function normalizeProfiles(inputProfiles: readonly TunnelProfile[]): TunnelProfile[] {
  const seen = new Set<string>();
  const profiles: TunnelProfile[] = [];
  for (const profile of inputProfiles) {
    const id = readString(profile.id);
    const provider = readProvider(profile.provider);
    if (!id || !provider || provider === 'none' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    profiles.push({
      id,
      provider,
      label: readString(profile.label),
      publicUrl: normalizeUrl(profile.publicUrl),
      credentialEnvKey: readString(profile.credentialEnvKey) ?? defaultCredentialEnvKey(provider),
      credentialConfigured: profile.credentialConfigured,
    });
  }
  return profiles;
}

function resolveActiveProfileId(env: EnvLike, profiles: readonly TunnelProfile[]): string | undefined {
  const explicitProfileId = readString(env.XPOD_TUNNEL_ACTIVE_PROFILE_ID);
  if (explicitProfileId) {
    return explicitProfileId;
  }

  const legacyProviderRaw = readString(env.XPOD_TUNNEL_PROVIDER);
  const legacyProvider = readLegacyProvider(legacyProviderRaw);
  if (legacyProvider === 'none') {
    return 'none';
  }
  const legacyProfileId = legacyProviderToProfileId(legacyProviderRaw, profiles);
  if (legacyProfileId) {
    return legacyProfileId;
  }

  return profiles.find(canActivateProfile)?.id;
}

function legacyProviderToProfileId(value: string | undefined, profiles: readonly TunnelProfile[]): string | undefined {
  const provider = readLegacyProvider(value);
  if (!provider || provider === 'none') {
    return undefined;
  }
  return profiles.find((profile) => profile.provider === provider)?.id ?? provider;
}

function readLegacyProvider(value: string | undefined): ActiveTunnelProvider | undefined {
  return readProvider(value);
}

function readProvider(value: unknown): ActiveTunnelProvider | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return PROVIDER_ALIASES[value.trim().toLowerCase()];
}

function canActivateProfile(profile: TunnelProfile): boolean {
  if (profile.provider === 'ngrok') {
    return true;
  }
  return profile.credentialConfigured !== false;
}

function readFirstUrl(env: EnvLike, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const normalized = normalizeUrl(readString(env[key]));
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function defaultCredentialEnvKey(provider: TunnelProfileProvider): string | undefined {
  return LEGACY_PROVIDER_SPECS.find((spec) => spec.provider === provider)?.credentialEnvKey;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString().replace(/\/+$/u, '') + '/';
  } catch {
    return raw;
  }
}
