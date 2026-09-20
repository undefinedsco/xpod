import {
  TUNNEL_PROVIDERS,
  TUNNEL_PROVIDER_IDS,
  isTunnelProviderId,
  parseTunnelProvider,
  tunnelProfileCredentialEnvKey,
  tunnelProviderDescriptor,
  type ActiveTunnelProvider,
  type TunnelProviderId,
} from './TunnelProviderCatalog';

export { TUNNEL_PROVIDER_IDS };
export const TUNNEL_PROVIDER_VALUES = TUNNEL_PROVIDER_IDS;
export type TunnelProfileProvider = TunnelProviderId;
export type { ActiveTunnelProvider };

/** The canonical off value: an explicit "no tunnel" is a decision, not a missing value. */
export const TUNNEL_ACTIVE_PROFILE_NONE = 'none';

export interface TunnelProfile {
  id: string;
  provider: TunnelProfileProvider;
  label?: string;
  publicUrl?: string;
  credentialEnvKey?: string;
  credentialConfigured?: boolean;
  /**
   * Provider parameters as stored by the settings API.
   *
   * They are carried rather than dropped so the runtime never silently loses a value the
   * API accepted, and so a provider that can honour one has it available; a parameter no
   * provider consumes is reported by `unconsumedProfileParameters()` instead of vanishing.
   */
  parameters?: Record<string, string>;
}

