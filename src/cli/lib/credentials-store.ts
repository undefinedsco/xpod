/**
 * Shared credential storage for all Solid tools (xpod, LinX, etc.).
 *
 * Single source of truth: ~/.solid/auth/credentials.json
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type AuthType = 'client_credentials' | 'oidc_oauth';

export interface StoredConfig {
  url: string;
  webId: string;
  authType: AuthType;
}

export interface ClientCredentialsSecrets {
  clientId: string;
  clientSecret: string;
}

export interface OidcOAuthSecrets {
  oidcRefreshToken: string;
  oidcAccessToken: string;
  oidcExpiresAt: string;
  oidcClientId?: string;
}

export type StoredSecrets = ClientCredentialsSecrets | OidcOAuthSecrets;

export interface StoredCredentials extends StoredConfig {
  secrets: StoredSecrets;
}

function xpodDir(): string {
  return join(homedir(), '.xpod');
}

export function getConfigPath(): string {
  return join(xpodDir(), 'config.json');
}

export function getSecretsPath(): string {
  return join(xpodDir(), 'secrets.json');
}

function solidAuthDir(): string {
  return join(homedir(), '.solid', 'auth');
}

export function getSolidCredentialsPath(): string {
  return join(solidAuthDir(), 'credentials.json');
}

export function saveCredentials(creds: StoredCredentials): void {
  const dir = solidAuthDir();
  mkdirSync(dir, { recursive: true });

  const filePath = getSolidCredentialsPath();
  writeFileSync(
    filePath,
    JSON.stringify({ url: creds.url, webId: creds.webId, authType: creds.authType, secrets: creds.secrets }, null, 2) + '\n',
    'utf-8'
  );
  chmodSync(filePath, 0o600);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function loadConfig(): StoredConfig | null {
  const data = readJson<Record<string, unknown>>(getConfigPath());
  if (data && typeof data.url === 'string' && typeof data.webId === 'string') {
    const authType = (data.authType as AuthType) || 'client_credentials';
    return { url: data.url, webId: data.webId, authType };
  }
  return null;
}

export function loadSecrets(): StoredSecrets | null {
  const data = readJson<Record<string, unknown>>(getSecretsPath());
  if (!data) return null;

  // Try Client Credentials format
  if (typeof data.clientId === 'string' && typeof data.clientSecret === 'string') {
    return { clientId: data.clientId, clientSecret: data.clientSecret };
  }

  // Try OIDC OAuth format
  if (
    typeof data.oidcRefreshToken === 'string' &&
    typeof data.oidcAccessToken === 'string' &&
    typeof data.oidcExpiresAt === 'string'
  ) {
    return {
      oidcRefreshToken: data.oidcRefreshToken,
      oidcAccessToken: data.oidcAccessToken,
      oidcExpiresAt: data.oidcExpiresAt,
      oidcClientId: typeof data.oidcClientId === 'string' ? data.oidcClientId : undefined,
    };
  }

  return null;
}

/**
 * Load credentials from the shared ~/.solid/auth/credentials.json store.
 *
 * This is the single source of truth for all Solid tools (LinX, xpod, etc.).
 *
 * Format:
 *   {
 *     url: "https://id.undefineds.co/",
 *     webId: "https://id.undefineds.co/user/profile/card#me",
 *     authType: "oidc_oauth",
 *     secrets: {
 *       oidcRefreshToken: "...",
 *       oidcAccessToken: "...",
 *       oidcExpiresAt: "2026-06-06T17:10:49.000Z",
 *       oidcClientId: "..."
 *     }
 *   }
 */
export function loadCredentials(): StoredCredentials | null {
  const data = readJson<Record<string, unknown>>(getSolidCredentialsPath());
  if (!data) return null;

  if (typeof data.url === 'string' && typeof data.webId === 'string') {
    const authType = (data.authType as AuthType) || 'oidc_oauth';
    const rawSecrets = data.secrets as Record<string, unknown> | undefined;

    if (rawSecrets && typeof rawSecrets === 'object') {
      // Client Credentials format
      if (typeof rawSecrets.clientId === 'string' && typeof rawSecrets.clientSecret === 'string') {
        return {
          url: data.url,
          webId: data.webId,
          authType,
          secrets: {
            clientId: rawSecrets.clientId,
            clientSecret: rawSecrets.clientSecret,
          },
        };
      }

      // OIDC OAuth format
      if (
        typeof rawSecrets.oidcRefreshToken === 'string' &&
        typeof rawSecrets.oidcAccessToken === 'string' &&
        typeof rawSecrets.oidcExpiresAt === 'string'
      ) {
        return {
          url: data.url,
          webId: data.webId,
          authType,
          secrets: {
            oidcRefreshToken: rawSecrets.oidcRefreshToken,
            oidcAccessToken: rawSecrets.oidcAccessToken,
            oidcExpiresAt: rawSecrets.oidcExpiresAt,
            oidcClientId: typeof rawSecrets.oidcClientId === 'string' ? rawSecrets.oidcClientId : undefined,
          },
        };
      }
    }
  }
  return null;
}

export function clearCredentials(): void {
  for (const p of [getConfigPath(), getSecretsPath()]) {
    if (existsSync(p)) unlinkSync(p);
  }
  const p = getSolidCredentialsPath();
  if (existsSync(p)) unlinkSync(p);
}

// ============================================================================
// Helper functions for type-safe access
// ============================================================================

export function isClientCredentials(secrets: StoredSecrets): secrets is ClientCredentialsSecrets {
  return 'clientId' in secrets && 'clientSecret' in secrets;
}

export function isOidcOAuth(secrets: StoredSecrets): secrets is OidcOAuthSecrets {
  return 'oidcRefreshToken' in secrets;
}

/**
 * Get client credentials from stored credentials.
 * Returns null if using OAuth instead of client credentials.
 */
export function getClientCredentials(creds: StoredCredentials): ClientCredentialsSecrets | null {
  if (isClientCredentials(creds.secrets)) {
    return creds.secrets;
  }
  return null;
}

/**
 * Get OAuth credentials from stored credentials.
 * Returns null if using client credentials instead of OAuth.
 */
export function getOAuthCredentials(creds: StoredCredentials): OidcOAuthSecrets | null {
  if (isOidcOAuth(creds.secrets)) {
    return creds.secrets;
  }
  return null;
}
