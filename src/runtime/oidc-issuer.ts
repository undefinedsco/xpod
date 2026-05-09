export type RuntimeEnv = Record<string, string | undefined>;

export const OIDC_ISSUER_ENV_KEYS = [
  'CSS_OIDC_ISSUER',
] as const;

function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the external IdP issuer used by local/SP mode.
 *
 * CSS_OIDC_ISSUER is the single supported process-level contract.
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
  return `${issuer.replace(/\/$/, '')}/.oidc/token`;
}
