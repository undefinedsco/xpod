import { describe, expect, it, vi } from 'vitest';

import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import {
  AuthorizationCodeConnectAdapter,
  BrowserAssistedApiKeyConnectAdapter,
  DeviceCodeConnectAdapter,
  InMemoryConnectAttemptStore,
  ProviderConnectService,
  type AuthorizationCodeCallbackReceiver,
  type AuthorizationCodeOAuthIntegration,
  type ConnectBeginResult,
  type ConnectCredentialRecord,
  type DeviceCodeOAuthIntegration,
  type PodCredentialRepository,
} from '../../../src/api/ai-gateway/connect';
import { createDefaultProviderRegistry, providerProductsForDeployment } from '../../../src/api/ai-gateway/providers/ProviderRegistry';

const WEB_ID = 'https://id.example/alice/profile/card#me';

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

  public async listProviderCredentials(): Promise<ConnectCredentialRecord[]> {
    return this.rows.map((row) => structuredClone(row));
  }

  public async getCredentialById(input: { credentialId: string }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) => candidate.id === input.credentialId);
    return row ? structuredClone(row) : undefined;
  }

  public async createCredential(record: Omit<ConnectCredentialRecord, 'id'> & { id?: string }): Promise<ConnectCredentialRecord> {
    const stored = structuredClone({ ...record, id: record.id ?? `credential-${this.rows.length + 1}`, version: this.rows.length + 1 });
    this.rows.push(stored);
    return stored;
  }

  public async updateCredential(input: { credentialId: string; patch: Partial<ConnectCredentialRecord> }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) => candidate.id === input.credentialId);
    if (!row) return undefined;
    Object.assign(row, input.patch, { version: (row.version ?? 0) + 1 });
    return structuredClone(row);
  }

  public async revokeCredential(input: { credentialId: string }): Promise<ConnectCredentialRecord | undefined> {
    const row = this.rows.find((candidate) => candidate.id === input.credentialId);
    if (!row) return undefined;
    row.status = 'revoked';
    return structuredClone(row);
  }

  public async upsertConnectedCredential(record: ConnectCredentialRecord): Promise<ConnectCredentialRecord> {
    const stored = structuredClone({ ...record, version: this.rows.length + 1 });
    this.rows.push(stored);
    return stored;
  }

  public async markReauthRequired(): Promise<ConnectCredentialRecord | undefined> {
    return undefined;
  }

  public async disconnect(): Promise<ConnectCredentialRecord | undefined> {
    return undefined;
  }
}

class FakeCallbackReceiver implements AuthorizationCodeCallbackReceiver {
  public registrations: Array<{
    redirectUris: string[];
    state: string;
    expiresAt: Date;
    onCallback(result: { code?: string; error?: string }): Promise<void> | void;
    close: ReturnType<typeof vi.fn>;
  }> = [];

  public async register(input: {
    redirectUris: string[];
    state: string;
    expiresAt: Date;
    onCallback(result: { code?: string; error?: string }): Promise<void> | void;
  }): Promise<{ redirectUri: string; close(): void }> {
    const close = vi.fn();
    this.registrations.push({ ...input, close });
    return { redirectUri: input.redirectUris[0], close };
  }
}

function vault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new StaticKeyWrapper() });
}

function openAiDeviceOAuthIntegration(): DeviceCodeOAuthIntegration {
  return {
    provider: 'openai',
    offeringId: 'official-subscription',
    mode: 'deviceCodeOAuth',
    integrationId: 'openai-device-public',
    issuedBy: 'openai/codex',
    clientId: 'app-openai-public-client',
    accountLabel: 'OpenAI Subscription',
    protocol: {
      id: 'device-code-json',
      verificationUriOrigins: ['https://auth.openai.com'],
      begin: {
        endpoint: 'https://auth.openai.com/oauth/device/code',
        codec: 'deviceCodeJson',
      },
      poll: {
        endpoint: 'https://auth.openai.com/oauth/device/poll',
        codec: 'deviceCodeJson',
      },
      refresh: {
        endpoint: 'https://auth.openai.com/oauth/token',
        codec: 'refreshTokenForm',
      },
    },
  };
}

