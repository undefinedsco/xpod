import { describe, expect, it, vi } from 'vitest';

import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import type { ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import { aiRuntimeRepository } from '@undefineds.co/models';
import { PROVIDER_LABELS, PROVIDER_OFFERINGS } from '@undefineds.co/ai-connections/provider-catalog';
import {
  BrowserAssistedApiKeyConnectAdapter,
  DeepSeekConnectAdapter,
  InMemoryConnectAttemptStore,
  DeviceCodeConnectAdapter,
  OAuthIntegrationRegistry,
  OpenAiSubscriptionSessionImportAdapter,
  PodConnectedCredentialRepository,
  ProviderConnectService,
  type ConnectBeginResult,
  type ConnectCredentialRecord,
  type DeviceCodeProtocolDescriptor,
  type PodCredentialRepository,
  type ProviderConnectServiceOptions,
} from '../../../src/api/ai-gateway/connect';
import {
  createDefaultProviderRegistry,
  providerProductsForDeployment,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { CodexSubscriptionQuotaAdapter } from '../../../src/api/ai-gateway/quota';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import { OwnerPodAccess } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';
import {
  AiGatewayService,
  type GatewayCredentialStore,
  type StoredGatewayCredential,
} from '../../../src/api/ai-gateway/AiGatewayService';
import { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import { InMemorySessionAffinityStore } from '../../../src/api/ai-gateway/routing/InMemorySessionAffinityStore';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import { createTestSolidSessions } from '../../helpers/solidSessions';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';
const INTERNAL_INVOCATION_AUTH = {
  type: 'solid' as const,
  webId: WEB_ID,
  internalInvocation: true,
  tokenType: 'Bearer' as const,
};

function withInternalAuth<const T extends Record<string, unknown>>(input: T): T & { auth: typeof INTERNAL_INVOCATION_AUTH } {
  return {
    ...input,
    auth: INTERNAL_INVOCATION_AUTH,
  };
}

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
    const latest = latestMatchingRow(this.rows, (row) =>
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
    credentialId?: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = latestMatchingRow(this.rows, (row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment
      && (input.credentialId === undefined || row.id === input.credentialId));
    if (!latest) return undefined;
    latest.reauthRequired = true;
    latest.metadata = { ...latest.metadata, reauthReason: input.reason };
    return structuredClone(latest);
  }

  public async disconnect(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId?: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const latest = latestMatchingRow(this.rows, (row) =>
      row.webId === input.webId
      && row.provider === input.provider
      && row.deployment === input.deployment
      && (input.credentialId === undefined || row.id === input.credentialId));
    if (!latest) return undefined;
    latest.status = 'revoked';
    return structuredClone(latest);
  }

  public async listProviderCredentials(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
  }): Promise<ConnectCredentialRecord[]> {
    return this.rows
      .filter((row) =>
        row.webId === input.webId
        && row.provider === input.provider
        && row.deployment === input.deployment)
      .sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100))
      .map((row) => structuredClone(row));
  }

  public async getCredentialById(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) =>
      candidate.webId === input.webId
      && candidate.provider === input.provider
      && candidate.deployment === input.deployment
      && candidate.id === input.credentialId);
    return row ? structuredClone(row) : undefined;
  }

  public async createCredential(record: Omit<ConnectCredentialRecord, 'id'> & { id?: string }): Promise<ConnectCredentialRecord> {
    this.version += 1;
    const stored = structuredClone({
      ...record,
      id: record.id ?? `credential-${this.version}`,
      version: this.version,
    });
    this.rows.push(stored);
    return stored;
  }

  public async updateCredential(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId: string;
    expectedVersion?: number;
    patch: Partial<ConnectCredentialRecord>;
  }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) =>
      candidate.webId === input.webId
      && candidate.provider === input.provider
      && candidate.deployment === input.deployment
      && candidate.id === input.credentialId);
    if (!row) return undefined;
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
      throw new Error('credential_version_conflict');
    }
    Object.assign(row, input.patch, { version: (row.version ?? 0) + 1 });
    return structuredClone(row);
  }

  public async revokeCredential(input: {
    webId: string;
    provider: string;
    deployment: 'local' | 'cloud';
    credentialId: string;
  }): Promise<ConnectCredentialRecord | undefined> {
    return this.updateCredential({
      ...input,
      patch: { status: 'revoked', enabled: false, health: 'disabled' },
    });
  }
}

function vault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new StaticKeyWrapper() });
}

async function encryptedSecret(
  provider: string,
  credentialIri: string,
  secret: ProviderSecret,
) {
  return vault().seal({ webId: WEB_ID }, credentialIri, provider, secret);
}

// The merged fields are partial; everything else is a whole-field override. `tokenExchange` has no
// default in this fixture, so it is not offered as a partial override.
type PartialDeviceCodeProtocolDescriptor =
  Omit<Partial<DeviceCodeProtocolDescriptor>, 'begin' | 'poll' | 'refresh' | 'tokenExchange'> & {
    begin?: Partial<DeviceCodeProtocolDescriptor['begin']>;
    poll?: Partial<DeviceCodeProtocolDescriptor['poll']>;
    refresh?: Partial<NonNullable<DeviceCodeProtocolDescriptor['refresh']>>;
  };

/** An override replaces a field of the fixture; it never clears one the protocol requires. */
function withDefaults<T extends object>(defaults: T, overrides: Partial<T> | undefined): T {
  return { ...defaults, ...overrides } as T;
}

function kimiDeviceCodeProtocol(overrides: PartialDeviceCodeProtocolDescriptor = {}): DeviceCodeProtocolDescriptor {
  const { begin, poll, refresh, ...rest } = overrides;
  return {
    id: 'oauth-device-code-form-pkce',
    verificationUriOrigins: ['https://kimi.moonshot.cn'],
    begin: withDefaults<DeviceCodeProtocolDescriptor['begin']>({
      endpoint: 'https://auth.kimi.com/api/oauth/device_authorization',
      codec: 'oauthDeviceCodePkce',
    }, begin),
    poll: withDefaults<DeviceCodeProtocolDescriptor['poll']>({
      endpoint: 'https://auth.kimi.com/api/oauth/token',
      codec: 'oauthDeviceCodePkce',
    }, poll),
    refresh: withDefaults<NonNullable<DeviceCodeProtocolDescriptor['refresh']>>({
      endpoint: 'https://auth.kimi.com/api/oauth/token',
      codec: 'refreshTokenForm',
    }, refresh),
    defaultVerificationUri: 'https://kimi.moonshot.cn/device',
    ...rest,
  };
}

function kimiOAuthIntegration(protocol: DeviceCodeProtocolDescriptor = kimiDeviceCodeProtocol()) {
  return OAuthIntegrationRegistry.fromServerConfig({
    integrations: [{
      provider: 'kimi',
      offeringId: 'subscription-key',
      mode: 'deviceCodeOAuth',
      integrationId: 'kimi-code-public',
      issuedBy: 'moonshot',
      clientId: 'xpod-kimi-device-client',
      protocol,
    }],
  }).require('kimi', 'subscription-key');
}

function openAiDeviceCodeProtocol(): DeviceCodeProtocolDescriptor {
  return {
    id: 'openai-device-code-json-authorization-code',
    verificationUriOrigins: ['https://auth.openai.com'],
    begin: {
      endpoint: 'https://auth.openai.com/oauth/device/code',
      codec: 'deviceCodeJson',
      deviceCodeField: 'device_auth_id',
      expiresAtField: 'expires_at',
      defaultExpiresInSeconds: 900,
      defaultIntervalSeconds: 5,
    },
    poll: {
      endpoint: 'https://auth.openai.com/oauth/device/poll',
      codec: 'deviceCodeJson',
      pendingHttpStatuses: [403, 404],
    },
    tokenExchange: {
      endpoint: 'https://auth.openai.com/oauth/token',
      codec: 'authorizationCodeForm',
      redirectUri: 'https://auth.openai.com/deviceauth/callback',
    },
    refresh: {
      endpoint: 'https://auth.openai.com/oauth/token',
      codec: 'refreshTokenForm',
    },
    accountIdClaim: ['https://api.openai.com/auth', 'chatgpt_account_id'],
    defaultVerificationUri: 'https://auth.openai.com/device',
  };
}

function openAiOAuthIntegration() {
  return OAuthIntegrationRegistry.fromServerConfig({
    integrations: [{
      provider: 'openai',
      offeringId: 'official-subscription',
      mode: 'deviceCodeOAuth',
      integrationId: 'openai-codex-public',
      issuedBy: 'openai',
      clientId: 'openai-public-client',
      protocol: openAiDeviceCodeProtocol(),
    }],
  }).require('openai', 'official-subscription');
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    '',
  ].join('.');
}

function latestMatchingRow<T>(rows: T[], predicate: (row: T) => boolean): T | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (predicate(row)) {
      return row;
    }
  }
  return undefined;
}

function requireConnectAttempt(result: ConnectBeginResult): {
  attemptId: string;
  state: string;
  signature: string;
} {
  if (!result.attemptId || !result.state || !result.signature) {
    throw new Error(`Expected signed Connect attempt, got ${JSON.stringify(result)}`);
  }
  return {
    attemptId: result.attemptId,
    state: result.state,
    signature: result.signature,
  };
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
    expect(registry.requireProvider('kimi').connect?.mode).toBe('browserAssistedApiKey');
    expect(registry.requireProvider('kimi').connect).toMatchObject({
      configured: true,
      requiresAuthenticatedManagementApi: true,
      publicCallbackSupported: false,
    });
    expect(registry.requireProvider('deepseek').connect).toMatchObject({
      mode: 'browserAssistedApiKey',
      apiKeyManagementSupported: true,
    });
    for (const provider of ['openai', 'anthropic', 'bailian']) {
      expect(registry.requireProvider(provider).authModes).not.toContain('oauth');
    }
  });
});

