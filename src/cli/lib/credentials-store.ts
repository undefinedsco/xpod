/**
 * Shared credential storage for all Solid tools (xpod, LinX, etc.).
 *
 * Single Solid auth source: $SOLID_HOME/auth/credentials.json (default: ~/.solid/auth/credentials.json)
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

export function getSolidHomeDir(): string {
  const override = process.env.SOLID_HOME?.trim();
  return override ? override : join(homedir(), '.solid');
}

export function getSolidAuthDir(): string {
  return join(getSolidHomeDir(), 'auth');
}

export function getSolidCredentialsPath(): string {
  return join(getSolidAuthDir(), 'credentials.json');
}

export function saveCredentials(creds: StoredCredentials): void {
  const dir = getSolidAuthDir();
  mkdirSync(dir, { recursive: true });

  const filePath = getSolidCredentialsPath();
  writeFileSync(filePath, `${JSON.stringify(creds, null, 2)}\n`, 'utf-8');
  chmodSync(filePath, 0o600);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * Load credentials from the shared Solid auth store.
 *
 * This is the only credential source for Solid apps (LinX, xpod, etc.).
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
  if (!data || typeof data.url !== 'string' || typeof data.webId !== 'string') {
    return null;
  }

  const authType = data.authType === 'oidc_oauth' ? 'oidc_oauth' : 'client_credentials';
  const rawSecrets = data.secrets;
  if (!rawSecrets || typeof rawSecrets !== 'object') {
    return null;
  }

  const secrets = rawSecrets as Record<string, unknown>;
  if (typeof secrets.clientId === 'string' && typeof secrets.clientSecret === 'string') {
    return {
      url: data.url,
      webId: data.webId,
      authType,
      secrets: {
        clientId: secrets.clientId,
        clientSecret: secrets.clientSecret,
      },
    };
  }

  if (
    typeof secrets.oidcRefreshToken === 'string' &&
    typeof secrets.oidcAccessToken === 'string' &&
    typeof secrets.oidcExpiresAt === 'string'
  ) {
    return {
      url: data.url,
      webId: data.webId,
      authType,
      secrets: {
        oidcRefreshToken: secrets.oidcRefreshToken,
        oidcAccessToken: secrets.oidcAccessToken,
        oidcExpiresAt: secrets.oidcExpiresAt,
        oidcClientId: typeof secrets.oidcClientId === 'string' ? secrets.oidcClientId : undefined,
      },
    };
  }

  return null;
}

export function clearCredentials(): void {
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
