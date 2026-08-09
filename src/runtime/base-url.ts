const LOOPBACK_HOSTNAMES = new Set([ 'localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1' ]);

export const INVALID_CONFIGURATION_PREFIX = 'Invalid configuration:';

export interface ValidateBaseUrlOptions {
  baseUrl: string;
  mainPort: number;
  explicit: boolean;
}

/**
 * Guards against CSS_BASE_URL drift: when it is explicitly set to a loopback
 * address whose port differs from the gateway port, nothing will serve that
 * address, so OIDC discovery/authorize URLs become unreachable and pods
 * recorded under the old authority are filtered out of the consent page.
 */
export function validateBaseUrl({ baseUrl, mainPort, explicit }: ValidateBaseUrlOptions): void {
  if (!explicit) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidBaseUrl(`CSS_BASE_URL "${baseUrl}" is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidBaseUrl(`CSS_BASE_URL "${baseUrl}" must use http or https`);
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw invalidBaseUrl(
      `CSS_BASE_URL "${baseUrl}" must be an origin root (no subpath, query, or fragment); ` +
      'the gateway rewrites Host headers and cannot honor subpath hosting',
    );
  }

  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return;
  }

  const effectivePort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (effectivePort === String(mainPort)) {
    return;
  }

  throw invalidBaseUrl(
    `CSS_BASE_URL "${baseUrl}" targets loopback port ${effectivePort}, but the gateway will listen on port ${mainPort} ` +
    `and nothing will serve ${effectivePort}; OIDC discovery and login would break. ` +
    `Set CSS_BASE_URL to "${parsed.protocol}//${parsed.hostname}:${mainPort}/" or unset it to use the derived default ` +
    '(see docs/cli-dev-testing.md).',
  );
}

function invalidBaseUrl(reason: string): Error {
  return new Error(`${INVALID_CONFIGURATION_PREFIX} ${reason}`);
}