describe('Provider credential pool management', () => {
  it('publishes unavailable lifecycle metadata for OAuth offerings without a Connect flow', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
    });

    const pools = await service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
    });

    for (const provider of ['openai', 'anthropic'] as const) {
      const offering = pools
        .find((pool) => pool.id === provider)
        ?.offerings.find((candidate) => candidate.id === 'official-subscription');
      const source = PROVIDER_OFFERINGS[provider]!.find((candidate) => candidate.id === 'official-subscription')!;
      expect(offering).toMatchObject({
        label: source.label,
        lifecycle: 'unavailable',
        authModes: source.authModes,
      });
    }
    expect(pools.find((pool) => pool.id === 'kimi')?.offerings.find(
      (offering) => offering.id === 'official-subscription',
    )).toBeUndefined();
    expect(pools.find((pool) => pool.id === 'kimi')?.offerings.find(
      (offering) => offering.id === 'subscription-key',
    )).toMatchObject({ lifecycle: 'active', authModes: ['apiKey'] });
  });

  it('lists canonical provider summaries with aggregate status and selected models', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      accountLabel: 'Kimi key',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'healthy',
      version: 3,
      metadata: {
        models: ['moonshot-v1-8k'],
        defaultModel: 'moonshot-v1-8k',
        customModels: [{ id: 'moonshot-custom', displayName: 'Custom Moonshot' }],
      },
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'kimi',
        name: PROVIDER_LABELS.kimi,
        status: 'available',
        offerings: expect.arrayContaining([
          expect.objectContaining({ id: 'subscription-key', lifecycle: 'active' }),
          expect.objectContaining({ id: 'api-platform', lifecycle: 'active' }),
        ]),
        selectedModels: [
          expect.objectContaining({ id: 'moonshot-v1-8k', provider: 'kimi' }),
          expect.objectContaining({ id: 'moonshot-custom', provider: 'kimi', custom: true }),
        ],
        credentials: [
          expect.objectContaining({
            id: 'kimi-key-a',
            provider: 'kimi',
            offeringId: 'api-platform',
            authMode: 'apiKey',
            label: 'Kimi key',
            enabled: true,
            priority: 10,
            health: 'healthy',
            version: 3,
          }),
        ],
      }),
    ]));
    const payload = JSON.stringify(await service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
    }));
    expect(payload).not.toMatch(/encryptedSecret|sk-secret|credentialIri|webId/);
  });

  it('joins selected catalog models to their capability evidence', async () => {
    // A credential stores only the model ids a user picked, so the summary used
    // to carry no capabilities at all and the model rows rendered bare. The
    // catalog is the authority for what a selected model can do.
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'deepseek-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/deepseek.ttl#deepseek-key-a',
      webId: WEB_ID,
      provider: 'deepseek',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'deepseek',
        'https://id.example/alice/settings/credentials/deepseek.ttl#deepseek-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      accountLabel: 'DeepSeek key',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'healthy',
      version: 1,
      metadata: { models: ['deepseek-v4.1-flash'] },
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    const pools = await service.listProviderCredentialPools({ webId: WEB_ID, deployment: 'cloud' });
    expect(pools.find((pool) => pool.id === 'deepseek')?.selectedModels).toEqual([
      expect.objectContaining({
        id: 'deepseek-v4.1-flash',
        provider: 'deepseek',
        capabilities: { toolCalls: true, reasoningEffort: true, imageInput: true, fast: true },
      }),
    ]);
  });

  it('keeps a custom model in charge of its own capability tokens', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-b',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-b',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-b',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      accountLabel: 'Kimi key',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'healthy',
      version: 1,
      metadata: { customModels: [{ id: 'moonshot-custom', capabilities: ['reasoning'] }] },
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    const pools = await service.listProviderCredentialPools({ webId: WEB_ID, deployment: 'cloud' });
    expect(pools.find((pool) => pool.id === 'kimi')?.selectedModels).toEqual([
      expect.objectContaining({ id: 'moonshot-custom', custom: true, custom_capabilities: ['reasoning'] }),
    ]);
  });

  it('creates, patches and revokes credentials through explicit pool methods', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    const created = await service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      apiKey: 'sk-new-secret',
      label: 'Work key',
      baseUrl: 'https://api.moonshot.ai/v1',
      priority: 5,
    });
    const storedApiKeyCredential = repository.rows[0];
    expect(storedApiKeyCredential.id).toMatch(/^credentials\.ttl#cloud-kimi-/u);
    expect(storedApiKeyCredential.credentialIri).toBe(
      `https://id.example/alice/settings/${storedApiKeyCredential.id}`,
    );
    expect(storedApiKeyCredential).toMatchObject({
      health: 'unknown',
      metadata: {
        health: 'unknown',
      },
    });
    const patched = await service.updateCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: created.id,
      expectedVersion: created.version,
      patch: {
        label: 'Paused',
        enabled: false,
        priority: 20,
      },
    });
    const revoked = await service.revokeCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: created.id,
    });

    expect(created).toMatchObject({
      provider: 'kimi',
      offeringId: 'api-platform',
      authMode: 'apiKey',
      label: 'Work key',
      enabled: true,
      priority: 5,
      health: 'unknown',
    });
    expect(JSON.stringify(created)).not.toContain('sk-new-secret');
    expect(patched).toMatchObject({
      label: 'Paused',
      enabled: false,
      priority: 20,
      health: 'unknown',
      baseUrl: 'https://api.moonshot.ai/v1',
    });
    expect(revoked).toMatchObject({
      id: created.id,
      enabled: false,
      health: 'unknown',
    });
  });

  it('rejects API-key credentials for offerings that do not support API-key auth', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      adapters: [],
    });

    await expect(service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'official-subscription',
      apiKey: 'sk-new-secret',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: {
        provider: 'kimi',
        offeringId: 'official-subscription',
      },
    });
  });

  it('creates a local Ollama credential without an API key', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });
    const created = await service.createLocalCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'ollama',
      offeringId: 'local',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(created).toMatchObject({ provider: 'ollama', offeringId: 'local', authMode: 'local' });
    expect(repository.rows[0]).toMatchObject({ authMode: 'local' });
    expect(JSON.stringify(repository.rows[0])).not.toContain('apiKey');
  });

  it('imports local OpenAI Subscription tokens from host auth.json without exposing secrets', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        products: providerProductsForDeployment('local'),
      }),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
      localSessionImporters: [
        new OpenAiSubscriptionSessionImportAdapter({
          readFile: async () => JSON.stringify({
            auth_mode: 'chatgpt',
            tokens: {
              access_token: 'openai-access-token',
              refresh_token: 'openai-refresh-token',
              id_token: 'openai-id-token',
              account_id: 'acct_123',
            },
          }),
        }),
      ],
    });

    const created = await service.createLocalCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      priority: 10,
    });
    const opened = await vault().open(
      { webId: WEB_ID },
      repository.rows[0].credentialIri,
      'openai',
      repository.rows[0].encryptedSecret,
    );

    expect(created).toMatchObject({
      provider: 'openai',
      offeringId: 'official-subscription',
      authMode: 'deviceCode',
      label: 'OpenAI Subscription acct_123',
      enabled: true,
      priority: 10,
      health: 'healthy',
    });
    expect(opened).toMatchObject({
      type: 'deviceCodeOAuth',
      authMode: 'chatgpt',
      accessToken: 'openai-access-token',
      refreshToken: 'openai-refresh-token',
      idToken: 'openai-id-token',
      accountId: 'acct_123',
    });
    expect(JSON.stringify(created)).not.toMatch(/openai-access-token|openai-refresh-token|openai-id-token/u);
    const storedSubscriptionCredential = repository.rows[0];
    expect(storedSubscriptionCredential.id).toMatch(/^credentials\.ttl#local-openai-/u);
    expect(storedSubscriptionCredential.credentialIri).toBe(
      `https://id.example/alice/settings/${storedSubscriptionCredential.id}`,
    );
    expect(storedSubscriptionCredential).toMatchObject({
      authMode: 'deviceCodeOAuth',
      offeringId: 'official-subscription',
      credentialIri: expect.stringMatching(
        /^https:\/\/id\.example\/alice\/settings\/credentials\.ttl#local-openai-/u,
      ),
    });

    const quotaFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input.toString()).toBe('https://chatgpt.com/backend-api/wham/usage');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer openai-access-token');
      expect(new Headers(init?.headers).get('chatgpt-account-id')).toBe('acct_123');
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: {
            used_percent: 20,
            reset_at: 1_786_320_000,
            limit_window_seconds: 18_000,
          },
        },
      }));
    }) as typeof fetch;
    const quotaAdapter = new CodexSubscriptionQuotaAdapter({ fetch: quotaFetch });
    expect(quotaAdapter.supports(repository.rows[0])).toBe(true);
    await expect(quotaAdapter.fetch({
      credential: repository.rows[0],
      secret: opened,
      now: new Date('2026-08-09T00:00:00.000Z'),
    })).resolves.toMatchObject({
      status: 'available',
      source: 'openai:chatgpt-wham',
      windows: [{ name: 'five-hour', used: 20, remaining: 80 }],
    });
  });

  it.each(['accountId', 'accountSubject', 'accessToken', 'refreshToken'])(
    'reimports the same subscription by %s while preserving user settings', async (identityField) => {
      const repository = new RecordingCredentialRepository();
      let secret: ProviderSecret = { accessToken: 'first-access', refreshToken: 'first-refresh', [identityField]: 'same-identity' };
      const service = new ProviderConnectService({
        registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
        credentialRepository: repository,
        vault: vault(),
        adapters: [],
        localSessionImporters: [{
          provider: 'kimi', offeringId: 'subscription-key',
          importSession: async () => ({ secret, credentialAuthMode: 'deviceCodeOAuth', accountLabel: 'Kimi Subscription' }),
        }],
      });
      const input = { webId: WEB_ID, deployment: 'local' as const, provider: 'kimi', offeringId: 'subscription-key' };
      const created = await service.createLocalCredential(input);
      Object.assign(repository.rows[0], {
        accountLabel: 'My account', priority: 7, enabled: false, reauthRequired: true,
        selectedModels: [{ id: 'kimi-model', provider: 'kimi', displayName: 'My model' }],
        metadata: { enabled: false, priority: 7, customSetting: 'keep' },
      });
      secret = { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', [identityField]: 'same-identity' };
      const updated = await service.createLocalCredential({ ...input, priority: 99, label: 'Replacement' });
      expect(repository.rows).toHaveLength(1);
      expect(updated).toMatchObject({ id: created.id, label: 'My account', priority: 7, enabled: false });
      expect(repository.rows[0]).toMatchObject({
        reauthRequired: false, health: 'disabled',
        selectedModels: [{ id: 'kimi-model', provider: 'kimi', displayName: 'My model' }],
        metadata: { customSetting: 'keep', enabled: false, priority: 7 },
      });
      expect(await vault().open({ webId: WEB_ID }, repository.rows[0].credentialIri, 'kimi', repository.rows[0].encryptedSecret)).toMatchObject(secret);
    },
  );

  it('serializes concurrent imports across service instances and releases failed imports', async () => {
    const repository = new RecordingCredentialRepository();
    const importSession = vi.fn()
      .mockRejectedValueOnce(new Error('session_unavailable'))
      .mockResolvedValue({ secret: { accessToken: 'same-access', refreshToken: 'same-refresh' }, credentialAuthMode: 'deviceCodeOAuth' });
    const options = {
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: vault(), adapters: [],
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession }],
    };
    const services = [new ProviderConnectService(options), new ProviderConnectService(options)];
    const input = { webId: WEB_ID, deployment: 'local' as const, provider: 'kimi', offeringId: 'subscription-key' };
    await expect(services[0].createLocalCredential(input)).rejects.toThrow('session_unavailable');
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => services[index % 2].createLocalCredential(input)));
    expect(repository.rows).toHaveLength(1);
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
  });

  it.each([false, true])('keeps unproven or conflicting accounts separate (explicit identity: %s)', async (withIdentity) => {
    const repository = new RecordingCredentialRepository();
    let secret: ProviderSecret = { accessToken: 'first-access', refreshToken: 'first-refresh', ...(withIdentity ? { accountId: 'first-account' } : {}) };
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: vault(), adapters: [],
      localSessionImporters: [{
        provider: 'kimi', offeringId: 'subscription-key',
        importSession: async () => ({ secret, accountLabel: 'Kimi Subscription', metadata: { source: 'same-source', sessionPath: 'same-path' } }),
      }],
    });
    const input = { webId: WEB_ID, deployment: 'local' as const, provider: 'kimi', offeringId: 'subscription-key' };
    const first = await service.createLocalCredential(input);
    secret = withIdentity
      ? { accessToken: 'first-access', refreshToken: 'first-refresh', accountId: 'different-account' }
      : { accessToken: 'different-access', refreshToken: 'different-refresh' };
    const second = await service.createLocalCredential(input);
    expect(second.id).not.toBe(first.id);
    expect(repository.rows).toHaveLength(2);
  });

  it('refreshes expired imported tokens once and recognizes the unchanged file after rotation', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: vault(), adapters: [],
      localSessionImporters: [{
        provider: 'kimi', offeringId: 'subscription-key',
        importSession: async () => ({ secret: {
          type: 'deviceCodeOAuth', accessToken: 'expired-access', refreshToken: 'old-refresh',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }, credentialAuthMode: 'deviceCodeOAuth' }),
      }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue({
      mode: 'deviceCodeOAuth', status: 'completed', provider: 'kimi', deployment: 'local',
      oauthCredential: { accessToken: 'valid-access', refreshToken: 'rotated-refresh', expiresAt: '2099-01-01T00:00:00.000Z' },
    });
    const input = { webId: WEB_ID, deployment: 'local' as const, provider: 'kimi', offeringId: 'subscription-key' };
    const first = await service.createLocalCredential(input);
    const second = await service.createLocalCredential(input);
    expect(second.id).toBe(first.id);
    expect(repository.rows).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await vault().open({ webId: WEB_ID }, repository.rows[0].credentialIri, 'kimi', repository.rows[0].encryptedSecret))
      .toMatchObject({ accessToken: 'valid-access', refreshToken: 'rotated-refresh' });
    expect(JSON.stringify(second)).not.toMatch(/expired-access|valid-access|old-refresh|rotated-refresh|importedSessionFingerprint/u);
  });

  it.each([
    ['string invalid grant', 'invalid_grant', 'invalid_grant'],
    ['string invalid token', 'invalid_token', 'invalid_token'],
    ['nested invalid grant', { code: 'invalid_grant', message: 'fixture-private-token' }, 'invalid_grant'],
    ['nested invalid token', { code: 'invalid_token', message: 'fixture-private-token' }, 'invalid_token'],
    ['unknown string', 'fixture-private-token', 'provider_error'],
    ['unknown nested code', { code: 'fixture-private-token', message: 'invalid_grant' }, 'provider_error'],
    ['message without code', { message: 'invalid_token fixture-private-token' }, 'provider_error'],
    ['malformed nested code', { code: { secret: 'fixture-private-token' } }, 'provider_error'],
    ['array error', [{ code: 'invalid_grant' }], 'provider_error'],
    ['absent error', null, 'provider_error'],
  ])('classifies decoded refresh failures without exposing provider secrets (%s)', async (_label, providerError, safeCode) => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const fetchMock = vi.fn(async () => Response.json({
      error: providerError,
      error_description: 'fixture-private-description',
      access_token: 'fixture-private-access',
    }, { status: 400 }));
    const adapter = new DeviceCodeConnectAdapter({
      fetch: fetchMock,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'local',
      integration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    });
    const input = { webId: WEB_ID, deployment: 'local' as const, provider: 'kimi', offeringId: 'subscription-key' };
    await expect(adapter.refreshCallerOwned({
      ...input, credentialId: 'fixture-credential', refreshToken: 'fixture-refresh', expectedVersion: 0,
    })).rejects.toThrow(new Error(`OAuth refresh failed: ${safeCode}`));

    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: sharedVault, adapters: [adapter],
      localSessionImporters: [{
        provider: 'kimi', offeringId: 'subscription-key',
        importSession: async () => ({ secret: {
          accessToken: 'expired-access', refreshToken: 'fixture-refresh', expiresAt: '2020-01-01T00:00:00.000Z',
        } }),
      }],
    });
    await expect(service.createLocalCredential(input)).rejects.toThrow(new Error(
      safeCode === 'provider_error' ? 'local_session_refresh_failed' : 'local_session_reauth_required',
    ));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repository.rows).toHaveLength(0);
  });

  it.each([
    ['refresh_rejected', 'local_session_refresh_failed'],
    ['OAuth refresh failed: invalid_grant', 'local_session_reauth_required'],
    ['OAuth refresh failed: invalid_token', 'local_session_reauth_required'],
  ])('does not persist a healthy credential when refreshing an expired import fails (%s)', async (message, expectedError) => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: vault(), adapters: [],
      localSessionImporters: [{
        provider: 'kimi', offeringId: 'subscription-key',
        importSession: async () => ({ secret: {
          accessToken: 'expired-access', refreshToken: 'old-refresh', expiresAt: '2020-01-01T00:00:00.000Z',
        } }),
      }],
    });
    vi.spyOn(service, 'refreshCallerOwned').mockRejectedValue(new Error(message));
    await expect(service.createLocalCredential({
      webId: WEB_ID, deployment: 'local', provider: 'kimi', offeringId: 'subscription-key',
    })).rejects.toThrow(expectedError);
    expect(repository.rows).toHaveLength(0);
  });

  it.each([
    ['kimi', 'kimi-auth', 'same-user', 'same-subject', 1],
    ['kimi', 'different-issuer', 'same-user', 'same-subject', 2],
    ['kimi', 'kimi-auth', 'different-user', 'same-subject', 2],
    ['kimi', 'kimi-auth', 'same-user', 'different-subject', 2],
    ['openai', 'kimi-auth', 'same-user', 'same-subject', 2],
  ] as const)('compares legacy JWT hints only within Kimi issuer and account (%s, %s, %s, %s)', async (provider, issuer, userId, subject, count) => {
    const repository = new RecordingCredentialRepository();
    const offeringId = provider === 'kimi' ? 'subscription-key' : 'official-subscription';
    const oldToken = unsignedJwt({ iss: 'kimi-auth', user_id: 'same-user', sub: 'same-subject', exp: 100 });
    const credentialIri = 'https://id.example/alice/settings/credentials.ttl#legacy-import';
    await repository.createCredential({
      id: 'credentials.ttl#legacy-import', credentialIri, webId: WEB_ID, provider, deployment: 'local',
      offeringId, authMode: 'deviceCodeOAuth', status: 'active',
      encryptedSecret: await encryptedSecret(provider, credentialIri, { accessToken: oldToken, refreshToken: 'legacy-refresh' }),
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: vault(), adapters: [],
      localSessionImporters: [{ provider, offeringId, importSession: async () => ({
        secret: { accessToken: unsignedJwt({ iss: issuer, user_id: userId, sub: subject, exp: 200 }), refreshToken: 'new-refresh' },
        credentialAuthMode: 'deviceCodeOAuth',
      }) }],
    });
    await service.createLocalCredential({ webId: WEB_ID, deployment: 'local', provider, offeringId });
    expect(repository.rows).toHaveLength(count);
    if (count === 1) {
      expect(repository.rows[0]).toMatchObject({ id: 'credentials.ttl#legacy-import', metadata: {
        accountId: 'kimi-auth:same-user', authoritativeSubject: 'kimi-auth:same-subject',
      } });
    }
  });

  it.each(['newest-valid', 'newest-rejected', 'all-rejected'] as const)(
    'refreshes matching expired legacy Kimi sessions with bounded recovery (%s)', async (scenario) => {
    const repository = new RecordingCredentialRepository();
    const token = (exp: number) => unsignedJwt({ iss: 'kimi-auth', user_id: 'same-user', sub: 'same-subject', exp });
    for (const [id, expiresAt, refreshToken] of [
      ['old-local', '2020-01-01T00:00:00.000Z', 'old-refresh'],
      ['new-oauth', '2021-01-01T00:00:00.000Z', 'new-refresh'],
    ]) {
      const credentialIri = `https://id.example/alice/settings/credentials.ttl#${id}`;
      await repository.createCredential({
        id, credentialIri, webId: WEB_ID, provider: 'kimi', deployment: 'local', offeringId: 'subscription-key',
        authMode: 'deviceCodeOAuth', status: 'active', expiresAt: new Date(expiresAt),
        encryptedSecret: await encryptedSecret('kimi', credentialIri, { accessToken: token(Date.parse(expiresAt) / 1000), expiresAt, refreshToken }),
      });
    }
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository, vault: vault(), adapters: [],
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession: async () => ({
        secret: { accessToken: token(1577836800), expiresAt: '2020-01-01T00:00:00.000Z', refreshToken: 'old-refresh' },
        credentialAuthMode: 'deviceCodeOAuth',
      }) }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue({
      mode: 'deviceCodeOAuth', status: 'completed', provider: 'kimi', deployment: 'local',
      oauthCredential: { accessToken: token(4070908800), refreshToken: 'rotated-refresh', expiresAt: '2099-01-01T00:00:00.000Z' },
    });
    if (scenario === 'newest-rejected') {
      refresh.mockRejectedValueOnce(new Error('OAuth refresh failed: invalid_grant'));
    } else if (scenario === 'all-rejected') {
      refresh.mockRejectedValue(new Error('OAuth refresh failed: invalid_grant'));
    }
    const operation = service.createLocalCredential({
      webId: WEB_ID, deployment: 'local', provider: 'kimi', offeringId: 'subscription-key',
    });
    if (scenario === 'all-rejected') {
      await expect(operation).rejects.toThrow('local_session_reauth_required');
    } else {
      await expect(operation).resolves.toMatchObject({ id: scenario === 'newest-valid' ? 'new-oauth' : 'old-local' });
    }
    expect(refresh.mock.calls[0][0].refreshToken).toBe('new-refresh');
    expect(refresh).toHaveBeenCalledTimes(scenario === 'newest-valid' ? 1 : 2);
    if (scenario !== 'newest-valid') expect(refresh.mock.calls[1][0].refreshToken).toBe('old-refresh');
    expect(repository.rows).toHaveLength(2);
  });

  it('does not create a fake OpenAI Subscription credential without a session importer', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        products: providerProductsForDeployment('local'),
      }),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      adapters: [],
    });

    await expect(service.createLocalCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('persists imported local session expiry and scopes on the credential record', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        products: providerProductsForDeployment('local'),
      }),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
      localSessionImporters: [{
        provider: 'kimi',
        offeringId: 'subscription-key',
        importSession: async () => ({
          secret: {
            type: 'deviceCodeOAuth',
            accessToken: 'kimi-local-access',
            refreshToken: 'kimi-local-refresh',
            expiresAt: '2099-08-09T04:00:00.000Z',
            scope: 'openid profile',
          },
          credentialAuthMode: 'deviceCodeOAuth',
          accountLabel: 'Kimi Subscription',
          metadata: { source: 'local-kimi-code-credentials-json' },
        }),
      }],
    });

    await expect(service.createLocalCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'kimi',
      offeringId: 'subscription-key',
    })).resolves.toMatchObject({
      offeringId: 'subscription-key',
      authMode: 'deviceCode',
      health: 'healthy',
    });
    expect(repository.rows[0]).toMatchObject({
      expiresAt: new Date('2099-08-09T04:00:00.000Z'),
      scopes: ['openid', 'profile'],
    });
  });

  it('keeps OpenAI Subscription unavailable in cloud catalogs and never reads host auth.json', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('should_not_read');
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        products: providerProductsForDeployment('cloud'),
      }),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      adapters: [],
      localSessionImporters: [
        new OpenAiSubscriptionSessionImportAdapter({ readFile }),
      ],
    });

    await expect(service.createLocalCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      offeringId: 'official-subscription',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('tests stored credentials through ProviderModelsService and rejects temporary API keys', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'unknown',
      version: 1,
    });
    const modelsService = {
      list: vi.fn(async () => ({
        provider: 'kimi',
        credential: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        models: [{ id: 'moonshot-v1-8k' }],
        observedAt: '2026-08-08T00:00:00.000Z',
        source: 'kimi:/models',
      })),
    };
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.testCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      modelsService,
    })).resolves.toEqual({
      status: 'ok',
      checkedAt: '2026-08-08T00:00:00.000Z',
      models: [{ id: 'moonshot-v1-8k' }],
    });
    expect(modelsService.list).toHaveBeenCalledWith({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
    });
    expect(repository.rows[0]).toMatchObject({
      health: 'healthy',
      metadata: {
        health: 'healthy',
      },
      version: 2,
    });
    await expect(service.testCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      apiKey: 'sk-temporary',
      modelsService,
    })).rejects.toThrow('credential_test_requires_credential_id');
  });

  it('marks a stored API-key credential invalid when the provider probe fails', async () => {
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: 'kimi-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#kimi-key-a',
        { type: 'apiKey', apiKey: 'sk-secret' },
      ),
      status: 'active',
      offeringId: 'api-platform',
      enabled: true,
      priority: 10,
      health: 'unknown',
      version: 1,
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.testCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'kimi-key-a',
      modelsService: {
        list: vi.fn(async () => {
          throw new Error('provider rejected key');
        }),
      },
    })).rejects.toThrow('provider rejected key');
    expect(repository.rows[0]).toMatchObject({
      health: 'invalid',
      metadata: {
        health: 'invalid',
      },
      version: 2,
    });
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
    const begunAttempt = requireConnectAttempt(begun);

    await expect(adapter.completeApiKey({
      webId: OTHER_WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-other-user',
    })).rejects.toThrow(/bound to a different webid/i);

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      signature: 'tampered',
      apiKey: 'sk-bad-signature',
    })).rejects.toThrow(/invalid connect attempt signature/i);

    const completed = await adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-live-openai-secret',
      accountLabel: 'Alice OpenAI',
      baseUrl: 'https://gateway.example/v1',
    });

    expect(completed.status).toBe('completed');
    expect(completed.credentialId).toBe('credentials.ttl#cloud-openai');
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      accountLabel: 'Alice OpenAI',
      status: 'active',
      metadata: {
        baseUrl: 'https://gateway.example/v1',
      },
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
      ...begunAttempt,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'completed',
      provider: 'openai',
    });

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-second-use',
    })).rejects.toThrow(/already consumed/i);
  });

  it('disconnects the requested API-key credential without revoking its sibling', async () => {
    const repository = new RecordingCredentialRepository();
    const credentialA: ConnectCredentialRecord = {
      id: 'cloud-openai-key-a',
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-a',
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: {
        algorithm: 'PLAINTEXT',
        keyId: 'a',
        wrappedDek: 'wrapped-a',
        aadPurpose: 'test',
        aadVersion: '1',
        ciphertext: 'ciphertext-a',
        nonce: 'nonce-a',
        webId: WEB_ID,
        credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-a',
        provider: 'openai',
        dekWrapAlgorithm: 'test',
      },
      status: 'active',
      version: 1,
    };
    const credentialB: ConnectCredentialRecord = {
      ...credentialA,
      id: 'cloud-openai-key-b',
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-b',
      encryptedSecret: {
        ...credentialA.encryptedSecret,
        keyId: 'b',
        wrappedDek: 'wrapped-b',
        ciphertext: 'ciphertext-b',
        nonce: 'nonce-b',
        credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-key-b',
      },
      version: 2,
    };
    repository.rows.push(credentialA, credentialB);
    const adapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'openai',
      consoleUrl: 'https://platform.openai.com/api-keys',
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      signingSecret: 'connect-signing-secret',
    });

    await expect(adapter.disconnect({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      credentialId: credentialA.id,
    })).resolves.toMatchObject({ id: credentialA.id, status: 'revoked' });
    expect(repository.rows.find((row) => row.id === credentialA.id)).toMatchObject({ status: 'revoked' });
    expect(repository.rows.find((row) => row.id === credentialB.id)).toMatchObject({ status: 'active' });
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
    const begunAttempt = requireConnectAttempt(begun);
    now = new Date('2026-07-23T00:05:01.000Z');

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      ...begunAttempt,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'expired',
      provider: 'anthropic',
    });

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      ...begunAttempt,
      apiKey: 'sk-expired',
    })).rejects.toThrow(/not found/i);

    now = new Date('2026-07-23T01:00:00.000Z');
    const fresh = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      requestedMode: 'browserAssistedApiKey',
      expectedCredentialVersion: 41,
    });
    const freshAttempt = requireConnectAttempt(fresh);

    await expect(adapter.completeApiKey({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'anthropic',
      ...freshAttempt,
      apiKey: 'sk-version-race',
    })).rejects.toThrow(/credential_version_conflict/i);
    expect(repository.rows).toHaveLength(0);
  });
});

