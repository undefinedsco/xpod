import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderSecret } from '../credentials/CredentialVault';

export interface OpenAiSubscriptionSessionImportAdapterOptions {
  homeDir?: string;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
}

export interface LocalSessionImportResult {
  secret: ProviderSecret;
  /**
   * How the imported credential authenticates upstream. The import itself is
   * local, but an imported subscription session is still an OAuth credential.
   */
  credentialAuthMode?: 'deviceCodeOAuth' | 'local';
  accountLabel?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalSessionImportInput {
  deployment: 'local' | 'cloud';
}

export interface LocalSessionImportAdapter {
  provider: string;
  offeringId: string;
  importSession(input: LocalSessionImportInput): Promise<LocalSessionImportResult>;
}

export class OpenAiSubscriptionSessionImportAdapter implements LocalSessionImportAdapter {
  public readonly provider = 'openai';
  public readonly offeringId = 'official-subscription';
  private readonly authPath: string;
  private readonly readFile: (filePath: string, encoding: BufferEncoding) => Promise<string>;

  public constructor(options: OpenAiSubscriptionSessionImportAdapterOptions = {}) {
    this.authPath = path.join(options.homeDir ?? os.homedir(), '.codex', 'auth.json');
    this.readFile = options.readFile ?? fs.readFile;
  }

  public async importSession(input: LocalSessionImportInput): Promise<LocalSessionImportResult> {
    if (input.deployment !== 'local') {
      throw new Error('openai_subscription_session_unavailable_in_cloud');
    }
    const payload = parseAuthJson(await this.readFile(this.authPath, 'utf8'));
    const tokens = objectValue(payload.tokens);
    const accessToken = stringValue(tokens?.access_token);
    const refreshToken = stringValue(tokens?.refresh_token);
    const idToken = stringValue(tokens?.id_token);
    const accountId = stringValue(tokens?.account_id);
    if (!accessToken || !refreshToken) {
      throw new Error('openai_subscription_session_missing_tokens');
    }
    return {
      secret: {
        type: 'deviceCodeOAuth',
        authMode: stringValue(payload.auth_mode),
        accessToken,
        refreshToken,
        ...(idToken ? { idToken } : {}),
        ...(accountId ? { accountId } : {}),
      },
      credentialAuthMode: 'deviceCodeOAuth',
      accountLabel: accountId ? `OpenAI Subscription ${accountId}` : 'OpenAI Subscription',
      metadata: {
        source: 'local-codex-auth-json',
        sessionPath: '~/.codex/auth.json',
        ...(stringValue(payload.auth_mode) ? { authMode: stringValue(payload.auth_mode) } : {}),
        ...(accountId ? { accountId } : {}),
      },
    };
  }
}

function parseAuthJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('openai_subscription_session_invalid_auth_json');
  }
  return parsed as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
