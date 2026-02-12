const defaultBaseUrl = 'http://localhost:3000/';

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function alignToBaseOrigin(raw: string | undefined, baseUrl: string, fallbackPath: string): string {
  const base = new URL(baseUrl);

  if (!raw) {
    return new URL(fallbackPath, base).toString();
  }

  try {
    const source = new URL(raw);
    if (source.origin === base.origin) {
      return source.toString();
    }

    const aligned = new URL(source.pathname + source.search + source.hash, base);
    return aligned.toString();
  } catch {
    return new URL(fallbackPath, base).toString();
  }
}

export interface SolidIntegrationConfig {
  baseUrl: string;
  oidcIssuer: string;
  webId: string;
}

export function resolveSolidIntegrationConfig(options?: {
  baseUrl?: string;
  defaultPodId?: string;
}): SolidIntegrationConfig {
  const candidateBase =
    options?.baseUrl ||
    process.env.CSS_BASE_URL ||
    process.env.XPOD_SERVER_BASE_URL ||
    defaultBaseUrl;

  const baseUrl = ensureTrailingSlash(candidateBase);
  const defaultPodId = options?.defaultPodId || process.env.SOLID_TEST_POD_ID || 'test';

  const oidcIssuer = alignToBaseOrigin(process.env.SOLID_OIDC_ISSUER, baseUrl, '/');
  const webId = alignToBaseOrigin(process.env.SOLID_WEBID, baseUrl, `/${defaultPodId}/profile/card#me`);

  return {
    baseUrl,
    oidcIssuer: ensureTrailingSlash(oidcIssuer),
    webId,
  };
}
