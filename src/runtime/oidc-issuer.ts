export type RuntimeEnv = Record<string, string | undefined>;

export const OIDC_ISSUER_ENV_KEYS = [
  'SOLID_OIDC_ISSUER',
] as const;

export const DEFAULT_LOCAL_OIDC_ISSUER = 'https://id.undefineds.co/';

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the external IdP issuer used by local/SP mode.
 *
 * `SOLID_OIDC_ISSUER` is the single process-level contract. Components.js
 * still receives its internal `oidcIssuer` shorthand after resolution.
 * Cloud API endpoints are not identity issuers and must not implicitly
 * switch a local node into SP mode.
 */
export function resolveExternalOidcIssuer(env: RuntimeEnv): string | undefined {
  for (const key of OIDC_ISSUER_ENV_KEYS) {
    const value = cleanEnvValue(env[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function oidcTokenEndpoint(issuer: string): string {
  return `${issuer.replace(/\/+$/u, '')}/.oidc/token`;
}

export function cloudApiEndpointFromIssuer(issuer: string): string {
  const identity = new URL(issuer);
  return identity.origin === 'https://id.undefineds.co'
    ? 'https://api.undefineds.co'
    : identity.origin;
}
