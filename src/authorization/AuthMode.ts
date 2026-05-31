export const DEFAULT_AUTH_MODE = 'acp' as const;
export const AUTH_MODE_ENV_KEY = 'CSS_AUTH_MODE' as const;
const LEGACY_AUTH_MODE_ENV_KEY = 'XPOD_AUTH_MODE';

export type AuthMode = 'acp' | 'acl' | 'allow-all';

const AUTH_MODE_ALIASES: Record<string, AuthMode> = {
  acp: 'acp',
  acr: 'acp',
  acl: 'acl',
  wac: 'acl',
  webacl: 'acl',
  'allow-all': 'allow-all',
  allowall: 'allow-all',
};

const AUTH_MODE_LABEL = 'acp, acl, allow-all';

export function normalizeAuthMode(value: string | null | undefined, fallback: AuthMode = DEFAULT_AUTH_MODE): AuthMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  const mode = AUTH_MODE_ALIASES[normalized];
  if (!mode) {
    throw new Error(`Unsupported auth mode: ${value}. Expected one of: ${AUTH_MODE_LABEL}`);
  }
  return mode;
}

export function resolveAuthModeInput(
  value: AuthMode | string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): AuthMode {
  return normalizeAuthMode(value ?? env[AUTH_MODE_ENV_KEY]);
}

export function resolveAuthModeFromEnv(env: Record<string, string | undefined>): AuthMode {
  return resolveAuthModeInput(undefined, env);
}

function authModeToEnv(mode: AuthMode): Record<typeof AUTH_MODE_ENV_KEY, AuthMode> {
  return {
    [AUTH_MODE_ENV_KEY]: mode,
  };
}

export function applyAuthModeEnv<T extends Record<string, string | undefined>>(
  env: T,
  mode: AuthMode,
): T & Record<typeof AUTH_MODE_ENV_KEY, AuthMode> {
  delete env[LEGACY_AUTH_MODE_ENV_KEY];
  return Object.assign(env, authModeToEnv(mode));
}

export function isAuthModeEnvKey(key: string): boolean {
  return key === AUTH_MODE_ENV_KEY;
}
