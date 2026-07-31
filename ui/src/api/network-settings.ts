export interface NetworkSettingsStatus {
  endpoint: string;
  addresses: {
    local: string[];
    lan: string[];
    public: string[];
  };
  tls: NetworkCapabilityStatus & { expiresAt?: string };
  dns: NetworkCapabilityStatus;
  tunnel: NetworkCapabilityStatus;
  actions: {
    diagnose: true;
    renewCertificate: boolean;
  };
}

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
}

export async function fetchNetworkSettingsStatus({
  podUrl,
  authenticatedFetch,
}: {
  podUrl: string;
  authenticatedFetch: typeof fetch;
}): Promise<NetworkSettingsStatus> {
  return readJson<NetworkSettingsStatus>(authenticatedFetch, new URL('/api/network/settings/status', podUrl).toString(), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
}

export async function runNetworkDiagnostics({
  podUrl,
  authenticatedFetch,
}: {
  podUrl: string;
  authenticatedFetch: typeof fetch;
}): Promise<NetworkDiagnosticsResult> {
  return readJson<NetworkDiagnosticsResult>(authenticatedFetch, new URL('/api/network/settings/diagnose', podUrl).toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
}

export async function renewNetworkCertificate({
  podUrl,
  authenticatedFetch,
}: {
  podUrl: string;
  authenticatedFetch: typeof fetch;
}): Promise<void> {
  await readJson<{ success: boolean }>(authenticatedFetch, new URL('/api/network/settings/certificate/renew', podUrl).toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
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