function openAiBrowserOAuthIntegration(): AuthorizationCodeOAuthIntegration {
  return {
    provider: 'openai',
    offeringId: 'official-subscription',
    mode: 'authorizationCodeOAuth',
    integrationId: 'openai-codex-browser-public',
    issuedBy: 'openai/codex',
    clientId: 'app-openai-public-client',
    accountLabel: 'OpenAI Subscription',
    protocol: {
      id: 'authorization-code-pkce-loopback',
      authorization: {
        endpoint: 'https://auth.openai.com/oauth/authorize',
        redirectUris: ['http://localhost:1455/auth/callback', 'http://localhost:1457/auth/callback'],
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        extraParams: {
          id_token_add_organizations: 'true',
          codex_cli_simplified_flow: 'true',
          originator: 'xpod',
        },
      },
      token: {
        endpoint: 'https://auth.openai.com/oauth/token',
        codec: 'authorizationCodeForm',
      },
      refresh: {
        endpoint: 'https://auth.openai.com/oauth/token',
        codec: 'refreshTokenForm',
      },
      accountIdClaim: ['https://api.openai.com/auth', 'chatgpt_account_id'],
    },
  };
}

function requireConnectAttempt(result: ConnectBeginResult): { attemptId: string; state: string; signature: string } {
  if (!result.attemptId || !result.state || !result.signature) {
    throw new Error(`Expected signed Connect attempt, got ${JSON.stringify(result)}`);
  }
  return { attemptId: result.attemptId, state: result.state, signature: result.signature };
}

function makeAdapter(options: {
  receiver?: FakeCallbackReceiver;
  fetch?: typeof fetch;
  attempts?: InMemoryConnectAttemptStore;
  repository?: RecordingCredentialRepository;
} = {}): { adapter: AuthorizationCodeConnectAdapter; receiver: FakeCallbackReceiver; repository: RecordingCredentialRepository } {
  const receiver = options.receiver ?? new FakeCallbackReceiver();
  const repository = options.repository ?? new RecordingCredentialRepository();
  return {
    receiver,
    repository,
    adapter: new AuthorizationCodeConnectAdapter({
      fetch: options.fetch ?? (async () => Response.json({ access_token: 'access', refresh_token: 'refresh' })) as typeof fetch,
      attempts: options.attempts ?? new InMemoryConnectAttemptStore(),
      credentialRepository: repository,
      vault: vault(),
      deployment: 'local',
      integration: openAiBrowserOAuthIntegration(),
      callbackReceiver: receiver,
      now: () => new Date('2026-09-08T00:00:00.000Z'),
      randomBytes: (() => {
        let value = 31;
        return () => Buffer.alloc(32, value++);
      })(),
      signingSecret: 'connect-signing-secret',
    }),
  };
}

