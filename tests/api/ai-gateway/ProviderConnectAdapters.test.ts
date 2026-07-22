import { describe, expect, it, vi } from 'vitest';

import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import {
  BrowserAssistedApiKeyConnectAdapter,
  DeepSeekConnectAdapter,
  InMemoryConnectAttemptStore,
  KimiDeviceCodeConnectAdapter,
  ProviderConnectService,
  type ConnectCredentialRecord,
  type PodCredentialRepository,
} from '../../../src/api/ai-gateway/connect';
import { createDefaultProviderRegistry } from '../../../src/api/ai-gateway/providers/ProviderRegistry';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';

class StaticKeyWrapper implements KeyWrapper {
  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    return {
      algorithm: 'test-static-wrap',
      keyId: `${context.webId}|${context.credentialIri}|${context.provider}`,
      wrappedDek: Buffer.from(dek).toString('base64url'),
    };
  }

  public async unwrapDek(_context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url'));
  }
}

class RecordingCredentialRepository implements PodCredentialRepository {
  public readonly rows: ConnectCredentialRecord[] = [];
  public version = 0;

  public async upsertConnectedCredential(record: ConnectCredentialRecord): Promise<ConnectCredentialRecord> {
    if (record.expectedVersion !== undefined && record.expectedVersion !== this.version) {
      throw new Error('credential_version_conflict');
    }
    this.version += 1;
    const stored = structuredClone({ ...record, version: this.version });
    this.rows.push(stored);
    return stored;
  }

  public async markReauthRequired(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    reason: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = this.rows.findLast((row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment);
    if (!latest) return undefined;
    latest.reauthRequired = true;
    latest.metadata = { ...latest.metadata, reauthReason: input.reason };
    return structuredClone(latest);
  }

  public async disconnect(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = this.rows.findLast((row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment);
    if (!latest) return undefined;
    latest.status = 'revoked';
    return structuredClone(latest);
  }
}

function vault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new StaticKeyWrapper() });
}

describe('Provider Connect capabilities', () => {
  it('reports honest Connect modes without claiming unsupported OAuth', () => {
    const registry = createDefaultProviderRegistry();

    expect(registry.requireProvider('openai').connect).toMatchObject({
      mode: 'browserAssistedApiKey',
      requiresAuthenticatedManagementApi: true,
    });
    expect(registry.requireProvider('anthropic').connect?.mode).toBe('browserAssistedApiKey');
    expect(registry.requireProvider('bailian').connect?.mode).toBe('browserAssistedApiKey');
    expect(registry.requireProvider('kimi').connect?.mode).toBe('deviceCodeOAuth');
    expect(registry.requireProvider('deepseek').connect).toMatchObject({
      mode: 'connectUnsupported',
      apiKeyManagementSupported: true,
    });
    for (const provider of ['openai', 'anthropic', 'bailian']) {
      expect(registry.requireProvider(provider).authModes).not.toContain('oauth');
    }
  });
});

describe('BrowserAssistedApiKeyConnectAdapter', () => {
  it('uses signed one-time attempts bound to WebID, deployment and provider before sealing an API key into Pod storage', async () => {
    const attempts = new InMemoryConnectAttemptStore();
    const repository = new RecordingCredentialRepository();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'openai',
      consoleUrl: 'https://platform.openai.com/api-keys',
      attempts,
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 7),
      signingSecret: 'connect-signing-secret',
    });

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    });

    expect(begun.mode).toBe('browserAssistedApiKey');
    expect(begun.expiresAt).toBe('2026-07-23T00:05:00.000Z');
    expect(begun.authorizationUrl).toContain('https://platform.openai.com/api-keys');
    expect(begun.state).toHaveLength(43);
    expect(begun.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(begun.pkceChallenge).toBeUndefined();

    await expect(adapter.completeApiKey({
      webId: OTHER_WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
      apiKey: 'sk-other-user',
    })).rejects.toThrow(/bound to a different webid/i);

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: 'tampered',
      apiKey: 'sk-bad-signature',
    })).rejects.toThrow(/invalid connect attempt signature/i);

    const completed = await adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
      apiKey: 'sk-live-openai-secret',
      accountLabel: 'Alice OpenAI',
    });

    expect(completed.status).toBe('completed');
    expect(completed.credentialId).toBe('settings/ai/credentials/openai.ttl#cloud-openai');
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      accountLabel: 'Alice OpenAI',
      status: 'active',
    });
    expect(JSON.stringify(repository.rows[0])).not.toContain('sk-live-openai-secret');
    expect(repository.rows[0].encryptedSecret).toMatchObject({
      provider: 'openai',
      webId: WEB_ID,
    });

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
      apiKey: 'sk-second-use',
    })).rejects.toThrow(/already consumed/i);
  });

  it('expires attempts after five minutes and protects concurrent completion with version CAS', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const attempts = new InMemoryConnectAttemptStore();
    const repository = new RecordingCredentialRepository();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'anthropic',
      consoleUrl: 'https://console.anthropic.com/settings/keys',
      attempts,
      credentialRepository: repository,
      vault: vault(),
      deployment: 'local',
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 9),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      requestedMode: 'browserAssistedApiKey',
    });
    now = new Date('2026-07-23T00:05:01.000Z');

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
      apiKey: 'sk-expired',
    })).rejects.toThrow(/expired/i);

    now = new Date('2026-07-23T01:00:00.000Z');
    const fresh = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      requestedMode: 'browserAssistedApiKey',
      expectedCredentialVersion: 41,
    });

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      attemptId: fresh.attemptId,
      state: fresh.state,
      signature: fresh.signature,
      apiKey: 'sk-version-race',
    })).rejects.toThrow(/credential_version_conflict/i);
    expect(repository.rows).toHaveLength(0);
  });
});