describe('DeviceCodeConnectAdapter', () => {
  it('requires an explicit server-side OAuth integration and never falls back to request client ids', async () => {
    expect(() => OAuthIntegrationRegistry.fromServerConfig({})).toThrow('auth_not_available');
    expect(() => OAuthIntegrationRegistry.fromServerConfig({
      integrations: [{
        provider: 'kimi',
        offeringId: 'subscription-key',
        integrationId: 'kimi-code-public',
        issuedBy: 'moonshot',
        clientId: '',
        protocol: kimiDeviceCodeProtocol(),
      }],
    })).toThrow('auth_not_available');

    const registry = OAuthIntegrationRegistry.fromServerConfig({
      integrations: [{
        provider: 'kimi',
        offeringId: 'subscription-key',
        integrationId: 'kimi-code-public',
        issuedBy: 'moonshot',
        clientId: 'xpod-kimi-device-client',
        protocol: kimiDeviceCodeProtocol(),
      }, {
        provider: 'kimi',
        offeringId: 'team-subscription',
        integrationId: 'kimi-team-public',
        issuedBy: 'moonshot',
        clientId: 'xpod-kimi-team-client',
        protocol: kimiDeviceCodeProtocol(),
      }],
    });
    expect(() => registry.require('kimi')).toThrow('auth_not_available');
    const bodies: URLSearchParams[] = [];
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(new URLSearchParams(String(init?.body ?? '')));
        return Response.json({
          device_code: 'kimi-device-code',
          user_code: 'KIMI-123',
          verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 1,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      integration: registry.require('kimi', 'subscription-key'),
      signingSecret: 'connect-signing-secret',
    });

    await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'subscription-key',
      requestedMode: 'deviceCodeOAuth',
      clientId: 'attacker-client-id',
    } as any);

    expect(bodies.at(-1)?.get('client_id')).toBe('xpod-kimi-device-client');
    expect(bodies.at(-1)?.get('client_id')).not.toBe('attacker-client-id');
  });

  it('starts OAuth device authorization with PKCE, polls slow_down/pending/expired, refreshes and revokes against allowlisted Kimi endpoints', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
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
    const adapter = new DeviceCodeConnectAdapter({
      fetch: fetchMock as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      now: () => now,
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
      offeringId: 'subscription-key',
      userCode: 'KIMI-123',
      verificationUriComplete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
    });
    expect(begun.deviceCode).toBeUndefined();
    expect(begun.pkceChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const begunAttempt = requireConnectAttempt(begun);

    now = new Date('2026-07-23T00:00:00.500Z');
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'authorization_pending', intervalSeconds: 1 });
    expect(calls).toHaveLength(1);

    now = new Date('2026-07-23T00:00:01.000Z');
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'authorization_pending' });
    expect(calls).toHaveLength(2);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'authorization_pending', intervalSeconds: 1 });
    expect(calls).toHaveLength(2);

    now = new Date('2026-07-23T00:00:02.000Z');
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({ status: 'slow_down', intervalSeconds: 6 });

    now = new Date('2026-07-23T00:00:08.000Z');
    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      oauthCredential: {
        accessToken: 'kimi-access-token',
        refreshToken: 'kimi-refresh-token',
        expiresAt: '2026-07-23T01:00:08.000Z',
      },
    });

    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).resolves.toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      offeringId: 'subscription-key',
    });

    const callsAfterCompletion = calls.length;
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).rejects.toThrow(/already consumed/i);
    expect(calls).toHaveLength(callsAfterCompletion);

    expect(repository.rows).toHaveLength(0);
    expect(calls.every((call) => call.url.startsWith('https://auth.kimi.com/api/oauth/'))).toBe(true);

    // Simulate the authenticated host persisting the one-time payload in the Pod.
    const oauthCredentialIri = `${WEB_ID.replace('/profile/card#me', '')}/settings/credentials/kimi.ttl#cloud-kimi-oauth-host`;
    await repository.createCredential({
      credentialIri: oauthCredentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await vault().seal(
        { webId: WEB_ID },
        oauthCredentialIri,
        'kimi',
        {
          type: 'deviceCodeOAuth',
          accessToken: completed.oauthCredential!.accessToken,
          refreshToken: completed.oauthCredential!.refreshToken,
          expiresAt: completed.oauthCredential!.expiresAt,
        },
      ),
      status: 'active',
      offeringId: 'subscription-key',
    });

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
    await adapter.disconnect({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi' });
    expect(calls.some((call) => call.url.endsWith('/api/oauth/revoke'))).toBe(false);
    expect(repository.rows.at(-1)).toMatchObject({ status: 'revoked' });
  });

  it('returns a one-time Kimi OAuth credential without replacing an existing API key credential', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const repository = new RecordingCredentialRepository();
    repository.rows.push({
      id: aiRuntimeRepository.credentialId({ deployment: 'cloud', provider: 'kimi' }),
      credentialIri: aiRuntimeRepository.credentialIri(WEB_ID, {
        deployment: 'cloud',
        provider: 'kimi',
      }),
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#api-key',
        { type: 'apiKey', apiKey: 'sk-existing' },
      ),
      status: 'active',
      accountLabel: 'Existing API key',
      offeringId: 'api-platform',
      version: 1,
    });
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (url: string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
          return Response.json({
            device_code: 'kimi-device-code',
            user_code: 'KIMI-123',
            verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
            expires_in: 300,
            interval: 0,
          });
        }
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          return Response.json({
            access_token: 'kimi-access-token',
            refresh_token: 'kimi-refresh-token',
            expires_in: 3600,
            scope: 'openid profile',
          });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 15),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    now = new Date('2026-07-23T00:00:01.000Z');

    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...requireConnectAttempt(begun),
    });

    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      id: 'credentials.ttl#cloud-kimi',
      authMode: 'apiKey',
      accountLabel: 'Existing API key',
    });
    expect(completed.oauthCredential).toMatchObject({
      accessToken: 'kimi-access-token',
      refreshToken: 'kimi-refresh-token',
      scope: 'openid profile',
    });
    expect(JSON.stringify(repository.rows)).not.toMatch(/kimi-(?:access|refresh)-token/u);
  });

  it.each(['kimi-auth', 'other-issuer'])('returns issuer-scoped Kimi account hints after OAuth refresh (%s)', async (issuer) => {
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async () => Response.json({
        access_token: unsignedJwt({ iss: issuer, user_id: 'account-123', sub: 'subject-123' }),
        refresh_token: 'next-refresh', expires_in: 3600,
      })) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(), credentialRepository: new RecordingCredentialRepository(),
      vault: vault(), deployment: 'cloud', integration: kimiOAuthIntegration(), signingSecret: 'connect-signing-secret',
    });
    const result = await adapter.refreshCallerOwned({
      webId: WEB_ID, deployment: 'cloud', provider: 'kimi', credentialId: 'test', refreshToken: 'current-refresh', expectedVersion: 1,
    });
    expect(result.oauthCredential?.accountId).toBe(issuer === 'kimi-auth' ? 'kimi-auth:account-123' : undefined);
    expect(result.oauthCredential?.accountSubject).toBe(issuer === 'kimi-auth' ? 'kimi-auth:subject-123' : undefined);
  });

  it('refreshes a caller-owned OAuth secret without reading or writing the Pod repository', async () => {
    const repository = new RecordingCredentialRepository();
    const listCredentials = vi.spyOn(repository, 'listProviderCredentials');
    const createCredential = vi.spyOn(repository, 'createCredential');
    const updateCredential = vi.spyOn(repository, 'updateCredential');
    const sharedVault = vault();
    const openSecret = vi.spyOn(sharedVault, 'open');
    const sealSecret = vi.spyOn(sharedVault, 'seal');
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        expect(body.get('refresh_token')).toBe('host-refresh-token');
        return Response.json({
          access_token: 'next-access-token',
          refresh_token: 'next-refresh-token',
          expires_in: 3600,
          scope: 'openid profile',
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
      now: () => new Date('2026-08-09T07:00:00.000Z'),
    });

    await expect(adapter.refreshCallerOwned({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'credentials.ttl#kimi-oauth-1',
      refreshToken: 'host-refresh-token',
      expectedVersion: 4,
    })).resolves.toMatchObject({
      status: 'completed',
      credentialId: 'credentials.ttl#kimi-oauth-1',
      oauthCredential: {
        accessToken: 'next-access-token',
        refreshToken: 'next-refresh-token',
        expectedVersion: 4,
      },
    });
    expect(repository.rows).toHaveLength(0);
    expect(listCredentials).not.toHaveBeenCalled();
    expect(createCredential).not.toHaveBeenCalled();
    expect(updateCredential).not.toHaveBeenCalled();
    expect(openSecret).not.toHaveBeenCalled();
    expect(sealSecret).not.toHaveBeenCalled();
  });

  it('keeps existing refresh token and account identity when OAuth refresh does not rotate them', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const credentialIri = aiRuntimeRepository.credentialIri(WEB_ID, {
      deployment: 'cloud',
      provider: 'kimi',
    });
    const encryptedSecret = await sharedVault.seal(
      { webId: WEB_ID },
      credentialIri,
      'kimi',
      {
        type: 'deviceCodeOAuth',
        accessToken: 'old-access-token',
        refreshToken: 'old-refresh-token',
        accountId: 'acct-existing',
      },
    );
    const current = await repository.createCredential({
      credentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      offeringId: 'subscription-key',
    });
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        expect(body.get('refresh_token')).toBe('old-refresh-token');
        return Response.json({
          access_token: 'new-access-token',
          expires_in: 3600,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
      now: () => new Date('2026-08-09T07:00:00.000Z'),
    });

    await expect(adapter.refreshCallerOwned({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'subscription-key',
      credentialId: current.id,
      refreshToken: 'old-refresh-token',
      expectedVersion: current.version ?? 1,
    })).resolves.toMatchObject({
      oauthCredential: {
        accessToken: 'new-access-token',
        refreshToken: 'old-refresh-token',
      },
    });

    const updated = await adapter.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'subscription-key',
    }, current, {
      type: 'deviceCodeOAuth',
      refreshToken: 'old-refresh-token',
      accountId: 'acct-existing',
    });
    const opened = await sharedVault.open(
      { webId: WEB_ID },
      updated!.credentialIri,
      'kimi',
      updated!.encryptedSecret,
    );
    expect(opened).toMatchObject({
      accessToken: 'new-access-token',
      refreshToken: 'old-refresh-token',
      accountId: 'acct-existing',
    });
  });

  it('fails Kimi 2xx device responses that are empty, HTML, or missing required fields', async () => {
    const base = {
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud' as const,
      integration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
    };
    for (const response of [
      new Response('', { status: 200 }),
      new Response('<html>login</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      Response.json({ device_code: 'device-only' }, { status: 200 }),
    ]) {
      const adapter = new DeviceCodeConnectAdapter({
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

  it('rejects Kimi endpoint overrides outside the exact official OAuth paths', () => {
    const base = {
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud' as const,
      signingSecret: 'connect-signing-secret',
    };
    for (const override of [
      { begin: { endpoint: 'https://auth.kimi.com/api/oauth/device_authorization?debug=1' } },
      { begin: { endpoint: 'https://user:pass@auth.kimi.com/api/oauth/device_authorization' } },
      { poll: { endpoint: 'https://auth.kimi.com/api/oauth/token#frag' } },
      { poll: { endpoint: 'http://auth.kimi.com/api/oauth/token' } },
    ]) {
      expect(() => new DeviceCodeConnectAdapter({
        ...base,
        integration: kimiOAuthIntegration(kimiDeviceCodeProtocol(override)),
      })).toThrow(/allowlisted|endpoint/i);
    }
  });

  it('redacts provider error descriptions from exceptions and reauth reasons', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const credentialIri = aiRuntimeRepository.credentialIri(WEB_ID, {
      deployment: 'cloud',
      provider: 'kimi',
    });
    const encryptedSecret = await sharedVault.seal(
      { webId: WEB_ID },
      credentialIri,
      'kimi',
      { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
    );
    const current = await repository.upsertConnectedCredential({
      id: 'settings/ai/credentials/kimi.ttl#cloud-kimi',
      credentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      offeringId: 'subscription-key',
    });
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (url: string) => {
        if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
          return Response.json({
            device_code: 'kimi-device-code',
            user_code: 'KIMI-123',
            verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
            expires_in: 300,
            interval: 0,
          });
        }
        return Response.json({
          error: 'invalid_grant',
          error_description: 'leaked sk-live api_key device-code refresh-token',
        }, { status: 400 });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      signingSecret: 'connect-signing-secret',
      randomBytes: () => Buffer.alloc(32, 12),
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    const begunAttempt = requireConnectAttempt(begun);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).rejects.toThrow(/invalid_grant/i);
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...begunAttempt,
    })).rejects.not.toThrow(/sk-live|api_key|device-code|refresh-token/i);

    await adapter.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
    }, current, { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' });

    expect(repository.rows.at(-1)?.metadata?.reauthReason).toBe('invalid_grant');
    expect(JSON.stringify(repository.rows)).not.toContain('sk-live');
    expect(JSON.stringify(repository.rows)).not.toContain('api_key');
    expect(JSON.stringify(repository.rows)).not.toContain('device-code');
    expect(JSON.stringify(repository.rows)).not.toContain('refresh-token');
  });

  it('coalesces concurrent eligible Kimi polls into one provider request', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
        return Response.json({
          device_code: 'kimi-device-code',
          user_code: 'KIMI-123',
          verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
          expires_in: 300,
          interval: 0,
        });
      }
      if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        tokenCalls += 1;
        await Promise.resolve();
        return Response.json({ error: 'authorization_pending' }, { status: 400 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });
    const adapter = new DeviceCodeConnectAdapter({
      fetch: fetchMock as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      now: () => now,
      randomBytes: () => Buffer.alloc(32, 14),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'deviceCodeOAuth',
    });
    const begunAttempt = requireConnectAttempt(begun);
    now = new Date('2026-07-23T00:00:01.000Z');
    const input = {
      webId: WEB_ID,
      deployment: 'cloud' as const,
      provider: 'kimi',
      ...begunAttempt,
    };

    await expect(Promise.all([
      adapter.pollDevice(input),
      adapter.pollDevice(input),
    ])).resolves.toEqual([
      expect.objectContaining({ status: 'authorization_pending' }),
      expect.objectContaining({ status: 'authorization_pending' }),
    ]);
    expect(tokenCalls).toBe(1);
  });

  it('treats access_denied and cancellation as terminal statuses without calling the provider again', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    let tokenCalls = 0;
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe('error');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = new URLSearchParams(String(init?.body ?? ''));
        if (url.endsWith('/device_authorization')) {
          return Response.json({
            device_code: 'kimi-device-code',
            user_code: 'KIMI-123',
            verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
            expires_in: 300,
            interval: 0,
          });
        }
        if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
          tokenCalls += 1;
          return Response.json({ error: 'access_denied' }, { status: 400 });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      now: () => now,
      signingSecret: 'connect-signing-secret',
    });
    const deniedBegin = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'subscription-key',
      requestedMode: 'deviceCodeOAuth',
    });
    const deniedAttempt = requireConnectAttempt(deniedBegin);
    now = new Date('2026-07-23T00:00:01.000Z');

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...deniedAttempt,
    })).resolves.toMatchObject({ status: 'denied', offeringId: 'subscription-key' });
    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...deniedAttempt,
    })).resolves.toMatchObject({ status: 'denied' });
    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...deniedAttempt,
    })).rejects.toThrow(/already consumed/i);
    expect(tokenCalls).toBe(1);

    const cancelBegin = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'subscription-key',
      requestedMode: 'deviceCodeOAuth',
    });
    const cancelAttempt = requireConnectAttempt(cancelBegin);
    await expect(adapter.cancel({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...cancelAttempt,
    })).resolves.toMatchObject({ status: 'cancelled', offeringId: 'subscription-key' });
    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...cancelAttempt,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(tokenCalls).toBe(1);
  });

  it('treats profile-declared pending HTTP statuses as authorization_pending during device polling', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/device/code')) {
          return Response.json({
            device_auth_id: 'openai-device-code',
            user_code: 'OPENAI-123',
            verification_uri: 'https://auth.openai.com/device',
            expires_at: '1786320000',
            interval: '2',
          });
        }
        expect(url).toBe('https://auth.openai.com/oauth/device/poll');
        expect(JSON.parse(String(init?.body))).toEqual({
          device_auth_id: 'openai-device-code',
          user_code: 'OPENAI-123',
        });
        return Response.json({ error: 'not_ready' }, { status: 403 });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      integration: openAiOAuthIntegration(),
      now: () => now,
      signingSecret: 'connect-signing-secret',
    });

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      offeringId: 'official-subscription',
      authorizationMethodId: 'device-code',
      requestedMode: 'deviceCodeOAuth',
    });
    now = new Date('2026-07-23T00:00:02.000Z');

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...requireConnectAttempt(begun),
    })).resolves.toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'authorization_pending',
      offeringId: 'official-subscription',
      intervalSeconds: 2,
    });
  });

  it('supports JSON device polling followed by authorization-code exchange without exposing server secrets', async () => {
    let now = new Date('2026-07-23T00:00:00.000Z');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const idToken = unsignedJwt({
      sub: 'user-subject',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_from_claim' },
    });
    const adapter = new DeviceCodeConnectAdapter({
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        expect(init?.redirect).toBe('error');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (url.endsWith('/device/code')) {
          expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
          expect(JSON.parse(String(init?.body))).toEqual({ client_id: 'openai-public-client' });
          return Response.json({
            device_auth_id: 'openai-device-code',
            user_code: 'OPENAI-123',
            verification_uri: 'https://auth.openai.com/device',
            expires_at: '1786320000',
            interval: '2',
          });
        }
        if (url.endsWith('/device/poll')) {
          expect(JSON.parse(String(init?.body))).toEqual({
            device_auth_id: 'openai-device-code',
            user_code: 'OPENAI-123',
          });
          return Response.json({
            code: 'browser-auth-code',
            code_verifier: 'browser-code-verifier',
          });
        }
        const body = new URLSearchParams(String(init?.body ?? ''));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('browser-auth-code');
        expect(body.get('code_verifier')).toBe('browser-code-verifier');
        expect(body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
        return Response.json({
          access_token: 'openai-access-token',
          refresh_token: 'openai-refresh-token',
          expires_in: 3600,
          id_token: idToken,
        });
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'cloud',
      integration: openAiOAuthIntegration(),
      now: () => now,
      signingSecret: 'connect-signing-secret',
    });

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      offeringId: 'official-subscription',
      authorizationMethodId: 'device-code',
      requestedMode: 'deviceCodeOAuth',
      clientId: 'attacker-client-id',
    } as any);
    expect(begun).toMatchObject({
      provider: 'openai',
      offeringId: 'official-subscription',
      userCode: 'OPENAI-123',
      intervalSeconds: 2,
      expiresAt: '2026-08-10T00:00:00.000Z',
    });
    expect(begun.deviceCode).toBeUndefined();
    expect(begun.pkceChallenge).toBeUndefined();

    now = new Date('2026-07-23T00:00:02.000Z');
    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...requireConnectAttempt(begun),
    });
    expect(completed.oauthCredential).toMatchObject({
      accessToken: 'openai-access-token',
      refreshToken: 'openai-refresh-token',
      accountSubject: 'user-subject',
      accountId: 'acct_from_claim',
      offeringId: 'official-subscription',
    });
    expect(JSON.stringify(completed)).not.toContain('openai-device-code');
    expect(JSON.stringify(completed)).not.toContain('browser-code-verifier');
    expect(calls.map((call) => call.url)).toEqual([
      'https://auth.openai.com/oauth/device/code',
      'https://auth.openai.com/oauth/device/poll',
      'https://auth.openai.com/oauth/token',
    ]);
  });
});

