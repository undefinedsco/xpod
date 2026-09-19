import type { NetworkConfigurationPatch, NetworkConfigurationStore, NetworkDesiredConfiguration, NetworkTunnelProfile } from '../handlers/NetworkSettingsHandler';
import {
  TUNNEL_ACTIVE_PROFILE_NONE,
  tunnelProfileCredentialEnvKey,
} from '../../tunnel/TunnelProfiles';
import {
  isTunnelProfileCredentialEnvKey,
  isTunnelProviderId,
  tunnelProviderDescriptor,
} from '../../tunnel/TunnelProviderCatalog';

type Env = Record<string, string | undefined>;
export interface NetworkEnvironmentConfigurationStoreOptions {
  read(): Env | Promise<Env>;
  /**
   * Persists a patch. `removals` lists keys that must be deleted from the environment
   * instead of overwritten — deleting a profile has to take its credential with it,
   * otherwise the leftover secret rebuilds the tunnel the user just closed.
   */
  write(patch: Record<string, string>, removals?: string[]): void | Promise<void>;
}

export class NetworkEnvironmentConfigurationStore implements NetworkConfigurationStore {
  public constructor(private readonly options: NetworkEnvironmentConfigurationStoreOptions) {}

  public async read(): Promise<NetworkDesiredConfiguration> {
    return configurationFromEnv(await this.options.read());
  }

  public async update(patch: NetworkConfigurationPatch): Promise<NetworkDesiredConfiguration> {
    const current = await this.options.read();
    const { envPatch, removals } = environmentPatch(patch, current);
    await this.options.write(envPatch, removals);
    const next: Env = { ...current, ...envPatch };
    for (const key of removals) {
      delete next[key];
    }
    return configurationFromEnv(next);
  }
}

function configurationFromEnv(env: Env): NetworkDesiredConfiguration {
  const profiles = parseProfiles(env.XPOD_TUNNEL_PROFILES, env);
  const dnsProvider = env.XPOD_DNS_PROVIDER || 'cloudflare';
  return {
    domainDns: {
      domain: env.XPOD_DNS_DOMAIN ?? '',
      ddnsEnabled: env.XPOD_DDNS_ENABLED === 'true',
      provider: dnsProvider,
      recordTtl: positiveInteger(env.XPOD_DNS_RECORD_TTL, 300),
      credentialConfigured: Boolean(dnsCredential(env, dnsProvider)),
    },
    https: {
      enabled: env.XPOD_HTTPS_MODE !== undefined && env.XPOD_HTTPS_MODE !== 'off',
      acmeEmail: env.XPOD_ACME_EMAIL ?? '',
      domains: splitList(env.XPOD_ACME_DOMAINS),
      ...(env.XPOD_HTTPS_CERT_PATH ? { certificatePath: env.XPOD_HTTPS_CERT_PATH } : {}),
      ...(env.XPOD_HTTPS_KEY_PATH ? { certificateKeyPath: env.XPOD_HTTPS_KEY_PATH } : {}),
      renewBeforeDays: positiveInteger(env.XPOD_ACME_RENEW_BEFORE_DAYS, 30),
    },
    tunnelProfiles: {
      activeProfileId: env.XPOD_TUNNEL_ACTIVE_PROFILE_ID !== undefined
        ? (env.XPOD_TUNNEL_ACTIVE_PROFILE_ID.trim() || TUNNEL_ACTIVE_PROFILE_NONE)
        : '',
      profiles,
    },
    p2p: {
      enabled: env.XPOD_P2P_ENABLED === 'true',
      signalService: env.XPOD_P2P_SIGNAL_SERVICE ?? '',
      fallbackPolicy: p2pFallback(env.XPOD_P2P_FALLBACK_POLICY),
    },
  };
}

