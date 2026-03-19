/**
 * CLI credential storage split into two files:
 *
 *   ~/.xpod/config.json   — base config (url, webId), chmod 644
 *   ~/.xpod/secrets.json  — secrets (clientId, clientSecret), chmod 600
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

export function saveCredentials(creds: StoredCredentials): void {
  const dir = xpodDir();
  mkdirSync(dir, { recursive: true });

  const configPath = getConfigPath();
  writeFileSync(
    configPath,
    JSON.stringify({ url: creds.url, webId: creds.webId, authType: creds.authType }, null, 2) + '\n',
    'utf-8'
  );
  chmodSync(configPath, 0o644);

  const secretsPath = getSecretsPath();
  writeFileSync(secretsPath, JSON.stringify(creds.secrets, null, 2) + '\n', 'utf-8');
  chmodSync(secretsPath, 0o600);
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
    };
  }

  return null;
}

export function loadCredentials(): StoredCredentials | null {
  const config = loadConfig();
  const secrets = loadSecrets();
  if (!config || !secrets) return null;
  return { ...config, secrets };
}

export function clearCredentials(): void {
  for (const p of [getConfigPath(), getSecretsPath()]) {
    if (existsSync(p)) unlinkSync(p);
  }
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
