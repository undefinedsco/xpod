import path from 'node:path';
import type { LocalSessionImportResult } from './FileSessionImportAdapter';

export interface SessionImportProfile {
  id: string;
  provider: string;
  offeringId: string;
  resolvePath(homeDir: string): string;
  importSession(payload: Record<string, unknown>): LocalSessionImportResult;
}

export const OPENAI_CODEX_SESSION_IMPORT_PROFILE: SessionImportProfile = {
  id: 'openai-codex-auth-json',
  provider: 'openai',
  offeringId: 'official-subscription',
  resolvePath: (homeDir) => path.join(homeDir, '.codex', 'auth.json'),
  importSession: importOpenAiCodexSession,
};

export const KIMI_CODE_SESSION_IMPORT_PROFILE: SessionImportProfile = {
  id: 'kimi-code-credentials-json',
  provider: 'kimi',
  offeringId: 'subscription-key',
  resolvePath: (homeDir) => path.join(homeDir, '.kimi', 'credentials', 'kimi-code.json'),
  importSession: importKimiCodeSession,
};

function importOpenAiCodexSession(payload: Record<string, unknown>): LocalSessionImportResult {
  const tokens = objectValue(payload.tokens);
  const accessToken = stringValue(tokens?.access_token);
  const refreshToken = stringValue(tokens?.refresh_token);
  const idToken = stringValue(tokens?.id_token);
  const accountId = stringValue(tokens?.account_id);
  const authMode = stringValue(payload.auth_mode);
  if (!accessToken || !refreshToken) {
    throw new Error('local_session_missing_tokens');
  }
  return {
    secret: withoutUndefined({
      type: 'deviceCodeOAuth',
      authMode,
      accessToken,
      refreshToken,
      idToken,
      accountId,
    }),
    credentialAuthMode: 'deviceCodeOAuth',
    accountLabel: accountId ? `OpenAI Subscription ${accountId}` : 'OpenAI Subscription',
    metadata: withoutUndefined({
      source: 'local-codex-auth-json',
      sessionPath: '~/.codex/auth.json',
      authMode,
      accountId,
    }),
  };
}

function importKimiCodeSession(payload: Record<string, unknown>): LocalSessionImportResult {
  const accessToken = stringValue(payload.access_token);
  const refreshToken = stringValue(payload.refresh_token);
  const expiresAt = unixSecondsIsoValue(payload.expires_at);
  const scope = stringValue(payload.scope);
  const tokenType = stringValue(payload.token_type);
  const expiresIn = numberValue(payload.expires_in);
  if (!accessToken || !refreshToken) {
    throw new Error('local_session_missing_tokens');
  }
  return {
    secret: withoutUndefined({
      type: 'deviceCodeOAuth',
      accessToken,
      refreshToken,
      expiresAt,
      scope,
      tokenType,
      expiresIn,
    }),
    credentialAuthMode: 'deviceCodeOAuth',
    accountLabel: 'Kimi Subscription',
    metadata: {
      source: 'local-kimi-code-credentials-json',
      sessionPath: '~/.kimi/credentials/kimi-code.json',
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function unixSecondsIsoValue(value: unknown): string | undefined {
  const seconds = numberValue(value);
  if (seconds === undefined || seconds <= 0) {
    return undefined;
  }
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