function environmentPatch(
  patch: NetworkConfigurationPatch,
  current: Env,
): { envPatch: Record<string, string>; removals: string[] } {
  const output: Record<string, string> = {};
  const removals = new Set<string>();
  if (patch.domainDns) {
    assign(output, 'XPOD_DNS_DOMAIN', patch.domainDns.domain);
    assign(output, 'XPOD_DDNS_ENABLED', boolString(patch.domainDns.ddnsEnabled));
    assign(output, 'XPOD_DNS_PROVIDER', patch.domainDns.provider);
    assign(output, 'XPOD_DNS_RECORD_TTL', numberString(patch.domainDns.recordTtl));
    if (patch.domainDns.credential !== undefined) output[dnsCredentialKey(patch.domainDns.provider ?? current.XPOD_DNS_PROVIDER ?? 'cloudflare')] = patch.domainDns.credential;
  }
  if (patch.https) {
    assign(output, 'XPOD_HTTPS_MODE', patch.https.enabled === undefined ? undefined : patch.https.enabled ? 'acme' : 'off');
    assign(output, 'XPOD_ACME_EMAIL', patch.https.acmeEmail);
    assign(output, 'XPOD_ACME_DOMAINS', patch.https.domains?.join(','));
    // The runtime reads the ACME key names; the settings page used to write
    // XPOD_HTTPS_* which nothing consumed.
    assign(output, 'XPOD_ACME_CERTIFICATE_PATH', patch.https.certificatePath);
    assign(output, 'XPOD_ACME_CERTIFICATE_KEY_PATH', patch.https.certificateKeyPath);
    assign(output, 'XPOD_ACME_RENEW_BEFORE_DAYS', numberString(patch.https.renewBeforeDays));
  }
  if (patch.p2p) {
    assign(output, 'XPOD_P2P_ENABLED', boolString(patch.p2p.enabled));
    assign(output, 'XPOD_P2P_SIGNAL_SERVICE', patch.p2p.signalService);
    assign(output, 'XPOD_P2P_FALLBACK_POLICY', patch.p2p.fallbackPolicy);
  }
  if (patch.tunnelProfiles) {
    // An empty selection is the explicit off decision, stored as its own value so the
    // runtime can tell it apart from "never configured".
    assign(output, 'XPOD_TUNNEL_ACTIVE_PROFILE_ID', patch.tunnelProfiles.activeProfileId === ''
      ? TUNNEL_ACTIVE_PROFILE_NONE
      : patch.tunnelProfiles.activeProfileId);
    if (patch.tunnelProfiles.profiles) {
      const serialized = patch.tunnelProfiles.profiles.map(({ credential, publicEndpoint, ...profile }) => ({
        ...profile,
        // Canonical field name: the runtime reads publicUrl.
        ...(profile.publicUrl ?? publicEndpoint ? { publicUrl: profile.publicUrl ?? publicEndpoint } : {}),
      }));
      output.XPOD_TUNNEL_PROFILES = JSON.stringify(serialized);
      for (const profile of patch.tunnelProfiles.profiles) {
        if (profile.credential !== undefined && profile.credential !== '') {
          output[tunnelProfileCredentialEnvKey(profile.id)] = profile.credential;
        }
      }
      // Credentials of profiles that are gone must go with them.
      for (const key of Object.keys(current)) {
        if (!isTunnelProfileCredentialEnvKey(key)) {
          continue;
        }
        if (!patch.tunnelProfiles.profiles.some((profile) => tunnelProfileCredentialEnvKey(profile.id) === key)) {
          removals.add(key);
        }
      }
    }
  }
  return { envPatch: output, removals: [ ...removals ] };
}

function parseProfiles(raw: string | undefined, env: Env): NetworkTunnelProfile[] {
  if (raw === undefined) return [];
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.label !== 'string' || !isTunnelProviderId(item.provider)) return [];
      const provider = item.provider as NetworkTunnelProfile['provider'];
      const publicUrl = firstString(item.publicUrl, item.publicEndpoint);
      const credentialKey = resolveCredentialKey(item.id, provider, env);
      return [{
        id: item.id,
        provider,
        label: item.label,
        ...(publicUrl ? { publicUrl } : {}),
        credentialConfigured: Boolean(env[credentialKey]),
        ...(plainStringRecord(item.parameters) ? { parameters: item.parameters } : {}),
      }];
    });
  } catch { return []; }
}

/** Profile-scoped credential first; a provider-global key still serves legacy setups. */
function resolveCredentialKey(profileId: string, provider: NetworkTunnelProfile['provider'], env: Env): string {
  const scopedKey = tunnelProfileCredentialEnvKey(profileId);
  if (env[scopedKey]) return scopedKey;
  const legacyKey = tunnelProviderDescriptor(provider)?.legacyCredentialEnvKey;
  return legacyKey && env[legacyKey] ? legacyKey : scopedKey;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function splitList(value: string | undefined): string[] { return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []; }
function positiveInteger(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function dnsCredential(env: Env, provider: string): string | undefined { return env[dnsCredentialKey(provider)]; }
function dnsCredentialKey(provider: string): string { return provider === 'tencent' ? 'XPOD_TENCENT_DNS_TOKEN' : provider === 'cloudflare' ? 'CLOUDFLARE_API_TOKEN' : 'XPOD_DNS_PROVIDER_TOKEN'; }
function p2pFallback(value: string | undefined): NetworkDesiredConfiguration['p2p']['fallbackPolicy'] { return value === 'never' || value === 'prefer-p2p' ? value : 'when-direct-unavailable'; }
function plainStringRecord(value: unknown): value is Record<string, string> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string'); }
function boolString(value: boolean | undefined): string | undefined { return value === undefined ? undefined : String(value); }
function numberString(value: number | undefined): string | undefined { return value === undefined ? undefined : String(value); }
function assign(target: Record<string, string>, key: string, value: string | undefined): void { if (value !== undefined) target[key] = value; }
