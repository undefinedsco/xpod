/**
 * Where an OIDC token request is sent, versus the URL its DPoP proof must be made for.
 *
 * Xpod reaches the Solid interface over a loopback alias while the canonical URL never changes
 * (`docs/multi-channel-access.md`). An internal loopback token endpoint therefore needs two
 * things at once: the request goes to the alias, and the receiver is told which canonical origin
 * it is really serving, so the proof verifies against the canonical URL.
 */
export interface TokenEndpointRoute {
  /** Request target: where the token request is actually sent. */
  url: string;
  /** URL the DPoP proof is bound to (`htu`). */
  proofUrl: string;
  /** Headers that make the receiver serve the canonical origin for this request. */
  headers: Record<string, string>;
}

export function resolveTokenEndpointRoute(
  tokenEndpoint: string,
  publicBaseUrl?: string,
): TokenEndpointRoute {
  const headers = canonicalRoutingHeaders(tokenEndpoint, publicBaseUrl);
  if (!publicBaseUrl || Object.keys(headers).length === 0) {
    return { url: tokenEndpoint, proofUrl: tokenEndpoint, headers };
  }
  return {
    url: tokenEndpoint,
    proofUrl: new URL('/.oidc/token', publicBaseUrl).toString(),
    headers,
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalRoutingHeaders(
  tokenEndpoint: string,
  publicBaseUrl: string | undefined,
): Record<string, string> {
  if (!publicBaseUrl) return {};
  try {
    const internal = new URL(tokenEndpoint);
    const canonical = new URL(publicBaseUrl);
    if (internal.origin === canonical.origin || !isLoopbackHostname(internal.hostname)) return {};
    return {
      'X-Forwarded-Host': canonical.host,
      'X-Forwarded-Proto': canonical.protocol.slice(0, -1),
    };
  } catch {
    return {};
  }
}