describe('ProviderConnectService', () => {
  it('reports authorization methods from the registry with actual adapter and importer availability', () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        products: providerProductsForDeployment('cloud'),
      }),
      adapters: [
        new DeviceCodeConnectAdapter({
          fetch: (async () => Response.json({
            device_code: 'unused',
            user_code: 'UNUSED',
            verification_uri: 'https://kimi.moonshot.cn/device',
          })) as typeof fetch,
          attempts: new InMemoryConnectAttemptStore(),
          credentialRepository: new RecordingCredentialRepository(),
          vault: vault(),
          deployment: 'cloud',
          integration: kimiOAuthIntegration(),
          signingSecret: 'connect-signing-secret',
        }),
      ],
    });

    expect(service.getAuthorizationMethods()).toEqual(expect.arrayContaining([
      {
        provider: 'kimi',
        offeringId: 'subscription-key',
        endpoints: expect.arrayContaining([
          expect.objectContaining({ protocol: 'chatCompletions', baseUrl: 'https://api.kimi.com/coding/v1' }),
        ]),
        authorizationMethods: expect.arrayContaining([
          expect.objectContaining({ id: 'api-key', lifecycle: 'active' }),
          expect.objectContaining({ id: 'device-code', lifecycle: 'active', connectMode: 'deviceCodeOAuth' }),
          expect.objectContaining({ id: 'local-session-import', lifecycle: 'unavailable' }),
        ]),
      },
      {
        provider: 'openai',
        offeringId: 'official-subscription',
        endpoints: [{ protocol: 'responses', baseUrl: 'https://chatgpt.com/backend-api/codex' }],
        authorizationMethods: expect.arrayContaining([
          expect.objectContaining({
            id: 'device-code',
            lifecycle: 'unavailable',
            reason: 'authorization_adapter_unavailable',
          }),
        ]),
      },
    ]));
  });

  it('reports disabled Kimi API-key assisted Connect capability when deployment disables it', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        connect: {
          kimi: { configured: false, notes: ['auth_not_available'] },
        },
      }),
      adapters: [],
    });

    await expect(service.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      status: 'unsupported',
      mode: 'browserAssistedApiKey',
      apiKeyManagementSupported: true,
      message: 'auth_not_available',
    });
  });

  it('routes same-provider browser-assisted API key and OAuth adapters by mode, offering, and credential identity', async () => {
    const attempts = new InMemoryConnectAttemptStore();
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const browserAdapter = new BrowserAssistedApiKeyConnectAdapter({
      provider: 'kimi',
      consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
      attempts,
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 21),
      signingSecret: 'connect-signing-secret',
    });
    const oauthAdapter = new DeviceCodeConnectAdapter({
      fetch: (async (url: string) => {
        if (url === 'https://auth.kimi.com/api/oauth/device_authorization') {
          return Response.json({
            device_code: 'kimi-device-code',
            user_code: 'KIMI-123',
            verification_uri_complete: 'https://kimi.moonshot.cn/device?user_code=KIMI-123',
            expires_in: 300,
            interval: 0,
          });
        }
        return Response.json({
          access_token: 'oauth-access-token',
          refresh_token: 'oauth-refresh-token',
          expires_in: 3600,
        });
      }) as typeof fetch,
      attempts,
      credentialRepository: repository,
      vault: sharedVault,
      deployment: 'cloud',
      integration: kimiOAuthIntegration(),
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 22),
      signingSecret: 'connect-signing-secret',
    });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({
        products: providerProductsForDeployment('cloud'),
        connect: { kimi: { configured: true } },
      }),
      adapters: [oauthAdapter, browserAdapter],
      credentialRepository: repository,
      vault: sharedVault,
    });

    const browserBegin = await service.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      requestedMode: 'browserAssistedApiKey',
    });
    expect(browserBegin).toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: 'kimi',
      offeringId: 'api-platform',
    });
    expect(browserBegin.authorizationUrl).toContain('platform.moonshot.cn');
    const browserAttempt = requireConnectAttempt(browserBegin);

    await expect(service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      ...browserAttempt,
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'pending',
      offeringId: 'api-platform',
    });

    const completedApiKey = await service.completeApiKey({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...browserAttempt,
      apiKey: 'sk-kimi-api-platform',
      accountLabel: 'Kimi API platform',
    });
    expect(completedApiKey).toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'completed',
      provider: 'kimi',
      offeringId: 'api-platform',
    });
    const apiKeyCredentialId = completedApiKey.credentialId!;
    expect(repository.rows.find((row) => row.id === apiKeyCredentialId)).toMatchObject({
      authMode: 'apiKey',
      offeringId: 'api-platform',
      metadata: expect.objectContaining({ offeringId: 'api-platform' }),
    });

    const oauthBegin = await service.begin({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'subscription-key',
      requestedMode: 'deviceCodeOAuth',
    });
    expect(oauthBegin).toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'pending',
      offeringId: 'subscription-key',
    });
    await expect(service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      ...requireConnectAttempt(oauthBegin),
    })).resolves.toMatchObject({
      mode: 'deviceCodeOAuth',
      status: 'pending',
      offeringId: 'subscription-key',
    });

    const oauthIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth';
    repository.rows.push({
      id: 'cloud-kimi-oauth',
      credentialIri: oauthIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        oauthIri,
        'kimi',
        { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
      ),
      status: 'active',
      accountLabel: 'Kimi OAuth',
      offeringId: 'subscription-key',
      version: 2,
    });

    await expect(service.disconnect({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: apiKeyCredentialId,
    })).resolves.toMatchObject({ id: apiKeyCredentialId, authMode: 'apiKey', status: 'revoked' });
    expect(repository.rows.find((row) => row.id === 'cloud-kimi-oauth')).toMatchObject({ status: 'active' });

    await expect(service.disconnect({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-oauth',
    })).resolves.toMatchObject({ id: 'cloud-kimi-oauth', authMode: 'deviceCodeOAuth', status: 'revoked' });
  });

  it('routes DeepSeek browser-assisted begin to an explicit unsupported API-key-management response', async () => {
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
      requestedMode: 'browserAssistedApiKey',
    })).resolves.toMatchObject({
      mode: 'browserAssistedApiKey',
      status: 'unsupported',
      apiKeyManagementSupported: true,
    });
  });

  it('summarizes one effective connection per provider for the current identity', async () => {
    const auth = {
      type: 'solid' as const,
      webId: WEB_ID,
      accessToken: 'alice-management-token',
      tokenType: 'Bearer' as const,
    };
    const getCredential = vi.fn(async ({ provider }: { provider: string }) => provider === 'openai' ? ({
      id: 'credential_openai',
      credentialIri: 'https://id.example/alice/settings/ai/credentials/openai.ttl#cloud-openai',
      webId: WEB_ID,
      provider,
      deployment: 'cloud' as const,
      authMode: 'apiKey' as const,
      encryptedSecret: { ciphertext: 'not-public' },
      status: 'active' as const,
      accountLabel: 'Alice',
      metadata: { baseUrl: 'https://proxy.example/v1' },
      version: 3,
      reauthRequired: true,
    }) : undefined);
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
      credentialRepository: {
        getCredential,
        getActiveCredential: vi.fn(),
        upsertConnectedCredential: vi.fn(),
        markReauthRequired: vi.fn(),
        disconnect: vi.fn(),
      } as any,
    });

    await expect(service.listProviders({
      webId: WEB_ID,
      deployment: 'cloud',
      auth,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        status: 'reauthRequired',
        authMode: 'apiKey',
        accountLabel: 'Alice',
        baseUrl: 'https://proxy.example/v1',
        version: 3,
      }),
      expect.objectContaining({
        provider: 'deepseek',
        status: 'disconnected',
      }),
    ]));
    expect(getCredential).toHaveBeenCalledWith(expect.objectContaining({ auth }));
  });

  it('lists only the providers the deployment provides', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
      credentialRepository: {
        getCredential: vi.fn(async () => undefined),
        getActiveCredential: vi.fn(async () => undefined),
        upsertConnectedCredential: vi.fn(),
        markReauthRequired: vi.fn(),
        disconnect: vi.fn(),
      } as any,
    });

    const cloud = await service.listProviders({ webId: WEB_ID, deployment: 'cloud' });
    expect(cloud.map((summary) => summary.provider)).not.toContain('custom');
    expect(cloud.map((summary) => summary.provider)).not.toContain('ollama');

    const local = await service.listProviders({ webId: WEB_ID, deployment: 'local' });
    expect(local.map((summary) => summary.provider)).toEqual(expect.arrayContaining(['custom', 'ollama']));
  });

  it('rejects a self-hosted provider on a cloud credential write', async () => {
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
      credentialRepository: {
        getCredential: vi.fn(async () => undefined),
        getActiveCredential: vi.fn(async () => undefined),
        createCredential: vi.fn(),
        upsertConnectedCredential: vi.fn(),
        markReauthRequired: vi.fn(),
        disconnect: vi.fn(),
      } as any,
      vault: vault(),
    });

    await expect(service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'custom',
      apiKey: 'sk-self-hosted',
    })).rejects.toThrow('provider_not_available_in_deployment');
  });

  it('keeps the provided endpoint on a cloud credential write', async () => {
    const repository = new RecordingCredentialRepository();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
    });

    await expect(service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      apiKey: 'sk-foreign',
      baseUrl: 'https://my-own-gateway.example/v1',
    })).rejects.toThrow('provider_endpoint_not_configurable_in_cloud');

    await expect(service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      offeringId: 'api-platform',
      apiKey: 'sk-proxy',
      proxyUrl: 'http://127.0.0.1:7890',
    })).rejects.toThrow('provider_endpoint_not_configurable_in_cloud');

    // The same endpoint is a Local capability.
    await expect(service.createApiKeyCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'kimi',
      offeringId: 'api-platform',
      apiKey: 'sk-local-own',
      baseUrl: 'https://my-own-gateway.example/v1',
    })).resolves.toMatchObject({ provider: 'kimi', baseUrl: 'https://my-own-gateway.example/v1' });
    expect(repository.rows).toHaveLength(1);
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
      id: aiRuntimeRepository.credentialId({ deployment: 'cloud', provider: 'kimi' }),
      credentialIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      offeringId: 'subscription-key',
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new DeviceCodeConnectAdapter({
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
      integration: kimiOAuthIntegration(),
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

  it('refreshes and disconnects Kimi OAuth siblings without selecting a coexisting API key credential', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const apiKeyIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key';
    const oauthIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth';
    repository.rows.push({
      id: 'cloud-kimi-api-key',
      credentialIri: apiKeyIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        apiKeyIri,
        'kimi',
        { type: 'apiKey', apiKey: 'sk-existing-api-key' },
      ),
      status: 'active',
      accountLabel: 'API key',
      offeringId: 'api-platform',
      version: 1,
    });
    repository.rows.push({
      id: 'cloud-kimi-oauth',
      credentialIri: oauthIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        oauthIri,
        'kimi',
        { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
      ),
      status: 'active',
      accountLabel: 'OAuth',
      offeringId: 'subscription-key',
      version: 2,
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new DeviceCodeConnectAdapter({
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
      integration: kimiOAuthIntegration(),
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
    })).resolves.toMatchObject({ id: 'cloud-kimi-oauth', authMode: 'deviceCodeOAuth' });
    expect(bodies.at(-1)?.get('refresh_token')).toBe('sealed-refresh-token');

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-api-key',
    })).rejects.toThrow('oauth_credential_not_found');

    await expect(service.disconnect({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialId: 'cloud-kimi-oauth',
    })).resolves.toMatchObject({ id: 'cloud-kimi-oauth', status: 'revoked' });
    expect(repository.rows.find((row) => row.id === 'cloud-kimi-api-key')).toMatchObject({
      status: 'active',
      authMode: 'apiKey',
    });
  });

  it('revalidates the same Kimi OAuth sibling after refresh CAS conflicts instead of returning a coexisting API key', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const oauthIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth';
    const apiKeyIri = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key';
    repository.rows.push({
      id: 'cloud-kimi-oauth',
      credentialIri: oauthIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        oauthIri,
        'kimi',
        { type: 'deviceCodeOAuth', refreshToken: 'sealed-refresh-token' },
      ),
      status: 'active',
      accountLabel: 'OAuth',
      offeringId: 'subscription-key',
      version: 2,
    });
    repository.rows.push({
      id: 'cloud-kimi-api-key',
      credentialIri: apiKeyIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        apiKeyIri,
        'kimi',
        { type: 'apiKey', apiKey: 'sk-existing-api-key' },
      ),
      status: 'active',
      accountLabel: 'API key',
      offeringId: 'api-platform',
      version: 9,
    });
    const originalUpdate = repository.updateCredential.bind(repository);
    let conflictInjected = false;
    repository.updateCredential = vi.fn(async (input) => {
      if (!conflictInjected && input.credentialId === 'cloud-kimi-oauth') {
        conflictInjected = true;
        const oauth = repository.rows.find((row) => row.id === 'cloud-kimi-oauth')!;
        oauth.version = 3;
        return Promise.reject(new Error('credential_version_conflict'));
      }
      return originalUpdate(input);
    });
    const bodies: URLSearchParams[] = [];
    const adapter = new DeviceCodeConnectAdapter({
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
      integration: kimiOAuthIntegration(),
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
    })).resolves.toMatchObject({
      id: 'cloud-kimi-oauth',
      authMode: 'deviceCodeOAuth',
      offeringId: 'subscription-key',
      version: 3,
    });
    expect(bodies).toHaveLength(1);
  });

  it('canonicalizes generated credential ids through the shared Credential resource', async () => {
    const requests: Request[] = [];
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: async () => async (input, init) => {
          requests.push(new Request(input, init));
          return new Response(null, { status: 204 });
        },
      },
    });
    const credentialIri = 'https://id.example/alice/settings/credentials.ttl#local-openai-generated';

    const created = await repository.createCredential({
      credentialIri,
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await encryptedSecret(
        'openai',
        credentialIri,
        { type: 'deviceCodeOAuth', accessToken: 'access', refreshToken: 'refresh' },
      ),
      status: 'active',
      offeringId: 'official-subscription',
    }, { auth: INTERNAL_INVOCATION_AUTH });

    expect(created.id).toBe('credentials.ttl#local-openai-generated');
    expect(created.credentialIri).toBe(
      `https://id.example/alice/settings/${created.id}`,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://id.example/alice/settings/credentials.ttl',
    });
  });

  it('fails visibly when a Pod returns a malformed credential payload', async () => {
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      podBaseUrlResolver: async () => 'https://id.example/alice/',
      dbFactory: async () => ({
        init: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({
              execute: async () => [{
                id: 'credentials.ttl#local-openai-broken',
                encryptedSecret: '{',
              }],
            }),
          }),
        }),
      } as any),
    });

    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'local',
    }))).rejects.toThrow(
      /Invalid credential row credentials\.ttl#local-openai-broken/u,
    );
  });

  it('uses the production Pod credential repository adapter against models credentialResource fields', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    let simulateConcurrentRefreshBeforeRewrap = false;
    let rewrapRaceReads = 0;
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
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
        findById: async (_resource: unknown, id: string) => {
          const row = rows.get(id);
          if (row && simulateConcurrentRefreshBeforeRewrap && ++rewrapRaceReads === 2) {
            simulateConcurrentRefreshBeforeRewrap = false;
            const secret = JSON.parse(String(row.encryptedSecret));
            Object.assign(row, {
              encryptedSecret: JSON.stringify({ ...secret, ciphertext: 'fresh-token-ciphertext' }),
              keyVersion: String(Number(row.keyVersion) + 1),
            });
          }
          return jsonClone(row ?? null);
        },
        updateById: async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, {
            ...patch,
            encryptedSecret: typeof patch.encryptedSecret === 'string'
              ? patch.encryptedSecret
              : JSON.stringify(patch.encryptedSecret),
          });
          return jsonClone(row);
        },
        update: () => { throw new Error('Use updateById for exact credential writes'); },
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
    const begunAttempt = requireConnectAttempt(begun);

    await adapter.completeApiKey(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      ...begunAttempt,
      apiKey: 'sk-pod-backed-secret',
    }));

    const stored = [...rows.values()][0];
    expect(stored).toMatchObject({
      id: 'credentials.ttl#cloud-openai',
      provider: 'openai.ttl',
      authMode: 'apiKey',
      status: 'active',
      encryptionAlgorithm: 'AES-256-GCM',
      wrappedDataKey: expect.any(String),
      keyVersion: '1',
    });
    expect(JSON.stringify(stored)).toContain('https://id.example/alice/settings/credentials.ttl#cloud-openai');
    expect(JSON.stringify(stored)).not.toContain('sk-pod-backed-secret');
    const active = await repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }));
    expect(active).toMatchObject({ provider: 'openai', version: 1 });
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual([
      expect.objectContaining({ provider: 'openai', enabled: true, health: 'unknown' }),
    ]);
    await expect(repository.rewrapCredential(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId: active!.id,
      expectedVersion: 1,
      encryptedSecret: {
        ...active!.encryptedSecret,
        keyId: 'root-v2',
        wrappedDek: 'rewrapped-dek',
      },
    }))).resolves.toBe(true);
    await expect(repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject({
      version: 2,
      encryptedSecret: {
        keyId: 'root-v2',
        wrappedDek: 'rewrapped-dek',
      },
    });
    const beforeRace = await repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }));
    simulateConcurrentRefreshBeforeRewrap = true;
    await expect(repository.rewrapCredential(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId: beforeRace!.id,
      expectedVersion: beforeRace!.version,
      encryptedSecret: {
        ...beforeRace!.encryptedSecret,
        keyId: 'root-v3',
        wrappedDek: 'stale-rewrapped-dek',
      },
    }))).resolves.toBe(false);
    const racedRow = rows.get(beforeRace!.id);
    expect(typeof racedRow?.encryptedSecret).toBe('string');
    expect(racedRow?.encryptedSecret).toContain('fresh-token-ciphertext');
    expect(racedRow).toMatchObject({ keyVersion: '3' });
    const disconnected = await repository.disconnect(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }));
    expect(disconnected).toMatchObject({ status: 'revoked', version: 4 });
  });

  it.each([
    ['missing auth', undefined, 'caller_pod_access_unavailable'],
    ['browser Bearer token', { accessToken: 'browser-bearer-token', tokenType: 'Bearer' as const }, 'pod_interface_key_missing'],
    ['Gateway API key principal', { viaGatewayApiKey: true, gatewayKeyId: 'gateway-key-id', scopes: ['models:read'], tokenType: 'Bearer' as const }, 'pod_interface_key_missing'],
  ])('reports %s when the Pod access provider has no usable credential', async (_label, authPatch, expectedError) => {
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const getPodFetch = vi.fn(async () => undefined);
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch,
      },
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: vi.fn() as any,
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
          findById: vi.fn(async () => null),
          updateById: vi.fn(async () => null),
          update: vi.fn() as any,
        } as any;
      },
    });

    await expect(repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      auth: authPatch === undefined
        ? undefined
        : {
            type: 'solid' as const,
            webId: WEB_ID,
            ...authPatch,
          },
    })).rejects.toThrow(expectedError);

    // The provider is the single source of Pod access: an empty result is the only
    // "no credential" signal, and the caller's own auth decides which reason is reported.
    expect(getPodFetch).toHaveBeenCalledOnce();
    expect(getPodFetch).toHaveBeenCalledWith(
      WEB_ID,
      authPatch === undefined
        ? { podBaseUrl: 'https://id.example/alice/' }
        : {
            auth: expect.objectContaining(authPatch),
            podBaseUrl: 'https://id.example/alice/',
          },
    );

    expect(browserFetch).not.toHaveBeenCalled();
    browserFetch.mockRestore();
  });

  it('rejects an owner-mismatched caller before consulting the Pod access provider', async () => {
    // Authoritative policy (docs/pod-interface-key.md §5, docs/testing/2026-10-05-release-026-local-verification.md):
    // the shared owner-Pod resolver refuses a credential WebID that differs from the requested owner
    // before any Pod fetch, DB factory or operation runs. The caller never borrows the owner's access,
    // and the refusal keeps the same `caller_owner_mismatch` reason.
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    const getPodFetch = vi.fn(async () => undefined);
    const dbFactory = vi.fn(async () => {
      throw new Error('db factory must not run for an owner-mismatched caller');
    });
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch },
      dbFactory,
    });

    await expect(repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      auth: {
        type: 'solid' as const,
        webId: OTHER_WEB_ID,
        viaApiKey: true,
        accessToken: 'caller-bearer-token',
        tokenType: 'Bearer' as const,
      },
    })).rejects.toThrow('caller_owner_mismatch');

    expect(getPodFetch).not.toHaveBeenCalled();
    expect(dbFactory).not.toHaveBeenCalled();
    expect(browserFetch).not.toHaveBeenCalled();
    browserFetch.mockRestore();
  });

  it('uses constrained hosted Pod access for a same-owner browser DPoP session', async () => {
    const hostedFetch = vi.fn(async () => new Response('', { status: 200 }));
    const getPodFetch = vi.fn(async () => hostedFetch as typeof fetch);
    const dbFactory = vi.fn(async ({ fetch: podFetch }) => {
      await podFetch('https://pod.example/alice/settings/credentials.ttl');
      return {
        init: vi.fn(),
        insert: vi.fn() as any,
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
        findById: vi.fn(async () => null),
        updateById: vi.fn(async () => null),
        update: vi.fn() as any,
      } as any;
    });
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch },
      podBaseUrlResolver: async () => 'https://pod.example/alice/',
      dbFactory,
    });

    await repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        accessToken: 'browser-dpop-token',
        tokenType: 'DPoP',
        dpopProof: 'proof-for-management-url',
      },
    });

    expect(getPodFetch).toHaveBeenCalledWith(
      WEB_ID,
      {
        auth: expect.objectContaining({ tokenType: 'DPoP', webId: WEB_ID }),
        podBaseUrl: 'https://pod.example/alice/',
      },
    );
    expect(hostedFetch).toHaveBeenCalledOnce();
  });

  it('uses an owner-bound sk client-credentials Bearer token', async () => {
    const callerFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const repository = new PodConnectedCredentialRepository({
      podAccess: new OwnerPodAccess({
        sessions: createTestSolidSessions({
          tokenEndpoint: 'https://id.example/alice/.oidc/token',
          fetch: callerFetch as unknown as typeof fetch,
        }),
        fetch: callerFetch as unknown as typeof fetch,
      }),
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: vi.fn() as any,
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
          findById: vi.fn(async () => null),
          updateById: vi.fn(async () => null),
          update: vi.fn() as any,
        } as any;
      },
    });

    await repository.getActiveCredential({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        viaApiKey: true,
        accessToken: 'caller-bearer-token',
        tokenType: 'Bearer',
      },
    });

    expect(callerFetch).toHaveBeenCalledWith(
      'https://id.example/alice/settings/credentials.ttl',
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const headers = callerFetch.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer caller-bearer-token');
    callerFetch.mockRestore();
  });

  it('normalizes credential Pod 403 responses as service_access_missing', async () => {
    const serviceFetch = vi.fn(async () => new Response('', { status: 403 }));
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => serviceFetch as typeof fetch),
      },
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: vi.fn() as any,
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [] }) }) }),
          findById: vi.fn(async () => null),
          updateById: vi.fn(async () => null),
          update: vi.fn() as any,
        } as any;
      },
    });

    await expect(repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).rejects.toThrow('service_access_missing');
  });

  it('supports multiple credential rows for the same provider when listing and resolving active credentials', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const providerIri = 'https://id.example/alice/settings/credentials/openai.ttl#openai';
    const activeCredentialIri = aiRuntimeRepository.credentialIri(WEB_ID, {
      deployment: 'cloud',
      provider: 'openai',
    });
    const legacyCredentialIri = 'https://id.example/alice/settings/ai/credentials/openai.ttl#legacy-openai';
    const makeRecord = (id: string, version: number, options: {
      status: 'active' | 'revoked';
      reauthRequired?: boolean;
      accountLabel: string;
      encryptedSecret: Record<string, unknown>;
    }): Record<string, unknown> => ({
      id,
      provider: providerIri,
      service: 'ai',
      status: options.status,
      authMode: 'apiKey',
      encryptedSecret: JSON.stringify(options.encryptedSecret),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: String(version),
      accountLabel: options.accountLabel,
      label: options.accountLabel,
      reauthRequired: options.reauthRequired ?? false,
      expiresAt: null,
      scopes: [],
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
    });

    const activeId = aiRuntimeRepository.credentialId({ deployment: 'cloud', provider: 'openai' });
    const legacyId = 'https://id.example/settings/credentials/openai.ttl#cloud-openai-legacy';
    rows.set(activeId, makeRecord(activeId, 4, {
      status: 'active',
      accountLabel: 'Primary',
      reauthRequired: true,
      encryptedSecret: {
        webId: WEB_ID,
        credentialIri: activeCredentialIri,
        provider: 'openai',
        type: 'apiKey',
        apiKey: 'sk-primary',
      },
    }));
    rows.set(legacyId, makeRecord(legacyId, 2, {
      status: 'active',
      accountLabel: 'Legacy',
      encryptedSecret: {
        webId: WEB_ID,
        credentialIri: legacyCredentialIri,
        provider: 'openai',
        type: 'apiKey',
        apiKey: 'sk-legacy',
      },
    }));

    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({
              execute: async () => [...rows.values()].map(jsonClone),
            }),
          }),
        }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return jsonClone(row);
        },
        update: vi.fn(),
      } as any),
    });

    await expect(repository.getCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject({
      id: activeId,
      version: 4,
      reauthRequired: true,
    });
    await expect(repository.getActiveCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject({
      id: 'https://id.example/settings/credentials/openai.ttl#cloud-openai-legacy',
      version: 2,
      accountLabel: 'Legacy',
      reauthRequired: false,
    });
    const listed = await repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }));
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountLabel: 'Primary', credentialIri: activeCredentialIri, enabled: false }),
      expect.objectContaining({ accountLabel: 'Legacy', credentialIri: legacyCredentialIri, enabled: true }),
    ]));
  });

  it('reads and manages UUID credentials independently of the host deployment', async () => {
    const credentialId = 'credentials.ttl#openai-8d790bab-2c3d-43d0-a25d-916bc205ba42';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const rows = new Map<string, Record<string, unknown>>([[credentialId, {
      id: credentialId,
      owner: WEB_ID,
      provider: 'https://id.example/alice/settings/openai.ttl#openai',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify({
        algorithm: 'PLAINTEXT',
        keyId: 'test-v1',
        wrappedDek: 'wrapped-v1',
        aadPurpose: 'test',
        aadVersion: '1',
        ciphertext: 'ciphertext-v1',
        nonce: 'nonce-v1',
        webId: WEB_ID,
        credentialIri,
        provider: 'openai',
        dekWrapAlgorithm: 'test',
      }),
      keyVersion: '1',
      metadata: {
        offeringId: 'api-platform',
        enabled: true,
        priority: 10,
        health: 'healthy',
      },
    }]]);
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }),
          }),
        }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
          expect(patch).not.toHaveProperty('id');
          expect(patch).not.toHaveProperty('@id');
          const current = rows.get(id);
          if (!current) return null;
          Object.assign(current, patch);
          return jsonClone(current);
        },
        update: () => ({ set: () => ({ where: () => {
          throw new Error("Using 'id' or '@id' in where() is not supported. Use updateById.");
        } }) }),
      } as any),
    });

    for (const deployment of ['cloud', 'local'] as const) {
      await expect(repository.listProviderCredentials(withInternalAuth({
        webId: WEB_ID,
        provider: 'openai',
        deployment,
      }))).resolves.toMatchObject([{ id: credentialId, provider: 'openai' }]);
      await expect(repository.getCredentialById(withInternalAuth({
        webId: WEB_ID,
        provider: 'openai',
        deployment,
        credentialId,
      }))).resolves.toMatchObject({ id: credentialId, version: 1 });
    }

    await expect(repository.listProviderCredentials({
      webId: 'https://id.example/bob/profile/card#me',
      provider: 'openai',
      deployment: 'cloud',
      auth: { ...INTERNAL_INVOCATION_AUTH, webId: 'https://id.example/bob/profile/card#me' },
    })).resolves.toEqual([]);
    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'anthropic',
      deployment: 'local',
    }))).resolves.toEqual([]);
    const siblingId = 'credentials.ttl#openai-sibling';
    rows.set(siblingId, { ...jsonClone(rows.get(credentialId)!), id: siblingId, accountLabel: 'Sibling' });
    await expect(repository.updateCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
      expectedVersion: 0,
      patch: { accountLabel: 'Stale write' },
    }))).rejects.toThrow('credential_version_conflict');

    await expect(repository.updateCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      credentialId,
      expectedVersion: 1,
      patch: { accountLabel: 'Portable credential' },
    }))).resolves.toMatchObject({
      id: credentialId,
      accountLabel: 'Portable credential',
      version: 2,
    });

    const concurrent = await Promise.all(['First edit', 'Second edit'].map((accountLabel) =>
      repository.updateCredential(withInternalAuth({
        webId: WEB_ID, provider: 'openai', deployment: 'cloud', credentialId,
        expectedVersion: 2, patch: { accountLabel },
      }))));
    expect(concurrent.filter(Boolean)).toHaveLength(1);
    expect(rows.get(credentialId)?.keyVersion).toBe('3');
    expect(rows.get(siblingId)).toMatchObject({ id: siblingId, keyVersion: '1', accountLabel: 'Sibling' });
    const updated = await repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
    }));
    await expect(repository.rewrapCredential(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
      credentialId,
      expectedVersion: updated?.version,
      encryptedSecret: {
        ...updated!.encryptedSecret,
        keyId: 'test-v2',
        wrappedDek: 'wrapped-v2',
      },
    }))).resolves.toBe(true);

    const rewrapped = await repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
    }));
    await expect(repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      credentialId,
      expectedVersion: rewrapped?.version,
    }))).resolves.toMatchObject({
      id: credentialId,
      status: 'revoked',
    });
  });

  it('persists and restores offeringId/priority/enabled/health metadata and defaults', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const trustedFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => trustedFetch as unknown as typeof fetch),
      },
      dbFactory: async ({ fetch: podFetch }) => {
        await podFetch('https://id.example/alice/settings/credentials.ttl');
        return {
          init: vi.fn(),
          insert: () => ({
            values: (value: any) => ({
              execute: async () => {
                rows.set(value.id, jsonClone(value));
                return [jsonClone(value)];
              },
            }),
          }),
          select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
          findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
          updateById: async (_resource: unknown, id: string, patch: any) => {
            const row = rows.get(id);
            if (!row) return null;
            Object.assign(row, patch);
            return jsonClone(row);
          },
          update: () => ({
            set: (_patch: any) => ({
              where: (_condition: any) => ({
                returning: () => ({ execute: async () => [] }),
              }),
            }),
          }),
        } as any;
      },
    });

    await repository.createCredential({
      id: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
      credentialIri: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'openai',
        'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
        { type: 'apiKey', apiKey: 'legacy-key' },
      ),
      status: 'active',
      accountLabel: 'Defaulted',
    }, { auth: INTERNAL_INVOCATION_AUTH });

    const stored = [...rows.values()][0];
    expect(stored.metadata).toMatchObject({
      offeringId: 'api-platform',
      priority: 100,
      enabled: true,
      health: 'healthy',
    });
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      credentialId: 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-legacy',
    }))).resolves.toMatchObject({
      offeringId: 'api-platform',
      priority: 100,
      enabled: true,
      health: 'healthy',
    });
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toMatchObject([{
      provider: 'openai',
      enabled: true,
      health: 'healthy',
      priority: 100,
    }]);
    const listed = await repository.listCredentials(withInternalAuth({ webId: WEB_ID, deployment: 'cloud' }));
    expect(listed.at(0)?.metadata).toMatchObject({
      offeringId: 'api-platform',
    });

    const generatedCredentialIri =
      'https://id.example/alice/settings/credentials.ttl#cloud-openai-generated';
    const generated = await repository.createCredential({
      credentialIri: generatedCredentialIri,
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'openai',
        generatedCredentialIri,
        { type: 'apiKey', apiKey: 'generated-key' },
      ),
      status: 'active',
      accountLabel: 'Generated',
      metadata: {
        offeringId: 'responses-api',
        priority: 5,
        enabled: false,
        health: 'error',
      },
    }, { auth: INTERNAL_INVOCATION_AUTH });
    expect(generated.id).toBe('credentials.ttl#cloud-openai-generated');
    expect(generated.credentialIri).toBe(
      `https://id.example/alice/settings/${generated.id}`,
    );
    expect(rows.get(generated.id)?.metadata).toMatchObject({
      offeringId: 'responses-api',
      priority: 5,
      enabled: false,
      health: 'error',
    });

    await repository.createCredential({
      id: 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key',
      credentialIri: 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key',
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret(
        'kimi',
        'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key',
        { type: 'apiKey', apiKey: 'sk-kimi' },
      ),
      status: 'active',
      accountLabel: 'Kimi API key',
    }, { auth: INTERNAL_INVOCATION_AUTH });
    expect(rows.get('https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-api-key')?.metadata)
      .toMatchObject({ offeringId: 'api-platform' });

    const kimiOAuthId = 'https://id.example/alice/settings/credentials/kimi.ttl#cloud-kimi-oauth-legacy';
    rows.set(kimiOAuthId, {
      id: kimiOAuthId,
      provider: 'https://id.example/alice/settings/ai/credentials/kimi.ttl#kimi',
      service: 'ai',
      status: 'active',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri: kimiOAuthId,
        provider: 'kimi',
        type: 'deviceCodeOAuth',
        accessToken: 'oauth-access',
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: '1',
      accountLabel: 'Kimi OAuth',
      label: 'Kimi OAuth',
      reauthRequired: false,
      expiresAt: null,
      scopes: [],
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
    });
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: kimiOAuthId,
    }))).resolves.toMatchObject({
      authMode: 'deviceCodeOAuth',
      offeringId: 'subscription-key',
    });
  });

  it('supports creating multi-row credentials, get by id and sibling revoke with version CAS', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const trustedFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const makeRecord = (id: string, credentialIri: string, version: number, input: {
      status: 'active' | 'revoked';
      authMode: 'apiKey' | 'deviceCodeOAuth';
      reauthRequired?: boolean;
      accountLabel: string;
      secretType: string;
    }): Record<string, unknown> => ({
      id,
      provider: 'https://id.example/alice/settings/ai/credentials/kimi.ttl#kimi',
      service: 'ai',
      status: input.status,
      authMode: input.authMode,
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri,
        provider: 'kimi',
        type: input.secretType,
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: String(version),
      accountLabel: input.accountLabel,
      label: input.accountLabel,
      reauthRequired: input.reauthRequired ?? false,
      scopes: [],
      expiresAt: null,
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
      metadata: {},
    });
    const apiKeyId = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-api';
    const oauthId = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-oauth';
    rows.set(apiKeyId, makeRecord(
      apiKeyId,
      'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-api',
      7,
      {
      status: 'active',
      authMode: 'apiKey',
      accountLabel: 'ApiKey',
      secretType: 'apiKey',
      },
    ));
    rows.set(oauthId, makeRecord(
      oauthId,
      'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-openai-oauth',
      3,
      {
      status: 'active',
      authMode: 'deviceCodeOAuth',
      accountLabel: 'OAuth',
      secretType: 'deviceCodeOAuth',
      },
    ));
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => trustedFetch as unknown as typeof fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: vi.fn(async (_resource: unknown, id: string, patch: any) => {
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return jsonClone(row);
        }),
        update: () => ({
          set: (_patch: any) => ({
            where: (_condition: any) => ({
              returning: () => ({
                execute: async () => {
                  if (!rows.has(oauthId)) return [];
                  rows.set(oauthId, {
                    ...rows.get(oauthId)!,
                    status: 'revoked',
                    keyVersion: String(Number(rows.get(oauthId)!.keyVersion) + 1),
                  });
                  return [jsonClone(rows.get(oauthId)!)];
                },
              }),
            }),
          }),
        }),
      } as any),
    });

    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
    }))).resolves.toMatchObject({ authMode: 'deviceCodeOAuth', accountLabel: 'OAuth' });
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: apiKeyId,
    }))).resolves.toMatchObject({ authMode: 'apiKey', accountLabel: 'ApiKey' });

    const revoked = await repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
      keyVersion: 3,
      expectedVersion: 3,
    }));
    expect(revoked).toMatchObject({
      id: oauthId,
      status: 'revoked',
      version: 4,
      authMode: 'deviceCodeOAuth',
    });

    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: apiKeyId,
    }))).resolves.toMatchObject({
      status: 'active',
      accountLabel: 'ApiKey',
      id: apiKeyId,
    });
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: apiKeyId }),
    ]));
    expect((await repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).map((item) => item.id)).not.toContain(oauthId);

    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
      keyVersion: 3,
    }))).resolves.toBeUndefined();
    await expect(repository.getCredentialById(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: oauthId,
      keyVersion: 4,
    }))).resolves.toMatchObject({ id: oauthId, status: 'revoked' });
  });

  it('lists provider credentials in priority order and treats CAS mismatch as no update', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const makeRecord = (id: string, version: number, priority: number): Record<string, unknown> => ({
      id,
      provider: 'https://id.example/alice/settings/ai/credentials/kimi.ttl#kimi',
      service: 'ai',
      status: 'active',
      authMode: 'apiKey',
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri: id,
        provider: 'kimi',
        type: 'apiKey',
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: String(version),
      accountLabel: id.endsWith('a') ? 'A' : 'B',
      label: id.endsWith('a') ? 'A' : 'B',
      reauthRequired: false,
      scopes: [],
      expiresAt: null,
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
      metadata: { offeringId: 'official-subscription', priority, enabled: true, health: 'healthy' },
    });
    const credentialA = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi-key-a';
    const credentialB = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi-key-b';
    rows.set(credentialA, makeRecord(credentialA, 1, 20));
    rows.set(credentialB, makeRecord(credentialB, 2, 10));
    const updateById = vi.fn();
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => {
          const row = rows.get(id);
          // A concurrent writer advanced the exact row since the collection read.
          return row ? jsonClone({ ...row, keyVersion: String(Number(row.keyVersion) + 1) }) : null;
        },
        updateById,
        update: () => ({
          set: (_patch: any) => ({
            where: (_condition: any) => ({
              returning: () => ({ execute: async () => [] }),
            }),
          }),
        }),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: credentialB, status: 'active', priority: 10 },
      { id: credentialA, status: 'active', priority: 20 },
    ]);

    await expect(repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      credentialId: credentialA,
      expectedVersion: 1,
    }))).resolves.toBeUndefined();
    expect(updateById).not.toHaveBeenCalled();
    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: credentialB, status: 'active' },
      { id: credentialA, status: 'active' },
    ]);
  });

  it('queries product credential rows across offering runtime provider ids without overwriting sibling providers', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const makeRecord = (
      id: string,
      provider: string,
      offeringId: string,
      priority: number,
    ): Record<string, unknown> => ({
      id,
      provider: `https://id.example/alice/settings/ai/credentials/${provider}.ttl#${provider}`,
      service: 'ai',
      status: 'active',
      authMode: 'apiKey',
      encryptedSecret: JSON.stringify({
        webId: WEB_ID,
        credentialIri: id,
        provider,
        type: 'apiKey',
      }),
      wrappedDataKey: 'wrapped',
      encryptionAlgorithm: 'AES-256-GCM',
      keyVersion: '1',
      accountLabel: provider,
      label: provider,
      reauthRequired: false,
      scopes: [],
      expiresAt: null,
      lastRefreshAt: new Date('2026-07-23T00:00:00.000Z'),
      metadata: {
        offeringId,
        priority,
        enabled: true,
        health: 'healthy',
        models: [`${provider}-model`],
      },
    });
    const paygoId = 'https://id.example/alice/settings/ai/credentials/bailian.ttl#cloud-bailian-key';
    const codingId = 'https://id.example/alice/settings/ai/credentials/bailian-coding-plan.ttl#cloud-bailian-coding-key';
    const tokenId = 'https://id.example/alice/settings/ai/credentials/bailian-token-plan.ttl#cloud-bailian-token-key';
    const kimiId = 'https://id.example/alice/settings/ai/credentials/kimi.ttl#cloud-kimi-oauth';
    rows.set(paygoId, makeRecord(paygoId, 'bailian', 'pay-as-you-go', 30));
    rows.set(codingId, makeRecord(codingId, 'bailian-coding-plan', 'coding-plan', 10));
    rows.set(tokenId, makeRecord(tokenId, 'bailian-token-plan', 'token-plan', 20));
    rows.set(kimiId, makeRecord(kimiId, 'kimi', 'official-subscription', 5));
    const updatedRows: Record<string, unknown>[] = [];
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({ from: () => ({ where: () => ({ execute: async () => [...rows.values()].map(jsonClone) }) }) }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: async (_resource: unknown, id: string, patch: Record<string, unknown>) => {
          const row = rows.get(id);
          if (!row) return null;
          updatedRows.push(patch);
          Object.assign(row, patch);
          return jsonClone(row);
        },
        update: () => { throw new Error('Use updateById for exact credential writes'); },
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'bailian',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: codingId, provider: 'bailian-coding-plan', offeringId: 'coding-plan', priority: 10 },
      { id: tokenId, provider: 'bailian-token-plan', offeringId: 'token-plan', priority: 20 },
      { id: paygoId, provider: 'bailian', offeringId: 'pay-as-you-go', priority: 30 },
    ]);

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'bailian-token-plan',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: tokenId, provider: 'bailian-token-plan', offeringId: 'token-plan' },
    ]);

    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: codingId, provider: 'bailian-coding-plan' }),
      expect.objectContaining({ id: tokenId, provider: 'bailian-token-plan' }),
      expect.objectContaining({ id: paygoId, provider: 'bailian' }),
      expect.objectContaining({ id: kimiId, provider: 'kimi' }),
    ]));

    await expect(repository.revokeCredential(withInternalAuth({
      webId: WEB_ID,
      provider: 'bailian',
      deployment: 'cloud',
      credentialId: tokenId,
      expectedVersion: 1,
    }))).resolves.toMatchObject({
      provider: 'bailian-token-plan',
      status: 'revoked',
    });
    expect(updatedRows.at(-1)).toMatchObject({
      provider: 'bailian-token-plan.ttl',
      status: 'revoked',
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toMatchObject([
      { id: kimiId, provider: 'kimi', offeringId: 'official-subscription' },
    ]);
  });

  it('binds credential collection hydration to the Xpod settings SPARQL sidecar', async () => {
    const endpoints: string[] = [];
    const credentialId = 'credentials.ttl#cloud-openai';
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'https://id.example/alice/settings/ai/providers/openai.ttl#openai',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify({
        algorithm: 'PLAINTEXT',
        keyId: 'test',
        wrappedDek: 'test',
        aadPurpose: 'test',
        aadVersion: '1',
        ciphertext: 'test',
        nonce: 'test',
        webId: WEB_ID,
        credentialIri: `https://id.example/alice/settings/${credentialId}`,
        provider: 'openai',
        dekWrapAlgorithm: 'test',
      }),
      keyVersion: '1',
      baseUrl: 'https://api.example/v1',
      metadata: { priority: 1 },
    };
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => fetch),
      },
      dbFactory: async ({ credential, aiProvider }) => {
        endpoints.push(credential?.getSparqlEndpoint?.() ?? '');
        endpoints.push(aiProvider?.getSparqlEndpoint?.() ?? '');
        return {
          init: vi.fn(),
          insert: vi.fn(),
          select: () => ({
            from: () => ({
              where: () => ({ execute: async () => [jsonClone(row)] }),
            }),
          }),
          findById: async () => null,
          updateById: vi.fn(),
          update: vi.fn(),
        } as any;
      },
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toMatchObject([{ id: credentialId, provider: 'openai' }]);
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toMatchObject([{
      id: credentialId,
      provider: 'openai',
      metadata: { baseUrl: 'https://api.example/v1' },
    }]);
    expect(endpoints).toEqual([
      'https://id.example/alice/settings/-/sparql',
      'https://id.example/alice/settings/-/sparql',
      'https://id.example/alice/settings/-/sparql',
      'https://id.example/alice/settings/-/sparql',
    ]);
  });

  it('keeps AIModel SPARQL endpoints isolated between Pod owners', async () => {
    const modelResources: Array<{ getSparqlEndpoint?: () => string | undefined }> = [];
    const repository = new PodConnectedCredentialRepository({
      podBaseUrlResolver: async (owner) => owner === WEB_ID
        ? 'https://pods.example/alice/'
        : 'https://pods.example/bob/',
      podAccess: {
        getPodFetch: vi.fn(async () => fetch),
      },
      dbFactory: async ({ aiModel }) => {
        modelResources.push(aiModel!);
        return {
          init: vi.fn(),
          insert: vi.fn(),
          select: () => ({
            from: () => ({
              where: () => ({ execute: async () => [] }),
            }),
          }),
          findById: async () => null,
          updateById: vi.fn(),
          update: vi.fn(),
        } as any;
      },
    });

    await repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }));
    await repository.listCredentials({
      webId: OTHER_WEB_ID,
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: OTHER_WEB_ID,
        internalInvocation: true,
        tokenType: 'Bearer',
      },
    });

    expect(modelResources).toHaveLength(2);
    expect(modelResources[0]).not.toBe(modelResources[1]);
    expect(modelResources.map((resource) => resource.getSparqlEndpoint?.())).toEqual([
      'https://pods.example/alice/settings/-/sparql',
      'https://pods.example/bob/settings/-/sparql',
    ]);
  });

  it('does not query AIModel rows when no credential needs hydration', async () => {
    const modelCollectionReads = vi.fn();
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      dbFactory: async ({ aiModel }) => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: (resource: unknown) => {
            if (resource === aiModel) {
              modelCollectionReads();
            }
            return {
              execute: async () => [],
              where: () => ({ execute: async () => [] }),
            };
          },
        }),
        findById: async () => null,
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual([]);
    expect(modelCollectionReads).not.toHaveBeenCalled();
  });

  it('keeps legacy credential model metadata when canonical selection facts are absent', async () => {
    const credentialId = 'credentials.ttl#openai-api-key';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'openai.ttl',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('openai', credentialIri, {
        type: 'apiKey',
        apiKey: 'fixture-openai-key',
      })),
      keyVersion: '1',
      metadata: { models: ['gpt-5'], enabled: true, health: 'healthy' },
    };
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({ where: () => ({ execute: async () => [jsonClone(row)] }) }),
        }),
        findById: async () => null,
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toEqual([expect.not.objectContaining({ selectedModels: expect.anything() })]);
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).resolves.toEqual([expect.objectContaining({
      models: ['gpt-5'],
      metadata: expect.objectContaining({ models: ['gpt-5'] }),
    })]);
  });

  it('hydrates canonical active AIModel rows linked to their Provider with isProvidedBy', async () => {
    const credentialId = 'credentials.ttl#openai-subscription';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'openai-official-subscription.ttl',
      service: 'ai',
      authMode: 'deviceCodeOAuth',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('openai', credentialIri, {
        type: 'oauth2',
        accessToken: 'fixture-access-token',
      })),
      keyVersion: '1',
      metadata: { offeringId: 'official-subscription', enabled: true, health: 'healthy' },
    };
    const providerUrl = 'https://id.example/alice/settings/providers/openai.ttl';
    const podFetch = vi.fn(async () => new Response(`
      @prefix schema: <https://schema.org/> .
      @prefix xpod: <https://vocab.undefineds.co/xpod#> .
      <${providerUrl}> a xpod:Provider .
      <${providerUrl}#gpt-5> a xpod:AIModel ;
        xpod:isProvidedBy <${providerUrl}> ;
        xpod:status "active" ;
        schema:name "GPT-5" .
    `, { status: 200, headers: { 'content-type': 'text/turtle' } }));
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => podFetch as typeof fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({ execute: async () => [jsonClone(row)] }),
            execute: async () => [],
          }),
        }),
        findById: async (_resource: unknown, id: string) => id === 'openai.ttl' ? { id } : null,
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toEqual([expect.objectContaining({
      selectedModels: [expect.objectContaining({
        id: 'gpt-5',
        provider: 'openai',
        resourceId: `${providerUrl}#gpt-5`,
      })],
    })]);
  });

  it('falls back to exact AIModel reads when collection queries are unsupported', async () => {
    const credentialId = 'credentials.ttl#openai-api-key';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const selectedModel = 'openai.ttl#gpt-5';
    const credentialRow = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'openai-api-platform.ttl',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('openai', credentialIri, {
        type: 'apiKey',
        apiKey: 'fixture-openai-key',
      })),
      keyVersion: '1',
      metadata: { offeringId: 'api-platform', enabled: true, health: 'healthy' },
    };
    const providerRow = { id: 'openai.ttl', hasModel: [selectedModel] };
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      dbFactory: async ({ credential, aiProvider, aiModel }) => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: (resource: unknown) => ({
            execute: async () => {
              if (resource === aiModel) {
                throw new Error('Document-mode collection queries over plain LDP are not supported for table "aiModel".');
              }
              if (resource === aiProvider) return [jsonClone(providerRow)];
              return [];
            },
            where: () => ({
              execute: async () => resource === credential ? [jsonClone(credentialRow)] : [],
            }),
          }),
        }),
        findById: async (resource: unknown, id: string) => {
          if (resource === aiProvider && id === 'openai.ttl') return jsonClone(providerRow);
          if (resource === aiModel && id === selectedModel) {
            return { id: selectedModel, status: 'active', displayName: 'GPT-5' };
          }
          return null;
        },
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).resolves.toEqual([expect.objectContaining({
      selectedModels: [expect.objectContaining({
        id: 'gpt-5',
        provider: 'openai',
        displayName: 'GPT-5',
      })],
    })]);
  });

  it('hydrates selected models as offering-aware Pod resource references', async () => {
    const subscriptionModel = 'kimi-subscription-key.ttl#shared-model';
    const platformModel = 'kimi-api-platform.ttl#shared-model';
    const credentialRows = await Promise.all([
      ['credentials.ttl#kimi-subscription', 'subscription-key'],
      ['credentials.ttl#kimi-platform', 'api-platform'],
    ].map(async ([id, offeringId], priority) => {
      const credentialIri = `https://id.example/alice/settings/${id}`;
      return {
        id,
        owner: WEB_ID,
        provider: `kimi-${offeringId}.ttl`,
        service: 'ai',
        authMode: 'apiKey',
        status: 'active',
        encryptedSecret: JSON.stringify(await encryptedSecret('kimi', credentialIri, {
          type: 'apiKey',
          apiKey: `fixture-${offeringId}`,
        })),
        keyVersion: '1',
        metadata: { offeringId, priority, enabled: true, health: 'healthy' },
      };
    }));
    const rows = new Map<string, Record<string, unknown>>([
      ['kimi.ttl', { id: 'kimi.ttl', hasModel: [subscriptionModel, platformModel] }],
      [subscriptionModel, {
        id: subscriptionModel,
        displayName: 'Subscription Shared Model',
        isProvidedBy: 'kimi-subscription-key.ttl#this',
        status: 'active',
      }],
      [platformModel, {
        id: platformModel,
        displayName: 'Platform Shared Model',
        isProvidedBy: 'kimi-api-platform.ttl#this',
        status: 'active',
      }],
    ]);
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({ where: () => ({ execute: async () => jsonClone(credentialRows) }) }),
        }),
        findById: async (_resource: unknown, id: string) => jsonClone(rows.get(id) ?? null),
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        offeringId: 'subscription-key',
        selectedModels: [expect.objectContaining({
          id: 'shared-model',
          provider: 'kimi',
          offeringId: 'subscription-key',
          resourceId: subscriptionModel,
        })],
      }),
      expect.objectContaining({
        offeringId: 'api-platform',
        selectedModels: [expect.objectContaining({
          id: 'shared-model',
          provider: 'kimi',
          offeringId: 'api-platform',
          resourceId: platformModel,
        })],
      }),
    ]));

    const runtimeCredentials = await repository.listCredentials({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    });
    expect(runtimeCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({ offeringId: 'subscription-key', models: ['shared-model'] }),
        models: ['shared-model'],
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({ offeringId: 'api-platform', models: ['shared-model'] }),
        models: ['shared-model'],
      }),
    ]));
    expect(JSON.stringify(runtimeCredentials)).not.toContain('subscription-key:shared-model');
    expect(JSON.stringify(runtimeCredentials)).not.toContain('api-platform:shared-model');

    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry(),
      adapters: [],
      credentialRepository: repository,
    });
    const kimi = (await service.listProviderCredentialPools({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: {
        type: 'solid',
        webId: WEB_ID,
        internalInvocation: true,
      },
    })).find((provider) => provider.id === 'kimi');
    expect(kimi?.selectedModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'shared-model', offeringId: 'subscription-key', resourceId: subscriptionModel }),
      expect.objectContaining({ id: 'shared-model', offeringId: 'api-platform', resourceId: platformModel }),
    ]));
    expect(kimi?.selectedModels.map((model) => model.id)).toEqual(['shared-model', 'shared-model']);
  });

  it('hydrates a custom compatible Offering selection from its per-credential Provider resource', async () => {
    const credentialId = 'credentials.ttl#custom-timicc';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const localPodBaseUrl = 'https://pod.example/alice/';
    const providerInstance = `custom-instance-${encodeURIComponent(credentialId)}`;
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: `${providerInstance}.ttl`,
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('custom', credentialIri, {
        type: 'apiKey',
        apiKey: 'fixture-custom-key',
      })),
      keyVersion: '1',
      metadata: { offeringId: 'openai-compatible', enabled: true, health: 'healthy' },
    };
    const selectedModel = `${localPodBaseUrl}settings/providers/${providerInstance}.ttl#gpt-custom`;
    const persistedModelId = decodeURIComponent(`${providerInstance}.ttl#gpt-custom`);
    const providerRow = {
      id: `${providerInstance}.ttl#this`,
      hasModel: [selectedModel],
    };
    const exactProviderReads: string[] = [];
    const repository = new PodConnectedCredentialRepository({
      providerIds: ['custom'],
      podBaseUrlResolver: async () => localPodBaseUrl,
      podAccess: {
        getPodFetch: async () => async () => new Response(null, { status: 404 }),
      },
      dbFactory: async ({ aiProvider, aiModel }) => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: (resource: unknown) => ({
            execute: async () => {
              if (resource === aiProvider) return [jsonClone(providerRow)];
              if (resource === aiModel) return [{ id: persistedModelId, status: 'active' }];
              return [];
            },
            where: () => ({ execute: async () => [jsonClone(row)] }),
          }),
        }),
        findById: async (resource: unknown, id: string) => {
          if (resource === aiProvider) exactProviderReads.push(id);
          return null;
        },
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials({
      webId: WEB_ID,
      provider: 'custom',
      deployment: 'cloud',
      auth: INTERNAL_INVOCATION_AUTH,
    })).resolves.toEqual([expect.objectContaining({
      provider: providerInstance,
      selectedModels: [expect.objectContaining({
        id: 'gpt-custom',
        provider: 'custom',
        offeringId: 'openai-compatible',
      })],
    })]);
    await expect(repository.listCredentials({
      webId: WEB_ID,
      deployment: 'cloud',
      auth: INTERNAL_INVOCATION_AUTH,
    })).resolves.toEqual([expect.objectContaining({ provider: 'custom' })]);
    expect(exactProviderReads).toEqual([]);
  });

  it('does not exact-read undeclared custom Provider instance documents when collection queries are unsupported', async () => {
    const credentialId = 'credentials.ttl#custom-exact-provider';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const localPodBaseUrl = 'https://pod.example/alice/';
    const providerInstance = `custom-instance-${encodeURIComponent(credentialId)}`;
    const persistedModelId = decodeURIComponent(`${providerInstance}.ttl#gpt-custom`);
    const credentialRow = {
      id: credentialId,
      owner: WEB_ID,
      provider: `${providerInstance}.ttl`,
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('custom', credentialIri, {
        type: 'apiKey',
        apiKey: 'fixture-custom-key',
      })),
      keyVersion: '1',
      metadata: { offeringId: 'openai-compatible', enabled: true, health: 'healthy' },
    };
    const exactProviderReads: string[] = [];
    const repository = new PodConnectedCredentialRepository({
      providerIds: ['custom'],
      podBaseUrlResolver: async () => localPodBaseUrl,
      podAccess: {
        getPodFetch: async () => async () => new Response(null, { status: 404 }),
      },
      dbFactory: async ({ credential, aiProvider, aiModel }) => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: (resource: unknown) => ({
            execute: async () => {
              if (resource === aiProvider) {
                throw new Error('Document-mode collection queries over plain LDP are not supported for table "aiProvider".');
              }
              if (resource === aiModel) {
                return [{ id: persistedModelId, status: 'active' }];
              }
              return [];
            },
            where: () => ({
              execute: async () => resource === credential ? [jsonClone(credentialRow)] : [],
            }),
          }),
        }),
        findById: async (resource: unknown, id: string) => {
          if (resource === aiProvider) {
            exactProviderReads.push(id);
            if (id.startsWith('custom-instance-')) {
              throw new Error('hosted_pod_resource_not_allowed');
            }
          }
          return null;
        },
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials({
      webId: WEB_ID,
      provider: 'custom',
      deployment: 'cloud',
      auth: INTERNAL_INVOCATION_AUTH,
    })).resolves.toEqual([expect.objectContaining({
      provider: providerInstance,
    })]);
    expect(exactProviderReads).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^custom-instance-/u),
    ]));
  });

  it('hydrates only active selected model references and excludes missing or unreadable refs', async () => {
    const credentialId = 'credentials.ttl#kimi-api-platform';
    const credentialIri = `https://id.example/alice/settings/${credentialId}`;
    const activeModel = 'kimi-api-platform.ttl#active-chat';
    const inactiveModel = 'kimi-api-platform.ttl#inactive-chat';
    const unavailableModel = 'kimi-api-platform.ttl#unavailable-chat';
    const missingModel = 'kimi-api-platform.ttl#missing-chat';
    const unreadableModel = 'kimi-api-platform.ttl#unreadable-chat';
    const row = {
      id: credentialId,
      owner: WEB_ID,
      provider: 'kimi-api-platform.ttl',
      service: 'ai',
      authMode: 'apiKey',
      status: 'active',
      encryptedSecret: JSON.stringify(await encryptedSecret('kimi', credentialIri, {
        type: 'apiKey',
        apiKey: 'fixture-kimi-key',
      })),
      keyVersion: '1',
      metadata: { offeringId: 'api-platform', enabled: true, health: 'healthy' },
    };
    const rows = new Map<string, Record<string, unknown>>([
      ['kimi.ttl', { id: 'kimi.ttl', hasModel: [activeModel, inactiveModel, unavailableModel, missingModel, unreadableModel] }],
      [activeModel, { id: activeModel, displayName: 'Active Chat', status: 'active' }],
      [inactiveModel, { id: inactiveModel, status: 'inactive' }],
      [unavailableModel, { id: unavailableModel, status: 'unavailable' }],
    ]);
    const repository = new PodConnectedCredentialRepository({
      podAccess: { getPodFetch: async () => fetch },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({ where: () => ({ execute: async () => [jsonClone(row)] }) }),
        }),
        findById: async (_resource: unknown, id: string) => {
          if (id === unreadableModel) throw new Error('unreadable');
          return jsonClone(rows.get(id) ?? null);
        },
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'cloud',
    }))).resolves.toEqual([expect.objectContaining({
      selectedModels: [{
        id: 'active-chat',
        provider: 'kimi',
        offeringId: 'api-platform',
        resourceId: activeModel,
        displayName: 'Active Chat',
      }],
    })]);
  });

  it('reports a capability error when the Pod has no collection query sidecar', async () => {
    const repository = new PodConnectedCredentialRepository({
      podAccess: {
        getPodFetch: vi.fn(async () => fetch),
      },
      dbFactory: async () => ({
        init: vi.fn(),
        insert: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({
              execute: async () => {
                throw new Error('Document-mode collection queries over plain LDP are not supported for table "credential".');
              },
            }),
          }),
        }),
        findById: async () => null,
        updateById: vi.fn(),
        update: vi.fn(),
      } as any),
    });

    await expect(repository.listProviderCredentials(withInternalAuth({
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'cloud',
    }))).rejects.toThrow('credential_collection_query_unsupported');
    await expect(repository.listCredentials(withInternalAuth({
      webId: WEB_ID,
      deployment: 'cloud',
    }))).rejects.toThrow('credential_collection_query_unsupported');
  });
});

