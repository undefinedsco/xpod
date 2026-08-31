const LOCAL_ACCOUNT_INDEX = '/.account/';

export async function resolveXpodAccountIndex(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (typeof window === 'undefined') return LOCAL_ACCOUNT_INDEX;
  if (!isLoopbackHostname(window.location.hostname)) {
    return new URL(LOCAL_ACCOUNT_INDEX, window.location.origin).href;
  }
  try {
    const response = await fetchImpl(new URL('/provision/status', window.location.origin), {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return new URL(LOCAL_ACCOUNT_INDEX, window.location.origin).href;
    const status = await response.json() as { managed?: unknown; oidcIssuer?: unknown };
    if (status.managed === true && typeof status.oidcIssuer === 'string') {
      const issuer = new URL(status.oidcIssuer);
      if (['http:', 'https:'].includes(issuer.protocol) && !issuer.username && !issuer.password) {
        return new URL(LOCAL_ACCOUNT_INDEX, issuer).href;
      }
    }
  } catch {
    // Standalone and Cloud deployments retain their same-origin Account API.
  }
  return new URL(LOCAL_ACCOUNT_INDEX, window.location.origin).href;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
