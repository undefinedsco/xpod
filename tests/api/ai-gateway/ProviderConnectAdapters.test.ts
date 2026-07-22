import { describe, expect, it, vi } from 'vitest';

import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import {
  BrowserAssistedApiKeyConnectAdapter,
  DeepSeekConnectAdapter,
  InMemoryConnectAttemptStore,
  KimiDeviceCodeConnectAdapter,
  PodConnectedCredentialRepository,
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

  public async getActiveCredential(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = this.rows.findLast((row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment
      && row.status === 'active'
      && row.reauthRequired !== true);
    return latest ? structuredClone(latest) : undefined;
  }

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
    expect(registry.requireProvider('kimi').connect).toMatchObject({
      configured: false,
      experimental: true,
      publicCallbackSupported: false,
    });
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

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'completed',
      provider: 'openai',
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

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'expired',
      provider: 'anthropic',
    });

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
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
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
      if (url.endsWith('/api/oauth/revoke')) {
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
    })).resolves.toMatchObject({ status: 'slow_down', intervalSeconds: 6 });
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({ status: 'completed' });

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).resolves.toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      deviceCode: 'kimi-device-code',
    });

    const callsAfterCompletion = calls.length;
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      attemptId: begun.attemptId,
      state: begun.state,
      signature: begun.signature,
    })).rejects.toThrow(/already consumed/i);
    expect(calls).toHaveLength(callsAfterCompletion);

    expect(repository.rows.at(-1)).toMatchObject({
      provider: 'kimi',
      authMode: 'deviceCodeOAuth',
      status: 'active',
    });
    expect(JSON.stringify(repository.rows.at(-1))).not.toContain('kimi-access-token');
    expect(calls.every((call) => call.url.startsWith('https://auth.kimi.com/api/oauth/'))).toBe(true);

    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        connect: { kimi: { configured: true } },
      }),
      adapters: [adapter],
      credentialRepository: repository,
      vault: vault(),
    });
    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    })).resolves.toMatchObject({ status: 'active' });
    await adapter.revoke({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi', refreshToken: 'kimi-refresh-next' });
    expect(calls.some((call) => call.url === 'https://auth.kimi.com/api/oauth/revoke')).toBe(true);
  });

  it('fails Kimi 2xx device responses that are empty, HTML, or missing required fields', async () => {
    const base = {
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud' as const,
      clientId: 'xpod-kimi-device-client',
      signingSecret: 'connect-signing-secret',
    };
    for (const response of [
      new Response('', { status: 200 }),
      new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      Response.json({ device_code: 'device-only' }, { status: 200 }),
    ]) {
      const adapter = new KimiDeviceCodeConnectAdapter({
        ...base,
        fetch: (async () => response.clone()) as typeof fetch,
      });
      await expect(adapter.begin({
        webId: WEB_ID,
        deployment: 'cloud',
        provider: 'kimi',
        requestedMode: 'deviceCodeOAuth',
      })).rejects.toThrow(/json|required field/i);
    }
  });
});

describe('ProviderConnectService', () => {
  it('reports disabled Connect capability instead of pretending Kimi device OAuth is configured', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
    });

    await expect(service.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    })).resolves.toMatchObject({
      status: 'unsupported',
      mode: 'deviceCodeOAuth',
      apiKeyManagementSupported: true,
    });
  });

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

  it('refreshes by opening the sealed Pod credential and never accepting a plaintext refresh token in the API input', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const credentialIri = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi';
    const encryptedSecret = await sharedVault.seal(
      { webId: WEB_ID },
      credentialIri,
      'kimi',
      { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
    );
    await repository.upsertConnectedCredential({
      id: 'settings/ai/credentials/kimi.ttl#cloud-kimi',
      credentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new KimiDeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 3600,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      clientId: 'xpod-kimi-device-client',
      signingSecret: 'connect-signing-secret',
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ connect: { kimi: { configured: true } } }),
      adapters: [adapter],
      credentialRepository: repository,
      vault: sharedVault,
    });

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      // If this property accidentally becomes part of the public API again,
      // TypeScript will flag this test object.
    })).resolves.toMatchObject({ status: 'active' });

    expect(bodies.at(-1)?.get('refresh_token')).toBe('sealed-refresh-token');
    expect(JSON.stringify(repository.rows.at(-1))).not.toContain('sealed-refresh-token');
  });

  it('uses the production Pod credential repository adapter against models credentialResource fields', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const repository = new PodConnectedCredentialRepository({
      internalPodAccess: { getTrustedFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: () => ({
          values: (value: any) => ({
            execute: async () => {
              rows.set(value.id, jsonClone(value));
              return [jsonClone(value)];
            },
          }),
        }),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()] }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return jsonClone(row);
        },
      } as any),
    });
    const sharedVault = vault();
    const attempts = new InMemoryConnectAttemptStore();
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'openai',
      consoleUrl: 'https://platform.openai.com/api-keys',
      attempts,
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      signingSecret: 'connect-signing-secret',
      randomBytes: () => Buffer.alloc(32, 13),
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      requestedMode: 'browserAssistedApiKey',
    });

    await adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      attemptId: begun.attemptId!,
      state: begun.state!,
      signature: begun.signature!,
      apiKey: 'sk-pod-backed-secret',
    });

    const stored = [...rows.values()][0];
    expect(stored).toMatchObject({
      id: 'settings/ai/credentials/openai.ttl#cloud-openai',
      provider: 'openai',
      authMode: 'apiKey',
      status: 'active',
      encryptionAlgorithm: 'AES-256-GCM',
      wrappedDataKey: expect.any(String),
      keyVersion: '1',
    });
    expect(JSON.stringify(stored)).not.toContain('sk-pod-backed-secret');
    const active = await repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    });
    expect(active).toMatchObject({ provider: 'openai', version: 1 });
    await expect(repository.disconnect({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    })).resolves.toMatchObject({ status: 'revoked', version: 2 });
  });
});

function jsonClone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
