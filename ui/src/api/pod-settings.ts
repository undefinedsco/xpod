export interface PodSettingsStatus {
  identity: {
    webId: string;
    podUrl?: string;
  };
  storage: PodStorageStatus;
  generatedAt?: string;
}

export type PodStorageStatus =
  | {
    status: 'available';
    usage: {
      storageBytes: number;
      ingressBytes: number;
      egressBytes: number;
    };
    limits: {
      storageLimitBytes: number | null;
      bandwidthLimitBps: number | null;
    };
    source?: string;
  }
  | {
    status: 'unsupported' | 'error';
    reason?: string;
  };

export async function fetchPodSettingsStatus({
  webId,
  podUrl,
  authenticatedFetch,
}: {
  webId: string;
  podUrl: string;
  authenticatedFetch: typeof fetch;
}): Promise<PodSettingsStatus> {
  const apiBase = new URL('/', podUrl).origin;
  const response = await authenticatedFetch(`${apiBase}/api/pod/settings/status`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error('Pod settings request failed. Please try again.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.arrayBuffer();
    throw new Error('Pod settings request failed. Please try again.');
  }

  const payload = await response.json() as PodSettingsStatus;
  if (payload.identity?.webId !== webId) {
    throw new Error('Pod settings response does not match the current Solid session.');
  }
  return payload;
}
