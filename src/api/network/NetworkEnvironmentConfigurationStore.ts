import type { NetworkConfigurationPatch, NetworkConfigurationStore, NetworkDesiredConfiguration, NetworkTunnelProfile } from '../handlers/NetworkSettingsHandler';

type Env = Record<string, string | undefined>;
export interface NetworkEnvironmentConfigurationStoreOptions {
  read(): Env | Promise<Env>;
  write(patch: Record<string, string>): void | Promise<void>;
}

export class NetworkEnvironmentConfigurationStore implements NetworkConfigurationStore {
  public constructor(private readonly options: NetworkEnvironmentConfigurationStoreOptions) {}

  public async read(): Promise<NetworkDesiredConfiguration> {
    return configurationFromEnv(await this.options.read());
  }

  public async update(patch: NetworkConfigurationPatch): Promise<NetworkDesiredConfiguration> {
    const current = await this.options.read();
    const envPatch = environmentPatch(patch, current);
    await this.options.write(envPatch);
    return configurationFromEnv({ ...current, ...envPatch });
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
    tunnelProfiles: { activeProfileId: env.XPOD_TUNNEL_ACTIVE_PROFILE_ID ?? '', profiles },
    p2p: {
      enabled: env.XPOD_P2P_ENABLED === 'true',
      signalService: env.XPOD_P2P_SIGNAL_SERVICE ?? '',
      fallbackPolicy: p2pFallback(env.XPOD_P2P_FALLBACK_POLICY),
    },
  };
}

function environmentPatch(patch: NetworkConfigurationPatch, current: Env): Record<string, string> {
  const output: Record<string, string> = {};
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
    assign(output, 'XPOD_HTTPS_CERT_PATH', patch.https.certificatePath);
    assign(output, 'XPOD_HTTPS_KEY_PATH', patch.https.certificateKeyPath);
    assign(output, 'XPOD_ACME_RENEW_BEFORE_DAYS', numberString(patch.https.renewBeforeDays));
  }
  if (patch.p2p) {
    assign(output, 'XPOD_P2P_ENABLED', boolString(patch.p2p.enabled));
    assign(output, 'XPOD_P2P_SIGNAL_SERVICE', patch.p2p.signalService);
    assign(output, 'XPOD_P2P_FALLBACK_POLICY', patch.p2p.fallbackPolicy);
  }
  if (patch.tunnelProfiles) {
    assign(output, 'XPOD_TUNNEL_ACTIVE_PROFILE_ID', patch.tunnelProfiles.activeProfileId);
    if (patch.tunnelProfiles.profiles) {
      const serialized = patch.tunnelProfiles.profiles.map(({ credential, ...profile }) => profile);
      output.XPOD_TUNNEL_PROFILES = JSON.stringify(serialized);
      for (const profile of patch.tunnelProfiles.profiles) if (profile.credential !== undefined) output[tunnelCredentialKey(profile.provider)] = profile.credential;
    }
  }
  return output;
}

function parseProfiles(raw: string | undefined, env: Env): NetworkTunnelProfile[] {
  if (!raw) return [];
  try {
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.label !== 'string' || !['ngrok', 'cloudflare', 'frp'].includes(String(item.provider))) return [];
      const provider = item.provider as NetworkTunnelProfile['provider'];
      return [{ id: item.id, provider, label: item.label, ...(typeof item.publicEndpoint === 'string' ? { publicEndpoint: item.publicEndpoint } : {}), credentialConfigured: Boolean(env[tunnelCredentialKey(provider)]), ...(plainStringRecord(item.parameters) ? { parameters: item.parameters } : {}) }];
    });
  } catch { return []; }
}

function splitList(value: string | undefined): string[] { return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []; }
function positiveInteger(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
function dnsCredential(env: Env, provider: string): string | undefined { return env[dnsCredentialKey(provider)]; }
function dnsCredentialKey(provider: string): string { return provider === 'tencent' ? 'XPOD_TENCENT_DNS_TOKEN' : provider === 'cloudflare' ? 'CLOUDFLARE_API_TOKEN' : 'XPOD_DNS_PROVIDER_TOKEN'; }
function tunnelCredentialKey(provider: NetworkTunnelProfile['provider']): string { return provider === 'ngrok' ? 'NGROK_AUTHTOKEN' : provider === 'cloudflare' ? 'CLOUDFLARE_TUNNEL_TOKEN' : 'FRP_TUNNEL_TOKEN'; }
function p2pFallback(value: string | undefined): NetworkDesiredConfiguration['p2p']['fallbackPolicy'] { return value === 'never' || value === 'prefer-p2p' ? value : 'when-direct-unavailable'; }
function plainStringRecord(value: unknown): value is Record<string, string> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string'); }
function boolString(value: boolean | undefined): string | undefined { return value === undefined ? undefined : String(value); }
function numberString(value: number | undefined): string | undefined { return value === undefined ? undefined : String(value); }
function assign(target: Record<string, string>, key: string, value: string | undefined): void { if (value !== undefined) target[key] = value; }