function jsonClone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}


describe('owned API key credential replacement', () => {
  async function replacementFixture() {
    const repository = new RecordingCredentialRepository();
    const credentialVault = vault();
    const service = new ProviderConnectService({ registry: createDefaultProviderRegistry(), credentialRepository: repository, vault: credentialVault, adapters: [] });
    const created = await service.createApiKeyCredential({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi', offeringId: 'api-platform', apiKey: 'old-private-key', label: 'Owned', baseUrl: 'https://api.moonshot.ai/v1', priority: 7 });
    Object.assign(repository.rows[0], { enabled: false, health: 'reauthRequired', reauthRequired: true, failCount: 3, lastFailureCode: '401', lastFailureAt: new Date('2026-10-01'), rateLimitResetAt: new Date('2026-10-02') });
    repository.rows[0].metadata = { ...repository.rows[0].metadata, custom: 'user-value', health: 'reauthRequired', enabled: false };
    const query = { webId: WEB_ID, deployment: 'cloud' as const, provider: 'kimi', credentialId: created.id, expectedVersion: created.version! };
    const replace = (apiKey: string, changes: Partial<typeof query> = {}) => service.updateCredential({ ...query, ...changes, patch: { apiKey } as Parameters<ProviderConnectService['updateCredential']>[0]['patch'] & { apiKey: string } });
    return { repository, credentialVault, service, query, replace };
  }
  it.each([false, true])('replaces encrypted secret on the same CAS record and preserves enabled=%s without fake recovery', async enabled => {
    const f = await replacementFixture(); f.repository.rows[0].enabled = enabled; f.repository.rows[0].metadata!.enabled = enabled; const before = structuredClone(f.repository.rows[0]);
    const result = await f.replace('next-private-key'); const row = f.repository.rows[0];
    expect(await f.credentialVault.open({ webId: WEB_ID }, row.credentialIri, row.provider, row.encryptedSecret)).toEqual({ type: 'apiKey', apiKey: 'next-private-key' });
    expect(row).toMatchObject({ id: before.id, offeringId: before.offeringId, provider: before.provider, enabled, health: enabled ? 'unknown' : 'disabled', priority: 7, accountLabel: 'Owned', version: before.version! + 1, reauthRequired: false, failCount: 0 });
    expect(row.lastFailureCode).toBeUndefined(); expect(row.lastFailureAt).toBeUndefined(); expect(row.rateLimitResetAt).toBeUndefined();
    expect(row.metadata).toMatchObject({ custom: 'user-value', baseUrl: 'https://api.moonshot.ai/v1', enabled });
    expect(JSON.stringify(result)).not.toMatch(/old-private-key|next-private-key|encryptedSecret/);
  });
  it('does not replace or falsely recover a metadata-only update', async () => {
    const f = await replacementFixture(); const before = structuredClone(f.repository.rows[0]);
    await f.service.updateCredential({ ...f.query, patch: { label: 'Renamed' } });
    expect(f.repository.rows[0]).toMatchObject({ encryptedSecret: before.encryptedSecret, health: before.health, reauthRequired: true, failCount: 3, lastFailureCode: '401' });
  });
  it.each(['', '   '])('rejects an explicitly empty key without mutating the record', async key => {
    const f = await replacementFixture(); const before = structuredClone(f.repository.rows);
    await expect(f.replace(key)).rejects.toThrow(); expect(f.repository.rows).toEqual(before);
  });
  it('rejects replacing a non API-key credential without changing it', async () => {
    const f = await replacementFixture(); f.repository.rows[0].authMode = 'deviceCodeOAuth'; const before = structuredClone(f.repository.rows);
    await expect(f.replace('next-private-key')).rejects.toThrow(); expect(f.repository.rows).toEqual(before);
  });
  it('preserves the record on CAS conflict or a different owner/provider lookup', async () => {
    const f = await replacementFixture(); const before = structuredClone(f.repository.rows);
    await expect(f.replace('next-private-key', { expectedVersion: f.query.expectedVersion + 1 })).rejects.toThrow('credential_version_conflict');
    expect(await f.replace('next-private-key', { webId: 'https://other.example/profile#me' })).toBeUndefined();
    expect(await f.replace('next-private-key', { provider: 'openai' })).toBeUndefined();
    expect(f.repository.rows).toEqual(before);
  });
});

describe('ProviderConnectService use-time session renewal', () => {
  const FUTURE = '2099-01-01T00:00:00.000Z';
  const PAST = '2020-01-01T00:00:00.000Z';
  const KIMI_IRI = 'https://id.example/alice/settings/credentials.ttl#kimi-session';
  // Marks a credential as proven imported by the existing import contract, which is the only
  // case allowed to adopt a rotated live CLI session.
  const IMPORTED_FINGERPRINT = 'imported-session-fingerprint';

  function renewalService(
    repository: RecordingCredentialRepository,
    options: { localSessionImporters?: ProviderConnectServiceOptions['localSessionImporters'] } = {},
  ): ProviderConnectService {
    return new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      credentialRepository: repository,
      vault: vault(),
      adapters: [],
      localSessionImporters: options.localSessionImporters ?? [],
    });
  }

  function connectResult(oauthCredential: Record<string, unknown>): ConnectBeginResult {
    return {
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      offeringId: 'subscription-key',
      deployment: 'local',
      oauthCredential,
    } as unknown as ConnectBeginResult;
  }

  async function seedCredential(
    repository: RecordingCredentialRepository,
    secret: ProviderSecret,
    overrides: Partial<ConnectCredentialRecord> = {},
  ): Promise<ConnectCredentialRecord> {
    return repository.createCredential({
      id: 'kimi-session',
      credentialIri: KIMI_IRI,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'local',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await encryptedSecret('kimi', KIMI_IRI, secret),
      status: 'active',
      accountLabel: 'Kimi Subscription',
      offeringId: 'subscription-key',
      priority: 7,
      enabled: true,
      health: 'healthy',
      scopes: ['openid', 'profile'],
      metadata: { source: 'local-kimi-code-credentials-json', offeringId: 'subscription-key', userSetting: 'keep-me' },
      ...overrides,
    });
  }

  function renewInput(overrides: Record<string, unknown> = {}) {
    return {
      webId: WEB_ID,
      deployment: 'local' as const,
      provider: 'kimi',
      credentialId: 'kimi-session',
      reason: 'expired' as const,
      ...overrides,
    };
  }

  async function storedSecret(repository: RecordingCredentialRepository): Promise<ProviderSecret> {
    const row = repository.rows[0];
    return vault().open({ webId: WEB_ID }, row.credentialIri, 'kimi', row.encryptedSecret);
  }

  it('leaves a session that is still valid untouched', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'valid-access', refreshToken: 'valid-refresh', expiresAt: FUTURE,
    });
    const service = renewalService(repository);
    const refresh = vi.spyOn(service, 'refreshCallerOwned');

    await expect(service.renewCredential(renewInput())).resolves.toBe(false);

    expect(refresh).not.toHaveBeenCalled();
    expect(repository.rows[0].version).toBe(1);
  });

  it('refreshes an expired session once on the same row and preserves user settings', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'expired-access', refreshToken: 'stored-refresh', expiresAt: PAST,
    });
    const service = renewalService(repository);
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue(connectResult({
      accessToken: 'renewed-access', refreshToken: 'renewed-refresh', expiresAt: FUTURE,
    }));

    await expect(service.renewCredential(renewInput({ observedVersion: 1 }))).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(repository.rows).toHaveLength(1);
    const row = repository.rows[0];
    expect(row).toMatchObject({
      id: 'kimi-session',
      credentialIri: KIMI_IRI,
      accountLabel: 'Kimi Subscription',
      priority: 7,
      enabled: true,
      reauthRequired: false,
      health: 'healthy',
      metadata: expect.objectContaining({ userSetting: 'keep-me', source: 'local-kimi-code-credentials-json' }),
    });
    expect(row.version).toBeGreaterThan(1);
    await expect(storedSecret(repository)).resolves.toMatchObject({
      accessToken: 'renewed-access', refreshToken: 'renewed-refresh',
    });
    expect(JSON.stringify(row)).not.toMatch(/renewed-access|renewed-refresh/u);
  });

  it('re-reads a rotated local session source on demand without calling the provider refresh', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'stale-access', refreshToken: 'stale-refresh',
      accountId: 'kimi-account', importedSessionFingerprint: IMPORTED_FINGERPRINT, expiresAt: PAST,
    });
    const importSession = vi.fn(async () => ({
      secret: {
        type: 'deviceCodeOAuth', accessToken: 'rotated-access', refreshToken: 'rotated-refresh',
        accountId: 'kimi-account', scope: 'openid profile', expiresAt: FUTURE,
      },
      credentialAuthMode: 'deviceCodeOAuth' as const,
    }));
    const service = renewalService(repository, {
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned');

    await expect(service.renewCredential(renewInput())).resolves.toBe(true);

    expect(importSession).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(repository.rows).toHaveLength(1);
    await expect(storedSecret(repository)).resolves.toMatchObject({
      accessToken: 'rotated-access', refreshToken: 'rotated-refresh',
    });
  });

  it('never adopts a live session that belongs to a different subscriber', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'stale-access', refreshToken: 'stale-refresh',
      accountId: 'kimi-account', importedSessionFingerprint: IMPORTED_FINGERPRINT, expiresAt: PAST,
    });
    const importSession = vi.fn(async () => ({
      secret: {
        type: 'deviceCodeOAuth', accessToken: 'other-subscriber-access', refreshToken: 'other-subscriber-refresh',
        accountId: 'other-account', expiresAt: FUTURE,
      },
      credentialAuthMode: 'deviceCodeOAuth' as const,
    }));
    const service = renewalService(repository, {
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue(connectResult({
      accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresAt: FUTURE,
    }));

    await expect(service.renewCredential(renewInput())).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(repository.rows)).not.toMatch(/other-subscriber-access|other-subscriber-refresh/u);
    await expect(storedSecret(repository)).resolves.toMatchObject({ accessToken: 'refreshed-access' });
  });

  it('does not adopt a live session that narrows the granted scopes', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'stale-access', refreshToken: 'stale-refresh',
      accountId: 'kimi-account', scope: 'openid profile',
      importedSessionFingerprint: IMPORTED_FINGERPRINT, expiresAt: PAST,
    });
    const importSession = vi.fn(async () => ({
      secret: {
        type: 'deviceCodeOAuth', accessToken: 'narrowed-access', refreshToken: 'narrowed-refresh',
        accountId: 'kimi-account', scope: 'openid', expiresAt: FUTURE,
      },
      credentialAuthMode: 'deviceCodeOAuth' as const,
    }));
    const service = renewalService(repository, {
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue(connectResult({
      accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresAt: FUTURE,
    }));

    await expect(service.renewCredential(renewInput())).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(storedSecret(repository)).resolves.toMatchObject({ accessToken: 'refreshed-access' });
  });

  it('coalesces concurrent renewals into a single provider refresh', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'expired-access', refreshToken: 'stored-refresh', expiresAt: PAST,
    });
    const service = renewalService(repository);
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return connectResult({ accessToken: 'renewed-access', refreshToken: 'renewed-refresh', expiresAt: FUTURE });
    });

    const results = await Promise.all([
      service.renewCredential(renewInput({ observedVersion: 1 })),
      service.renewCredential(renewInput({ observedVersion: 1 })),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(repository.rows).toHaveLength(1);
    // Both callers must be told to reload: the first performed the refresh, the second observes
    // the version change and must also retry with the freshly stored credential.
    expect(results).toEqual([true, true]);
    await expect(storedSecret(repository)).resolves.toMatchObject({ accessToken: 'renewed-access' });
  });

  it('surfaces a typed reauth requirement when the refresh token is rejected', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'expired-access', refreshToken: 'revoked-refresh', expiresAt: PAST,
    });
    const service = renewalService(repository);
    vi.spyOn(service, 'refreshCallerOwned').mockRejectedValue(new Error('OAuth refresh failed: invalid_grant'));

    await expect(service.renewCredential(renewInput())).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 401,
    });

    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0].reauthRequired).toBe(true);
  });

  it('does not renew API-key credentials', async () => {
    const repository = new RecordingCredentialRepository();
    const apiKeyIri = 'https://id.example/alice/settings/credentials.ttl#deepseek-key';
    await repository.createCredential({
      id: 'deepseek-key',
      credentialIri: apiKeyIri,
      webId: WEB_ID,
      provider: 'deepseek',
      deployment: 'local',
      authMode: 'apiKey',
      encryptedSecret: await encryptedSecret('deepseek', apiKeyIri, { type: 'apiKey', apiKey: 'sk-deepseek' }),
      status: 'active',
      enabled: true,
      health: 'healthy',
    });
    const service = renewalService(repository);
    const refresh = vi.spyOn(service, 'refreshCallerOwned');

    await expect(service.renewCredential({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'deepseek',
      credentialId: 'deepseek-key',
      reason: 'authentication_failed',
    })).resolves.toBe(false);

    expect(refresh).not.toHaveBeenCalled();
    expect(repository.rows[0].version).toBe(1);
  });

  it('does not renew a deliberately disabled credential', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'expired-access', refreshToken: 'stored-refresh', expiresAt: PAST,
    }, { enabled: false, health: 'disabled' });
    const service = renewalService(repository);
    const refresh = vi.spyOn(service, 'refreshCallerOwned');

    await expect(service.renewCredential(renewInput())).resolves.toBe(false);

    expect(refresh).not.toHaveBeenCalled();
    expect(repository.rows[0].version).toBe(1);
  });

  it('never adopts the host CLI session for a separately device-authorized credential', async () => {
    const repository = new RecordingCredentialRepository();
    // No importedSessionFingerprint: this grant was authorized by the device flow, not imported
    // from the host CLI, so it must not silently inherit whatever session the CLI now holds.
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'device-access', refreshToken: 'device-refresh',
      accountId: 'kimi-account', expiresAt: PAST,
    });
    const importSession = vi.fn(async () => ({
      secret: {
        type: 'deviceCodeOAuth', accessToken: 'host-file-access', refreshToken: 'host-file-refresh',
        accountId: 'kimi-account', scope: 'openid profile', expiresAt: FUTURE,
      },
      credentialAuthMode: 'deviceCodeOAuth' as const,
    }));
    const service = renewalService(repository, {
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue(connectResult({
      accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresAt: FUTURE,
    }));

    await expect(service.renewCredential(renewInput())).resolves.toBe(true);

    expect(importSession).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(storedSecret(repository)).resolves.toMatchObject({ accessToken: 'refreshed-access' });
  });

  it('does not treat an unchanged rejected file token as a renewal and refreshes instead', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'rejected-access', refreshToken: 'stored-refresh',
      accountId: 'kimi-account', importedSessionFingerprint: IMPORTED_FINGERPRINT, expiresAt: PAST,
    });
    const importSession = vi.fn(async () => ({
      secret: {
        type: 'deviceCodeOAuth', accessToken: 'rejected-access', refreshToken: 'stored-refresh',
        accountId: 'kimi-account', scope: 'openid profile', expiresAt: FUTURE,
      },
      credentialAuthMode: 'deviceCodeOAuth' as const,
    }));
    const service = renewalService(repository, {
      localSessionImporters: [{ provider: 'kimi', offeringId: 'subscription-key', importSession }],
    });
    const refresh = vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue(connectResult({
      accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh', expiresAt: FUTURE,
    }));

    await expect(service.renewCredential(renewInput({ reason: 'authentication_failed' }))).resolves.toBe(true);

    expect(importSession).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(storedSecret(repository)).resolves.toMatchObject({ accessToken: 'refreshed-access' });
  });

  it('refuses to persist an unchanged token when the refresh returns the rejected session', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'rejected-access', refreshToken: 'stored-refresh', expiresAt: PAST,
    });
    const service = renewalService(repository);
    vi.spyOn(service, 'refreshCallerOwned').mockResolvedValue(connectResult({
      accessToken: 'rejected-access', refreshToken: 'stored-refresh', expiresAt: FUTURE,
    }));

    await expect(service.renewCredential(renewInput({ reason: 'authentication_failed' }))).resolves.toBe(false);

    expect(repository.rows[0].version).toBe(1);
    await expect(storedSecret(repository)).resolves.toMatchObject({ accessToken: 'rejected-access' });
  });

  it('marks only the selected credential when its refresh token is rejected', async () => {
    const repository = new RecordingCredentialRepository();
    await seedCredential(repository, {
      type: 'deviceCodeOAuth', accessToken: 'expired-access', refreshToken: 'revoked-refresh', expiresAt: PAST,
    });
    const otherIri = 'https://id.example/alice/settings/credentials.ttl#kimi-other';
    await repository.createCredential({
      id: 'kimi-other',
      credentialIri: otherIri,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'local',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await encryptedSecret('kimi', otherIri, {
        type: 'deviceCodeOAuth', accessToken: 'other-access', refreshToken: 'other-refresh', expiresAt: FUTURE,
      }),
      status: 'active',
      enabled: true,
      health: 'healthy',
      offeringId: 'subscription-key',
      metadata: { userSetting: 'keep-other' },
    });
    const service = renewalService(repository);
    vi.spyOn(service, 'refreshCallerOwned').mockRejectedValue(new Error('OAuth refresh failed: invalid_grant'));

    await expect(service.renewCredential(renewInput())).rejects.toMatchObject({
      code: 'credential_unavailable',
      status: 401,
    });

    const selected = repository.rows.find((row) => row.id === 'kimi-session');
    const sibling = repository.rows.find((row) => row.id === 'kimi-other');
    expect(selected?.reauthRequired).toBe(true);
    expect(sibling?.reauthRequired).toBeFalsy();
    expect(sibling?.version).toBe(2);
  });
});