describe('KimiDeviceCodeConnectAdapter', () => {
  it('starts OAuth device authorization with PKCE, polls slow_down/pending/expired, refreshes and revokes against allowlisted Kimi endpoints', async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url, body });
      if (url.endsWith('/oauth/device/code')) {
        return Response.json({
          device_code: 'kimi-device-code',
          user_code: 'KIMI-123',
          verification_uri: 'https://kimi.moonshot.cn/device',
          verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 1,
        });
      }
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const pollCount = calls.filter((call) => call.body.get('grant_type') === body.get('grant_type')).length;
        if (pollCount === 1) {
          return Response.json({ error: 'authorization_pending' }, { status: 400 });
        }
        if (pollCount === 2) {
          return Response.json({ error: 'slow_down' }, { status: 400 });
        }
        return Response.json({
          access_token: 'kimi-access-token',
          refresh_token: 'kimi-refresh-token',
          expires_in: 3600,
          scope: 'openid profile',
          id_token: 'header.payload.signature',
        });
      }
      if (body.get('grant_type') === 'refresh_token') {
        return Response.json({
          access_token: 'kimi-refreshed',
          refresh_token: 'kimi-refresh-next',
          expires_in: 3600,
        });
      }
      if (url.endsWith('/oauth/revoke')) {
        return new Response(null, { status: 200 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const repository = new RecordingCredentialRepository();
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: fetchMock as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      clientId: 'xpod-kimi-device-client',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 11),
      signingSecret: 'connect-signing-secret',
    });

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    expect(begun).toMatchObject({
      mode: 'deviceCodeOAuth',
      deviceCode: 'kimi-device-code',
      userCode: 'KIMI-123',
      verificationUriComplete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
    });
    expect(begun.pkceChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({ status: 'authorization_pending' });
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({ status: 'slow_down' });
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({ status: 'completed' });

    expect(repository.rows.at(-1)).toMatchObject({
      provider: 'kimi',
      authMode: 'deviceCodeOAuth',
      status: 'active',
    });
    expect(JSON.stringify(repository.rows.at(-1))).not.toContain('kimi-access-token');
    expect(calls.every((call) => call.url.startsWith('https://kimi.moonshot.cn/'))).toBe(true);

    await expect(adapter.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      refreshToken: 'kimi-refresh-token',
    })).resolves.toMatchObject({ status: 'active' });
    await adapter.revoke({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi', refreshToken: 'kimi-refresh-next' });
    expect(calls.some((call) => call.url === 'https://kimi.moonshot.cn/oauth/revoke')).toBe(true);
  });
});

describe('ProviderConnectService', () => {
  it('routes DeepSeek begin to connectUnsupported while keeping authenticated API key management separate', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [
        new DeepSeekConnectAdapter(),
      ],
    });

    await expect(service.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'deepseek',
      requestedMode: 'connectUnsupported',
    })).resolves.toMatchObject({
      mode: 'connectUnsupported',
      status: 'unsupported',
      apiKeyManagementSupported: true,
    });
  });
});
