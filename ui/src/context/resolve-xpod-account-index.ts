import { CLOUD_PROVISIONING_UNAVAILABLE, registerLocalProvisionResolver, setStoredProvisionCode } from '../utils/pod';

const LOCAL_ACCOUNT_INDEX = '/.account/';

interface ProvisionStatusResponse {
  managed?: unknown;
  oidcIssuer?: unknown;
  provisionCode?: unknown;
}

function isProvisionStatusResponse(value: unknown): value is ProvisionStatusResponse {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function resolveXpodAccountIndex(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (typeof window === 'undefined') return LOCAL_ACCOUNT_INDEX;
  if (!isLoopbackHostname(window.location.hostname)) {
    // Public Account HTML is rendered by the authority itself. Its bootstrap remains
    // authoritative when the page was reached through a public alias or proxy.
    const bootstrapIndex = window.__XPOD__?.idpIndex;
    if (bootstrapIndex !== undefined) {
      try {
        const index = new URL(bootstrapIndex, window.location.origin);
        if (
          typeof bootstrapIndex === 'string' && bootstrapIndex.trim()
          && ['http:', 'https:'].includes(index.protocol)
          && index.pathname === LOCAL_ACCOUNT_INDEX
          && !index.username && !index.password && !index.search && !index.hash
        ) return index.href;
      } catch {
        // Invalid explicit authority must not fall back to another Account store.
      }
      throw new Error('Server bootstrap did not expose a valid Account index');
    }
    return new URL(LOCAL_ACCOUNT_INDEX, window.location.origin).href;
  }

  const response = await fetchImpl(new URL('/provision/status', window.location.origin), {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) return new URL(LOCAL_ACCOUNT_INDEX, window.location.origin).href;
  if (!response.ok) {
    throw new Error(`Local provisioning status request failed (${response.status})`);
  }

  let statusJson: unknown;
  try {
    statusJson = await response.json();
  } catch {
    throw new Error('Local provisioning status response was not valid JSON');
  }
  if (!isProvisionStatusResponse(statusJson) || typeof statusJson.managed !== 'boolean') {
    throw new Error('Local provisioning status response was not valid');
  }
  if (statusJson.managed === false) {
    return new URL(LOCAL_ACCOUNT_INDEX, window.location.origin).href;
  }

  if (typeof statusJson.oidcIssuer === 'string') {
    try {
      const issuer = new URL(statusJson.oidcIssuer);
      if (['http:', 'https:'].includes(issuer.protocol) && !issuer.username && !issuer.password) {
        installLocalProvisionResolver(fetchImpl);
        if (typeof statusJson.provisionCode === 'string') setStoredProvisionCode(statusJson.provisionCode);
        return new URL(LOCAL_ACCOUNT_INDEX, issuer).href;
      }
    } catch {
      // Fall through to the fail-closed managed-host error below.
    }
  }

  throw new Error('Local provisioning status did not expose a valid OIDC issuer');
}

function installLocalProvisionResolver(fetchImpl: typeof fetch): void {
  const statusUrl = new URL('/provision/status', window.location.origin);
  registerLocalProvisionResolver(async () => {
    const response = await fetchImpl(statusUrl, {
      credentials: 'include', headers: { accept: 'application/json' },
    });
    const current = response.ok ? await response.json().catch(() => undefined) : undefined;
    if (current?.managed !== true || current?.registered !== true || typeof current?.provisionCode !== 'string') {
      throw new Error(CLOUD_PROVISIONING_UNAVAILABLE);
    }
    return current.provisionCode;
  });
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