export interface TunnelProfileState {
  profiles: TunnelProfile[];
  activeProfileId?: string;
  activeProfile?: TunnelProfile;
  inactiveProfiles: TunnelProfile[];
  activeProvider: ActiveTunnelProvider;
  /** Why the requested profile is not active; missing when the state is unremarkable. */
  activationError?: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Resolves the tunnel profile state for a runtime environment.
 *
 * Authority rules (they are what stops a closed tunnel from coming back):
 * - `XPOD_TUNNEL_PROFILES` being **present** is authoritative — an empty list means "no
 *   profiles", never "fall back to the legacy keys".
 * - `XPOD_TUNNEL_ACTIVE_PROFILE_ID` being **present** is authoritative — an empty value or
 *   `none` means "explicitly off" and suppresses the legacy provider and the auto-pick.
 */
export function resolveTunnelProfileState(env: EnvLike): TunnelProfileState {
  const profilesDeclared = env.XPOD_TUNNEL_PROFILES !== undefined;
  const explicitProfiles = parseTunnelProfiles(env.XPOD_TUNNEL_PROFILES, env);
  const profiles = profilesDeclared ? explicitProfiles : buildLegacyTunnelProfiles(env);
  const activeProfileId = resolveActiveProfileId(env, profiles, profilesDeclared);
  return selectActiveTunnelProfile(profiles, activeProfileId);
}

export function selectActiveTunnelProfile(
  inputProfiles: readonly TunnelProfile[],
  activeProfileId?: string,
): TunnelProfileState {
  const profiles = normalizeProfiles(inputProfiles);
  const requestedId = readString(activeProfileId);
  if (requestedId === TUNNEL_ACTIVE_PROFILE_NONE) {
    return {
      profiles,
      activeProfileId: TUNNEL_ACTIVE_PROFILE_NONE,
      inactiveProfiles: profiles,
      activeProvider: 'none',
    };
  }

  const requested = requestedId ? profiles.find((profile) => profile.id === requestedId) : undefined;
  const unsupported = requested && tunnelProviderDescriptor(requested.provider)?.runtimeSupported === false
    ? requested
    : undefined;
  const activeProfile = requested && !unsupported && canActivateProfile(requested) ? requested : undefined;
  const inactiveProfiles = profiles.filter((profile) => profile.id !== activeProfile?.id);

  return {
    profiles,
    activeProfileId: requestedId,
    activeProfile,
    inactiveProfiles,
    activeProvider: activeProfile?.provider ?? 'none',
    ...(unsupported
      ? { activationError: `provider ${unsupported.provider} has no local runtime implementation` }
      : requested && !activeProfile
        ? { activationError: `profile ${requested.id} has no credential configured` }
        : {}),
  };
}

function buildLegacyTunnelProfiles(env: EnvLike): TunnelProfile[] {
  const legacyProvider = parseTunnelProvider(env.XPOD_TUNNEL_PROVIDER);
  const profiles: TunnelProfile[] = [];
  for (const descriptor of TUNNEL_PROVIDERS) {
    const publicUrl = readFirstUrl(env, descriptor.legacyPublicUrlKeys);
    const credentialConfigured = Boolean(readString(env[descriptor.legacyCredentialEnvKey]));
    if (!publicUrl && !credentialConfigured && legacyProvider !== descriptor.id) {
      continue;
    }
    profiles.push({
      id: descriptor.id,
      provider: descriptor.id,
      label: descriptor.label,
      publicUrl,
      credentialEnvKey: descriptor.legacyCredentialEnvKey,
      credentialConfigured,
    });
  }

  return profiles;
}

function parseTunnelProfiles(value: string | undefined, env: EnvLike): TunnelProfile[] {
  const raw = readString(value);
  if (raw === undefined) {
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
      const provider = parseTunnelProvider(record.provider);
      if (!id || !provider || provider === 'none') {
        return [];
      }
      const { key: credentialEnvKey, configured: credentialConfigured } = resolveProfileCredential(id, provider, env);
      const parameters = readStringRecord(record.parameters);
      return [{
        id,
        provider,
        label: readString(record.label),
        // `publicUrl` is canonical; `publicEndpoint` is the field the settings page used to
        // write, so it is still read for profiles stored before the contract was unified.
        publicUrl: normalizeUrl(readString(record.publicUrl) ?? readString(record.publicEndpoint)),
        credentialEnvKey,
        credentialConfigured,
        ...(parameters ? { parameters } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function resolveProfileCredential(
  profileId: string,
  provider: TunnelProfileProvider,
  env: EnvLike,
): { key?: string; configured?: boolean } {
  const scopedKey = tunnelProfileCredentialEnvKey(profileId);
  if (readString(env[scopedKey])) {
    return { key: scopedKey, configured: true };
  }
  const legacyKey = tunnelProviderDescriptor(provider)?.legacyCredentialEnvKey;
  if (legacyKey && readString(env[legacyKey])) {
    return { key: legacyKey, configured: true };
  }
  // No credential anywhere: keep the profile-scoped key as the address to write to.
  return { key: scopedKey, configured: false };
}

/** Keeps only string-valued parameters: anything else is not a value a provider can use. */
function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([ key, item ]) => [ key, readString(item) ] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Parameters a profile declares that no provider implementation consumes.
 *
 * Reporting them is what keeps the settings form from collecting values with no effect:
 * the fix is either to consume the parameter or to stop declaring the field.
 */
export function unconsumedProfileParameters(
  profile: Pick<TunnelProfile, 'parameters'>,
  consumed: readonly string[] = [],
): string[] {
  return Object.keys(profile.parameters ?? {}).filter((key) => !consumed.includes(key));
}

function normalizeProfiles(inputProfiles: readonly TunnelProfile[]): TunnelProfile[] {
  const seen = new Set<string>();
  const profiles: TunnelProfile[] = [];
  for (const profile of inputProfiles) {
    const id = readString(profile.id);
    const provider = parseTunnelProvider(profile.provider);
    if (!id || !provider || provider === 'none' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const parameters = readStringRecord(profile.parameters);
    profiles.push({
      id,
      provider,
      label: readString(profile.label),
      publicUrl: normalizeUrl(profile.publicUrl),
      credentialEnvKey: readString(profile.credentialEnvKey) ?? tunnelProfileCredentialEnvKey(id),
      credentialConfigured: profile.credentialConfigured,
      ...(parameters ? { parameters } : {}),
    });
  }
  return profiles;
}

function resolveActiveProfileId(
  env: EnvLike,
  profiles: readonly TunnelProfile[],
  profilesDeclared: boolean,
): string | undefined {
  const declaredActiveProfileId = env.XPOD_TUNNEL_ACTIVE_PROFILE_ID;
  if (declaredActiveProfileId !== undefined) {
    return readString(declaredActiveProfileId) ?? TUNNEL_ACTIVE_PROFILE_NONE;
  }

  const legacyProviderRaw = readString(env.XPOD_TUNNEL_PROVIDER);
  const legacyProvider = parseTunnelProvider(legacyProviderRaw);
  if (legacyProvider === 'none') {
    return TUNNEL_ACTIVE_PROFILE_NONE;
  }
  const legacyProfileId = legacyProviderToProfileId(legacyProviderRaw, profiles);
  if (legacyProfileId) {
    return legacyProfileId;
  }

  // Only an environment that never declared profiles may fall back to the implicit pick.
  return profilesDeclared ? undefined : profiles.find(canActivateProfile)?.id;
}

function legacyProviderToProfileId(value: string | undefined, profiles: readonly TunnelProfile[]): string | undefined {
  const provider = parseTunnelProvider(value);
  if (!provider || provider === 'none') {
    return undefined;
  }
  return profiles.find((profile) => profile.provider === provider)?.id ?? provider;
}

function canActivateProfile(profile: TunnelProfile): boolean {
  if (tunnelProviderDescriptor(profile.provider)?.runtimeSupported === false) {
    return false;
  }
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

// Re-exported so consumers keep importing the vocabulary from one place.
export { isTunnelProviderId, tunnelProviderDescriptor, tunnelProfileCredentialEnvKey };
