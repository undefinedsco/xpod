/**
 * CLI credential storage split into two files:
 *
 *   ~/.xpod/config.json   — base config (url, webId), chmod 644
 *   ~/.xpod/secrets.json  — secrets (clientId, clientSecret), chmod 600
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface StoredConfig {
  url: string;
  webId: string;
}

export interface StoredSecrets {
  clientId: string;
  clientSecret: string;
}

export interface StoredCredentials extends StoredConfig, StoredSecrets {}

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
  writeFileSync(configPath, JSON.stringify({ url: creds.url, webId: creds.webId }, null, 2) + '\n', 'utf-8');
  chmodSync(configPath, 0o644);

  const secretsPath = getSecretsPath();
  writeFileSync(secretsPath, JSON.stringify({ clientId: creds.clientId, clientSecret: creds.clientSecret }, null, 2) + '\n', 'utf-8');
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
    return { url: data.url, webId: data.webId };
  }
  return null;
}

export function loadSecrets(): StoredSecrets | null {
  const data = readJson<Record<string, unknown>>(getSecretsPath());
  if (data && typeof data.clientId === 'string' && typeof data.clientSecret === 'string') {
    return { clientId: data.clientId, clientSecret: data.clientSecret };
  }
  return null;
}

export function loadCredentials(): StoredCredentials | null {
  const config = loadConfig();
  const secrets = loadSecrets();
  if (!config || !secrets) return null;
  return { ...config, ...secrets };
}

export function clearCredentials(): void {
  for (const p of [getConfigPath(), getSecretsPath()]) {
    if (existsSync(p)) unlinkSync(p);
  }
}
