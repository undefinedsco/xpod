import { describe, expect, it } from 'vitest';

import { FileSessionImportAdapter } from '../../../src/api/ai-gateway/connect/FileSessionImportAdapter';
import {
  KIMI_CODE_SESSION_IMPORT_PROFILE,
  OPENAI_CODEX_SESSION_IMPORT_PROFILE,
} from '../../../src/api/ai-gateway/connect/SessionImportProfiles';

const HOME = '/home/alice';

describe('FileSessionImportAdapter', () => {
  it('imports OpenAI Codex auth.json with the generic file reader', async () => {
    const reads: string[] = [];
    const adapter = new FileSessionImportAdapter({
      profile: OPENAI_CODEX_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      readFile: async (filePath) => {
        reads.push(filePath);
        return JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'openai-access',
            refresh_token: 'openai-refresh',
            id_token: 'openai-id-token',
            account_id: 'acct_123',
          },
        });
      },
    });

    await expect(adapter.importSession({ deployment: 'local' })).resolves.toEqual({
      secret: {
        type: 'deviceCodeOAuth',
        authMode: 'chatgpt',
        accessToken: 'openai-access',
        refreshToken: 'openai-refresh',
        idToken: 'openai-id-token',
        accountId: 'acct_123',
      },
      credentialAuthMode: 'deviceCodeOAuth',
      accountLabel: 'OpenAI Subscription acct_123',
      metadata: {
        source: 'local-codex-auth-json',
        sessionPath: '~/.codex/auth.json',
        authMode: 'chatgpt',
        accountId: 'acct_123',
      },
    });
    expect(reads).toEqual(['/home/alice/.codex/auth.json']);
  });

  it('imports Kimi Code credentials with the same file reader mechanism', async () => {
    const reads: string[] = [];
    const adapter = new FileSessionImportAdapter({
      profile: KIMI_CODE_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      readFile: async (filePath) => {
        reads.push(filePath);
        return JSON.stringify({
          access_token: 'kimi-access',
          refresh_token: 'kimi-refresh',
          expires_at: 1_786_000_000,
          scope: 'openid profile',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      },
    });

    await expect(adapter.importSession({ deployment: 'local' })).resolves.toEqual({
      secret: {
        type: 'deviceCodeOAuth',
        accessToken: 'kimi-access',
        refreshToken: 'kimi-refresh',
        expiresAt: '2026-08-06T07:06:40.000Z',
        scope: 'openid profile',
        tokenType: 'Bearer',
        expiresIn: 3600,
      },
      credentialAuthMode: 'deviceCodeOAuth',
      accountLabel: 'Kimi Subscription',
      metadata: {
        source: 'local-kimi-code-credentials-json',
        sessionPath: '~/.kimi/credentials/kimi-code.json',
      },
    });
    expect(reads).toEqual(['/home/alice/.kimi/credentials/kimi-code.json']);
  });


  it('keeps the OpenAI compatibility wrapper on the Codex profile', async () => {
    const { OpenAiSubscriptionSessionImportAdapter } = await import('../../../src/api/ai-gateway/connect/OpenAiSubscriptionSessionImportAdapter');
    const adapter = new OpenAiSubscriptionSessionImportAdapter({
      homeDir: HOME,
      readFile: async () => JSON.stringify({
        tokens: {
          access_token: 'openai-access',
          refresh_token: 'openai-refresh',
        },
      }),
    });

    expect(adapter.provider).toBe('openai');
    expect(adapter.offeringId).toBe('official-subscription');
    await expect(adapter.importSession({ deployment: 'local' })).resolves.toMatchObject({
      credentialAuthMode: 'deviceCodeOAuth',
      accountLabel: 'OpenAI Subscription',
      metadata: {
        source: 'local-codex-auth-json',
        sessionPath: '~/.codex/auth.json',
      },
    });
  });

  it('rejects cloud deployment before reading local files', async () => {
    const adapter = new FileSessionImportAdapter({
      profile: KIMI_CODE_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      readFile: async () => {
        throw new Error('should_not_read');
      },
    });

    await expect(adapter.importSession({ deployment: 'cloud' })).rejects.toThrow('local_session_import_unavailable_in_cloud');
  });

  it('uses generic non-secret errors for missing files, invalid JSON, oversized files, and missing tokens', async () => {
    const missing = new FileSessionImportAdapter({
      profile: OPENAI_CODEX_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      readFile: async () => {
        const error = new Error('ENOENT /home/alice/.codex/auth.json') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    await expect(missing.importSession({ deployment: 'local' })).rejects.toThrow('local_session_file_missing');

    const invalidJson = new FileSessionImportAdapter({
      profile: OPENAI_CODEX_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      readFile: async () => 'not json',
    });
    await expect(invalidJson.importSession({ deployment: 'local' })).rejects.toThrow('local_session_file_invalid_json');

    const huge = new FileSessionImportAdapter({
      profile: OPENAI_CODEX_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      maxBytes: 8,
      readFile: async () => JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }),
    });
    await expect(huge.importSession({ deployment: 'local' })).rejects.toThrow('local_session_file_too_large');

    const missingTokens = new FileSessionImportAdapter({
      profile: KIMI_CODE_SESSION_IMPORT_PROFILE,
      homeDir: HOME,
      readFile: async () => JSON.stringify({ access_token: 'kimi-access' }),
    });
    await expect(missingTokens.importSession({ deployment: 'local' })).rejects.toThrow('local_session_missing_tokens');
  });
});
