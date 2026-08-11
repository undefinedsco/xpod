export interface NetworkSettingsStatus {
  endpoint: string;
  addresses: {
    local: string[];
    lan: string[];
    public: string[];
  };
  tls: NetworkCapabilityStatus & { domains?: string[]; issuer?: string; validFrom?: string; expiresAt?: string; renewalStatus?: string };
  dns: NetworkCapabilityStatus;
  tunnel: NetworkCapabilityStatus;
  actions: {
    diagnose: true;
    renewCertificate: boolean;
  };
  configuration?: NetworkDesiredConfiguration;
}

export interface NetworkDesiredConfiguration {
  domainDns: { domain: string; ddnsEnabled: boolean; provider: string; recordTtl: number; credentialConfigured: boolean };
  https: { enabled: boolean; acmeEmail: string; domains: string[]; certificatePath?: string; certificateKeyPath?: string; renewBeforeDays: number };
  tunnelProfiles: { activeProfileId: string; profiles: NetworkTunnelProfile[] };
  p2p: { enabled: boolean; signalService: string; fallbackPolicy: 'never' | 'when-direct-unavailable' | 'prefer-p2p' };
}
export interface NetworkTunnelProfile { id: string; provider: 'ngrok' | 'cloudflare' | 'frp'; label: string; publicEndpoint?: string; credentialConfigured: boolean; parameters?: Record<string, string> }
export type NetworkConfigurationPatch = {
  domainDns?: Partial<Omit<NetworkDesiredConfiguration['domainDns'], 'credentialConfigured'>> & { credential?: string };
  https?: Partial<NetworkDesiredConfiguration['https']>;
  tunnelProfiles?: { activeProfileId?: string; profiles?: Array<Omit<NetworkTunnelProfile, 'credentialConfigured'> & { credential?: string }> };
  p2p?: Partial<NetworkDesiredConfiguration['p2p']>;
};

export interface NetworkCapabilityStatus {
  supported: boolean;
  status: string;
}

export interface NetworkDiagnosticsResult {
  checks: NetworkDiagnosticCheckResult[];
}

export interface NetworkDiagnosticCheckResult {
  id: string;
  label: string;
  status: 'ok' | 'warning' | 'error' | 'unsupported';
  detail?: string;
  durationMs?: number;
  checkedAt?: string;
}

export async function fetchNetworkSettingsStatus({
  authenticatedFetch,
}: {
  authenticatedFetch: typeof fetch;
}): Promise<NetworkSettingsStatus> {
  return readJson<NetworkSettingsStatus>(authenticatedFetch, currentOriginApiUrl('/api/network/settings/status'), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
}

export async function runNetworkDiagnostics({
  authenticatedFetch,
}: {
  authenticatedFetch: typeof fetch;
}): Promise<NetworkDiagnosticsResult> {
  return readJson<NetworkDiagnosticsResult>(authenticatedFetch, currentOriginApiUrl('/api/network/settings/diagnose'), {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
}

export async function renewNetworkCertificate({
  authenticatedFetch,
}: {
  authenticatedFetch: typeof fetch;
}): Promise<void> {
  await readJson<{ success: boolean }>(authenticatedFetch, currentOriginApiUrl('/api/network/settings/certificate/renew'), {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
}

export async function updateNetworkConfiguration({ podUrl, authenticatedFetch, patch }: { podUrl?: string; authenticatedFetch: typeof fetch; patch: NetworkConfigurationPatch }): Promise<{ configuration: NetworkDesiredConfiguration; applyState: 'restart-required' }> {
  return readJson(authenticatedFetch, networkApiUrl('/api/network/settings/configuration', podUrl), {
    method: 'PUT', credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
}

function currentOriginApiUrl(path: string): string {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(path, origin).toString();
}

/**
 * Keep callers on the current host by default. `podUrl` is retained as an
 * optional compatibility escape hatch for older consumers; Xpod Settings
 * pages intentionally omit it so administrative requests never follow a
 * Solid Pod URL.
 */
function networkApiUrl(path: string, podUrl?: string): string {
  return podUrl ? new URL(path, podUrl).toString() : currentOriginApiUrl(path);
}

async function readJson<T>(
  authenticatedFetch: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await authenticatedFetch(input, init);
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error('Network settings request failed. Please try again.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.arrayBuffer();
    throw new Error('Network settings request failed. Please try again.');
  }
  return await response.json() as T;
}