describe('ProviderConnectService + AiGatewayService integrated session renewal', () => {
  const FUTURE = '2099-01-01T00:00:00.000Z';
  const PAST = '2020-01-01T00:00:00.000Z';
  const KIMI_IRI = 'https://id.example/alice/settings/credentials.ttl#kimi-session';
  const OLD_ACCESS = 'kimi-old-access';
  const NEW_ACCESS = 'kimi-new-access';
  const GATEWAY_AUTH: AuthContext = {
    type: 'solid',
    webId: WEB_ID,
    viaGatewayApiKey: true,
    scopes: ['models:read', 'inference:write'],
  };

  function localRegistry() {
    return createDefaultProviderRegistry({ products: providerProductsForDeployment('local') });
  }

  function gatewayBody() {
    return { model: 'kimi-k2', messages: [{ role: 'user', content: 'hello' }], stream: true };
  }

  /**
   * Real vault + real Pod repository + real ProviderConnectService + real AiGatewayService. Only
   * the upstream OAuth token exchange is stubbed (no billing); `vault.open` genuinely decrypts the
   * stored secret so the token the runtime receives reflects the stored row, not a constant mock.
   */
  async function integratedFixture(options: { expiresAt: string }) {
    const repository = new RecordingCredentialRepository();
    const credentialVault = vault();
    await repository.createCredential({
      id: 'kimi-session',
      credentialIri: KIMI_IRI,
      webId: WEB_ID,
      provider: 'kimi',
      deployment: 'local',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await credentialVault.seal({ webId: WEB_ID }, KIMI_IRI, 'kimi', {
        type: 'deviceCodeOAuth',
        accessToken: OLD_ACCESS,
        refreshToken: 'kimi-refresh',
        expiresAt: options.expiresAt,
      }),
      status: 'active',
      enabled: true,
      health: 'healthy',
      offeringId: 'subscription-key',
      scopes: ['openid'],
      priority: 7,
      metadata: { userSetting: 'keep-me' },
      expiresAt: new Date(options.expiresAt),
    });

    const connect = new ProviderConnectService({
      registry: localRegistry(),
      credentialRepository: repository,
      vault: credentialVault,
      adapters: [],
    });
    const refresh = vi.spyOn(connect, 'refreshCallerOwned').mockResolvedValue({
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      offeringId: 'subscription-key',
      deployment: 'local',
      oauthCredential: { accessToken: NEW_ACCESS, refreshToken: 'kimi-refresh-2', expiresAt: FUTURE },
    } as unknown as ConnectBeginResult);

    const store: GatewayCredentialStore = {
      listCredentials: async ({ webId, deployment }) => repository.rows
        .filter((row) => row.webId === webId
          && row.deployment === deployment
          && row.status === 'active'
          && row.enabled !== false
          && row.reauthRequired !== true)
        .map((row) => ({
          id: row.id,
          credentialIri: row.credentialIri,
          provider: row.provider,
          authMode: row.authMode,
          enabled: row.enabled ?? true,
          priority: row.priority ?? 100,
          models: ['kimi-k2'],
          health: 'healthy' as const,
          quota: { status: 'available' as const },
          encryptedSecret: row.encryptedSecret,
          version: row.version,
          expiresAt: row.expiresAt,
        } as StoredGatewayCredential)),
      renewCredential: (input) => connect.renewCredential({
        webId: input.webId,
        deployment: input.deployment as 'local' | 'cloud',
        provider: input.provider,
        credentialId: input.credentialId,
        observedVersion: input.observedVersion,
        reason: input.reason,
        auth: input.auth,
      }),
    };

    const forwarded: string[] = [];
    const execute = vi.fn((input: { apiKey: string }) => (async function* () {
      forwarded.push(input.apiKey);
      if (input.apiKey !== NEW_ACCESS) {
        throw Object.assign(new Error('upstream rejected the credential'), { status: 401 });
      }
      yield { type: 'response.started', id: 'resp_1' };
      yield { type: 'text.delta', text: 'ok' };
      yield { type: 'response.completed', finishReason: 'stop' };
    })());

    const service = new AiGatewayService({
      deployment: 'local',
      registry: localRegistry(),
      router: new ModelRouter({
        registry: localRegistry(),
        affinityStore: new InMemorySessionAffinityStore({ secret: '0123456789abcdef0123456789abcdef' }),
        credentials: store.listCredentials,
        now: () => new Date('2026-07-23T00:00:00.000Z'),
      }),
      credentials: store,
      vault: credentialVault,
      runtimes: { get: () => ({ execute }) } as unknown as ProviderRuntimeRegistry,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    return {
      repository,
      service,
      execute,
      forwarded,
      refresh,
      row: () => repository.rows[0],
    };
  }

  async function run(service: AiGatewayService, signal?: AbortSignal): Promise<void> {
    const execution = await service.execute({
      auth: GATEWAY_AUTH,
      protocol: 'chatCompletions',
      body: gatewayBody(),
      signal,
    });
    for await (const _event of execution.events) {
      // Drain so the failover loop, renewal and usage accounting actually run.
    }
  }

  it('forwards the renewed token, not the stale one, after the upstream rejects the old session', async () => {
    const fixture = await integratedFixture({ expiresAt: FUTURE });

    await run(fixture.service);

    // The first attempt used the stored token; the retry must carry the token the vault now opens,
    // which is only true when the route credential was replaced by the renewed row.
    expect(fixture.forwarded).toEqual([OLD_ACCESS, NEW_ACCESS]);
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.row().version).toBeGreaterThan(1);
    const stored = await vault().open({ webId: WEB_ID }, KIMI_IRI, 'kimi', fixture.row().encryptedSecret);
    expect(stored.accessToken).toBe(NEW_ACCESS);
  });

  it('serves two concurrent requests from a single shared renewal', async () => {
    const fixture = await integratedFixture({ expiresAt: PAST });

    await Promise.all([run(fixture.service), run(fixture.service)]);

    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.forwarded.filter((token) => token === NEW_ACCESS)).toHaveLength(2);
    expect(fixture.row().version).toBeGreaterThan(1);
  });

  it('does not renew or call upstream for a request that is already aborted', async () => {
    const fixture = await integratedFixture({ expiresAt: PAST });
    const controller = new AbortController();
    controller.abort();

    await expect(run(fixture.service, controller.signal)).rejects.toThrow(/aborted/iu);

    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('detaches only the cancelled waiter while another caller keeps the shared renewal', async () => {
    const fixture = await integratedFixture({ expiresAt: PAST });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.refresh.mockImplementation(async () => {
      await gate;
      return {
        mode: 'deviceCodeOAuth',
        status: 'completed',
        provider: 'kimi',
        offeringId: 'subscription-key',
        deployment: 'local',
        oauthCredential: { accessToken: NEW_ACCESS, refreshToken: 'kimi-refresh-2', expiresAt: FUTURE },
      } as unknown as ConnectBeginResult;
    });

    const controller = new AbortController();
    const cancelled = run(fixture.service, controller.signal).then(() => undefined, (error: unknown) => error);
    const survivor = run(fixture.service);
    // Let both callers reach the shared renewal before cancelling one of them.
    await Promise.resolve();
    controller.abort();
    release();

    const error = await cancelled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/aborted/iu);
    await survivor;

    // One refresh for two callers; the cancelled waiter emits no upstream request, the other does.
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(fixture.forwarded).toEqual([NEW_ACCESS]);
  });
});