describe('AuthorizationCodeConnectAdapter', () => {
  it('registers a loopback callback and builds an OpenAI authorization-code PKCE URL without exposing the verifier', async () => {
    const { adapter, receiver } = makeAdapter();

    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      authorizationMethodId: 'browser-oauth',
      requestedMode: 'authorizationCodeOAuth',
    });

    expect(receiver.registrations).toHaveLength(1);
    expect(receiver.registrations[0]).toMatchObject({
      redirectUris: ['http://localhost:1455/auth/callback', 'http://localhost:1457/auth/callback'],
      state: begun.state,
      expiresAt: new Date('2026-09-08T00:15:00.000Z'),
    });
    expect(begun).toMatchObject({
      mode: 'authorizationCodeOAuth',
      status: 'pending',
      provider: 'openai',
      offeringId: 'official-subscription',
      pkceChallenge: expect.any(String),
    });
    expect(JSON.stringify(begun)).not.toContain('codeVerifier');
    const authorizationUrl = new URL(begun.authorizationUrl!);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('app-openai-public-client');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(authorizationUrl.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(authorizationUrl.searchParams.get('originator')).toBe('xpod');
  });

  it('waits for the browser callback before exchanging the authorization code once', async () => {
    const calls: RequestInit[] = [];
    const { adapter, receiver } = makeAdapter({
      fetch: (async (_url: string, init?: RequestInit) => {
        calls.push(init ?? {});
        return Response.json({
          access_token: 'openai-access-token',
          refresh_token: 'openai-refresh-token',
          expires_in: 3600,
        });
      }) as typeof fetch,
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      requestedMode: 'authorizationCodeOAuth',
    });
    const attempt = requireConnectAttempt(begun);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    })).resolves.toMatchObject({ status: 'authorization_pending', mode: 'authorizationCodeOAuth' });
    expect(calls).toHaveLength(0);

    await receiver.registrations[0].onCallback({ code: 'browser-auth-code' });
    const completed = await adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    });

    expect(completed).toMatchObject({
      mode: 'authorizationCodeOAuth',
      status: 'completed',
      oauthCredential: {
        accessToken: 'openai-access-token',
        refreshToken: 'openai-refresh-token',
        offeringId: 'official-subscription',
        authorizationMethodId: 'browser-oauth',
      },
    });
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(String(calls[0].body))).toMatchObject(expect.any(URLSearchParams));
    const body = new URLSearchParams(String(calls[0].body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('browser-auth-code');
    expect(body.get('client_id')).toBe('app-openai-public-client');
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(receiver.registrations[0].close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(completed)).not.toContain('browser-auth-code');
    expect(JSON.stringify(completed)).not.toContain(body.get('code_verifier')!);

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    })).rejects.toThrow(/already consumed/i);
  });

  it('cancels the signed attempt and closes the loopback registration', async () => {
    const { adapter, receiver } = makeAdapter();
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      requestedMode: 'authorizationCodeOAuth',
    });

    await expect(adapter.cancel({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...requireConnectAttempt(begun),
    })).resolves.toMatchObject({ status: 'cancelled', mode: 'authorizationCodeOAuth' });
    expect(receiver.registrations[0].close).toHaveBeenCalledTimes(1);
  });

  it('does not consume an authorization-code attempt as completed when token exchange returns malformed success', async () => {
    const { adapter, receiver } = makeAdapter({
      fetch: (async () => Response.json({})) as typeof fetch,
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      requestedMode: 'authorizationCodeOAuth',
    });
    const attempt = requireConnectAttempt(begun);
    await receiver.registrations[0].onCallback({ code: 'browser-auth-code' });

    await expect(adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    })).rejects.toThrow(/access_token/i);
    await expect(adapter.status({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    })).resolves.toMatchObject({ mode: 'authorizationCodeOAuth', status: 'denied' });
    expect(receiver.registrations[0].close).toHaveBeenCalledTimes(1);
  });

  it('lets ProviderConnectService route authorization-code polling by signed attempt when mode is omitted', async () => {
    const attempts = new InMemoryConnectAttemptStore();
    const receiver = new FakeCallbackReceiver();
    const repository = new RecordingCredentialRepository();
    const { adapter } = makeAdapter({ attempts, receiver, repository });
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      adapters: [
        new BrowserAssistedApiKeyConnectAdapter({
          provider: 'openai',
          consoleUrl: 'https://platform.openai.com/api-keys',
          attempts,
          credentialRepository: repository,
          vault: vault(),
          deployment: 'local',
          signingSecret: 'connect-signing-secret',
        }),
        adapter,
      ],
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      requestedMode: 'authorizationCodeOAuth',
    });

    await expect(service.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...requireConnectAttempt(begun),
    })).resolves.toMatchObject({ mode: 'authorizationCodeOAuth', status: 'authorization_pending' });
  });

  it('does not deliver an OAuth credential when the attempt is cancelled during token exchange', async () => {
    let resolveExchange: (response: Response) => void = () => undefined;
    const exchangeStarted = vi.fn();
    const exchangeResponse = new Promise<Response>((resolve) => { resolveExchange = resolve; });
    const { adapter, receiver } = makeAdapter({
      fetch: (async () => {
        exchangeStarted();
        return exchangeResponse;
      }) as typeof fetch,
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      requestedMode: 'authorizationCodeOAuth',
    });
    const attempt = requireConnectAttempt(begun);
    const input = {
      webId: WEB_ID,
      deployment: 'local' as const,
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    };
    await receiver.registrations[0].onCallback({ code: 'browser-auth-code' });

    const poll = adapter.pollDevice(input);
    await vi.waitFor(() => expect(exchangeStarted).toHaveBeenCalledTimes(1));
    await expect(adapter.cancel(input)).resolves.toMatchObject({ status: 'cancelled' });
    resolveExchange(Response.json({
      access_token: 'late-access-token',
      refresh_token: 'late-refresh-token',
      expires_in: 3600,
    }));

    await expect(poll).rejects.toThrow(/already consumed/i);
    expect(receiver.registrations[0].close).toHaveBeenCalledTimes(1);
  });

  it('does not deliver an OAuth credential when the attempt expires during token exchange', async () => {
    let now = new Date('2026-09-08T00:00:00.000Z');
    let resolveExchange: (response: Response) => void = () => undefined;
    const exchangeStarted = vi.fn();
    const exchangeResponse = new Promise<Response>((resolve) => { resolveExchange = resolve; });
    const receiver = new FakeCallbackReceiver();
    const adapter = new AuthorizationCodeConnectAdapter({
      fetch: (async () => {
        exchangeStarted();
        return exchangeResponse;
      }) as typeof fetch,
      attempts: new InMemoryConnectAttemptStore(),
      credentialRepository: new RecordingCredentialRepository(),
      vault: vault(),
      deployment: 'local',
      integration: openAiBrowserOAuthIntegration(),
      callbackReceiver: receiver,
      now: () => now,
      randomBytes: (() => {
        let value = 41;
        return () => Buffer.alloc(32, value++);
      })(),
      signingSecret: 'connect-signing-secret',
    });
    const begun = await adapter.begin({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      requestedMode: 'authorizationCodeOAuth',
    });
    const attempt = requireConnectAttempt(begun);
    await receiver.registrations[0].onCallback({ code: 'browser-auth-code' });

    const poll = adapter.pollDevice({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
      offeringId: 'official-subscription',
      ...attempt,
    });
    await vi.waitFor(() => expect(exchangeStarted).toHaveBeenCalledTimes(1));
    now = new Date('2026-09-08T00:16:00.000Z');
    resolveExchange(Response.json({
      access_token: 'late-access-token',
      refresh_token: 'late-refresh-token',
      expires_in: 3600,
    }));

    await expect(poll).rejects.toThrow(/expired/i);
    expect(receiver.registrations[0].close).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy device-code credentials on the device adapter when browser OAuth is registered first', async () => {
    const repository = new RecordingCredentialRepository();
    const sharedVault = vault();
    const credentialIri = 'https://id.example/alice/settings/credentials/openai.ttl#cloud-openai-oauth';
    repository.rows.push({
      id: 'cloud-openai-oauth',
      credentialIri,
      webId: WEB_ID,
      provider: 'openai',
      deployment: 'local',
      authMode: 'deviceCodeOAuth',
      encryptedSecret: await sharedVault.seal(
        { webId: WEB_ID },
        credentialIri,
        'openai',
        { type: 'deviceCodeOAuth', refreshToken: 'legacy-device-refresh' },
      ),
      status: 'active',
      offeringId: 'official-subscription',
      version: 1,
    });
    const browserRefresh = vi.fn(async () => Response.json({ error: 'wrong_adapter' }, { status: 500 }));
    const deviceRefresh = vi.fn(async () => Response.json({
      access_token: 'device-access-next',
      refresh_token: 'device-refresh-next',
      expires_in: 3600,
    }));
    const attempts = new InMemoryConnectAttemptStore();
    const service = new ProviderConnectService({
      registry: createDefaultProviderRegistry({ products: providerProductsForDeployment('local') }),
      adapters: [
        new AuthorizationCodeConnectAdapter({
          fetch: browserRefresh as typeof fetch,
          attempts,
          credentialRepository: repository,
          vault: sharedVault,
          deployment: 'local',
          integration: openAiBrowserOAuthIntegration(),
          callbackReceiver: new FakeCallbackReceiver(),
          signingSecret: 'connect-signing-secret',
        }),
        new DeviceCodeConnectAdapter({
          fetch: deviceRefresh as typeof fetch,
          attempts,
          credentialRepository: repository,
          vault: sharedVault,
          deployment: 'local',
          integration: openAiDeviceOAuthIntegration(),
          signingSecret: 'connect-signing-secret',
        }),
      ],
      credentialRepository: repository,
      vault: sharedVault,
    });

    await expect(service.refresh({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'openai',
    })).resolves.toMatchObject({ id: 'cloud-openai-oauth', authMode: 'deviceCodeOAuth' });
    expect(browserRefresh).not.toHaveBeenCalled();
    expect(deviceRefresh).toHaveBeenCalledTimes(1);
    expect(repository.rows.at(-1)?.metadata?.authorizationMethodId).toBeUndefined();
  });
});
