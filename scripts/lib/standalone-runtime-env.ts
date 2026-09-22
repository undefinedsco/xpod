/**
 * Environment for an acceptance runtime that owns its identity.
 *
 * Reusing this machine's persisted managed registration would point identity at Cloud, where the
 * throwaway accounts these scripts create do not exist, and the account app would authenticate
 * against Cloud instead of the runtime in front of it. Nothing here is about privacy: it is the
 * difference between "a standalone deployment under test" and "this machine's developer node".
 */
export function standaloneRuntimeEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    CSS_LOGGING_LEVEL: 'warn',
    CSS_REDIS_CLIENT: undefined,
    CSS_REDIS_USERNAME: undefined,
    CSS_REDIS_PASSWORD: undefined,
    XPOD_NODE_ID: undefined,
    XPOD_NODE_TOKEN: undefined,
    XPOD_SERVICE_TOKEN: undefined,
    XPOD_PROVISION_CODE: undefined,
    XPOD_PROVISION_URL: undefined,
    XPOD_PUBLIC_URL: undefined,
    XPOD_SP_DOMAIN: undefined,
    XPOD_LOCAL_SETUP_PATH: undefined,
    XPOD_LOCAL_AUTO_PROVISION_TIMEOUT_MS: undefined,
    SOLID_OIDC_ISSUER: undefined,
    ...overrides,
  };
}
