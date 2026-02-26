/**
 * CSS Account API helpers for CLI commands.
 *
 * Wraps the CSS .account/* endpoints used by login, credential management, etc.
 */

export interface AccountControls {
  pod?: string;
  clientCredentials?: string;
  webId?: string[];
}

export interface AccountData {
  controls: AccountControls;
  pods: Record<string, string>;
  webIds: Record<string, string>;
  clientCredentials: Record<string, string>;
}

export interface ClientCredential {
  id: string;
  secret?: string;
  label?: string;
  webId?: string;
}

function resolveBaseUrl(url?: string): string {
  const raw = url ?? process.env.CSS_BASE_URL ?? 'http://localhost:3000';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * Check if the CSS server is reachable.
 */
export async function checkServer(baseUrl?: string): Promise<boolean> {
  try {
    const res = await fetch(`${resolveBaseUrl(baseUrl)}.account/`, {
      headers: { Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Login with email/password, returns a CSS account token.
 */
export async function login(
  email: string,
  password: string,
  baseUrl?: string,
): Promise<string | null> {
  const base = resolveBaseUrl(baseUrl);
  try {
    const res = await fetch(`${base}.account/login/password/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { authorization?: string };
    return data.authorization ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch account controls (endpoints for pod/credential management).
 */
export async function getAccountControls(
  token: string,
  baseUrl?: string,
): Promise<AccountControls | null> {
  const base = resolveBaseUrl(baseUrl);
  try {
    const res = await fetch(`${base}.account/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      controls?: {
        account?: {
          pod?: string;
          clientCredentials?: string;
          webId?: string;
        };
      };
    };
    return {
      pod: data.controls?.account?.pod,
      clientCredentials: data.controls?.account?.clientCredentials,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch full account data including pods, webIds, and credentials.
 */
export async function getAccountData(
  token: string,
  baseUrl?: string,
): Promise<AccountData | null> {
  const base = resolveBaseUrl(baseUrl);
  try {
    const res = await fetch(`${base}.account/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      controls?: {
        account?: {
          pod?: string;
          clientCredentials?: string;
          webId?: string;
        };
      };
      pods?: Record<string, string>;
      webIds?: Record<string, string>;
      clientCredentials?: Record<string, string>;
    };
    return {
      controls: {
        pod: data.controls?.account?.pod,
        clientCredentials: data.controls?.account?.clientCredentials,
      },
      pods: data.pods ?? {},
      webIds: data.webIds ?? {},
      clientCredentials: data.clientCredentials ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Create a new pod for the account.
 */
export async function createPod(
  token: string,
  podEndpoint: string,
  podName: string,
): Promise<{ podUrl: string; webId: string } | null> {
  try {
    const res = await fetch(podEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({ name: podName }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { pod?: string; webId?: string };
    if (!data.pod || !data.webId) return null;
    return { podUrl: data.pod, webId: data.webId };
  } catch {
    return null;
  }
}

/**
 * Create a new client credential bound to a WebID.
 */
export async function createClientCredentials(
  token: string,
  credentialsUrl: string,
  webId: string,
  name?: string,
): Promise<ClientCredential | null> {
  try {
    const res = await fetch(credentialsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
      body: JSON.stringify({
        name: name ?? `xpod-cli-${Date.now()}`,
        webId,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ClientCredential;
  } catch {
    return null;
  }
}

/**
 * List all client credentials for the account.
 */
export async function listClientCredentials(
  token: string,
  baseUrl?: string,
): Promise<ClientCredential[]> {
  const base = resolveBaseUrl(baseUrl);
  try {
    const res = await fetch(`${base}.account/`, {
      headers: {
        Accept: 'application/json',
        Authorization: `CSS-Account-Token ${token}`,
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      controls?: {
        account?: {
          clientCredentials?: string;
        };
      };
      clientCredentials?: Record<string, string>;
    };

    // CSS returns clientCredentials as { [credentialUrl]: webId }
    const creds = data.clientCredentials;
    if (!creds || typeof creds !== 'object') return [];

    return Object.entries(creds).map(([url, webId]) => {
      // Extract credential ID from URL (last path segment)
      const id = url.split('/').filter(Boolean).pop() ?? url;
      return { id, webId: typeof webId === 'string' ? webId : undefined };
    });
  } catch {
    return [];
  }
}

/**
 * Revoke (delete) a client credential by its ID.
 */
export async function revokeClientCredential(
  token: string,
  credentialId: string,
  baseUrl?: string,
): Promise<boolean> {
  const base = resolveBaseUrl(baseUrl);
  try {
    const url = `${base}.account/client-credentials/${credentialId}/`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `CSS-Account-Token ${token}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}
