import { createHash, createHmac, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { EncryptedCredentialSecret } from '../credentials/KeyWrapper';
import type { CredentialVault, GatewayPrincipal, ProviderSecret } from '../credentials/CredentialVault';
import type { GatewayDeployment } from '../auth/GatewayApiKey';
import type { ProviderRegistry } from '../providers/ProviderRegistry';

export type ConnectMode = 'browserAssistedApiKey' | 'deviceCodeOAuth' | 'connectUnsupported';
export type ConnectAttemptStatus =
  | 'pending'
  | 'authorization_pending'
  | 'slow_down'
  | 'completed'
  | 'expired'
  | 'unsupported';

export interface ConnectBeginInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  requestedMode: ConnectMode;
  expectedCredentialVersion?: number;
}

export interface ConnectBeginResult {
  mode: ConnectMode;
  status: ConnectAttemptStatus;
  provider: string;
  deployment: GatewayDeployment;
  attemptId?: string;
  state?: string;
  signature?: string;
  expiresAt?: string;
  authorizationUrl?: string;
  pkceChallenge?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  intervalSeconds?: number;
  apiKeyManagementSupported?: boolean;
  credentialId?: string;
  message?: string;
}

export interface CompleteApiKeyInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  attemptId: string;
  state: string;
  signature: string;
  apiKey: string;
  accountLabel?: string;
}

export interface PollDeviceInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  attemptId: string;
  state: string;
  signature: string;
}

export interface RefreshInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  refreshToken: string;
}

export interface RevokeInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
  refreshToken?: string;
}

export interface DisconnectInput {
  webId: string;
  deployment: GatewayDeployment;
  provider: string;
}

export interface ConnectCredentialRecord {
  id: string;
  credentialIri: string;
  webId: string;
  provider: string;
  deployment: GatewayDeployment;
  authMode: 'apiKey' | 'deviceCodeOAuth';
  encryptedSecret: EncryptedCredentialSecret;
  status: 'active' | 'revoked';
  accountLabel?: string;
  expiresAt?: Date;
  scopes?: string[];
  expectedVersion?: number;
  version?: number;
  reauthRequired?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PodCredentialRepository {
  upsertConnectedCredential(record: ConnectCredentialRecord): Promise<ConnectCredentialRecord>;
  markReauthRequired(input: {
    webId: string;
    provider: string;
    deployment: GatewayDeployment;
    reason: string;
  }): Promise<ConnectCredentialRecord | undefined>;
  disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined>;
}

export interface ProviderConnectAdapter {
  readonly provider: string;
  begin(input: ConnectBeginInput): Promise<ConnectBeginResult>;
  status?(input: PollDeviceInput): Promise<ConnectBeginResult>;
  completeApiKey?(input: CompleteApiKeyInput): Promise<ConnectBeginResult>;
  pollDevice?(input: PollDeviceInput): Promise<ConnectBeginResult>;
  refresh?(input: RefreshInput): Promise<ConnectCredentialRecord | undefined>;
  revoke?(input: RevokeInput): Promise<void>;
  disconnect?(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined>;
}

interface ConnectAttempt {
  id: string;
  provider: string;
  deployment: GatewayDeployment;
  webId: string;
  mode: ConnectMode;
  state: string;
  signature: string;
  expiresAt: Date;
  consumedAt?: Date;
  expectedCredentialVersion?: number;
  codeVerifier?: string;
  deviceCode?: string;
  intervalSeconds?: number;
}

export class InMemoryConnectAttemptStore {
  private readonly attempts = new Map<string, ConnectAttempt>();

  public async create(attempt: ConnectAttempt): Promise<ConnectAttempt> {
    this.attempts.set(attempt.id, cloneAttempt(attempt));
    return cloneAttempt(attempt);
  }

  public async get(id: string): Promise<ConnectAttempt | undefined> {
    const attempt = this.attempts.get(id);
    return attempt ? cloneAttempt(attempt) : undefined;
  }

  public async consume(id: string, now: Date): Promise<ConnectAttempt> {
    const attempt = this.attempts.get(id);
    if (!attempt) {
      throw new Error('Connect attempt not found');
    }
    if (attempt.consumedAt) {
      throw new Error('Connect attempt already consumed');
    }
    if (attempt.expiresAt.getTime() <= now.getTime()) {
      throw new Error('Connect attempt expired');
    }
    attempt.consumedAt = new Date(now);
    return cloneAttempt(attempt);
  }
}

export interface BrowserAssistedApiKeyConnectAdapterOptions {
  provider: string;
  consoleUrl: string;
  attempts: InMemoryConnectAttemptStore;
  credentialRepository: PodCredentialRepository;
  vault: CredentialVault;
  deployment: GatewayDeployment;
  now?: () => Date;
  randomBytes?: (bytes: number) => Buffer;
  signingSecret: string;
}

export class BrowserAssistedApiKeyConnectAdapter implements ProviderConnectAdapter {
  public readonly provider: string;
  private readonly consoleUrl: string;
  protected readonly attempts: InMemoryConnectAttemptStore;
  protected readonly credentialRepository: PodCredentialRepository;
  protected readonly vault: CredentialVault;
  protected readonly deployment: GatewayDeployment;
  protected readonly now: () => Date;
  protected readonly randomBytes: (bytes: number) => Buffer;
  private readonly signingSecret: string;

  public constructor(options: BrowserAssistedApiKeyConnectAdapterOptions) {
    this.provider = normalizeProvider(options.provider);
    this.consoleUrl = options.consoleUrl;
    this.attempts = options.attempts;
    this.credentialRepository = options.credentialRepository;
    this.vault = options.vault;
    this.deployment = options.deployment;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.signingSecret = options.signingSecret;
  }

  public async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    this.assertInput(input, 'browserAssistedApiKey');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
    const attempt = await this.createAttempt(input, expiresAt);
    const url = new URL(this.consoleUrl);
    url.searchParams.set('xpod_connect_attempt', attempt.id);
    url.searchParams.set('xpod_provider', this.provider);

    return {
      mode: 'browserAssistedApiKey',
      status: 'pending',
      provider: this.provider,
      deployment: this.deployment,
      attemptId: attempt.id,
      state: attempt.state,
      signature: attempt.signature,
      expiresAt: expiresAt.toISOString(),
      authorizationUrl: url.toString(),
    };
  }

  public async completeApiKey(input: CompleteApiKeyInput): Promise<ConnectBeginResult> {
    if (!input.apiKey.trim()) {
      throw new Error('API key is required');
    }
    const attempt = await this.loadValidAttempt(input, 'browserAssistedApiKey');
    const consumed = await this.attempts.consume(input.attemptId, this.now());
    const credentialIri = credentialIriFor(input.webId, input.deployment, this.provider);
    const encryptedSecret = await this.vault.seal(
      principal(input.webId),
      credentialIri,
      this.provider,
      { type: 'apiKey', apiKey: input.apiKey },
    );
    const record = await this.credentialRepository.upsertConnectedCredential({
      id: credentialIdFor(input.deployment, this.provider),
      credentialIri,
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
      authMode: 'apiKey',
      encryptedSecret,
      status: 'active',
      accountLabel: input.accountLabel,
      expectedVersion: consumed.expectedCredentialVersion,
    });

    return {
      mode: 'browserAssistedApiKey',
      status: 'completed',
      provider: this.provider,
      deployment: input.deployment,
      attemptId: attempt.id,
      credentialId: record.id,
    };
  }

  public async status(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadValidAttempt(input, 'browserAssistedApiKey');
    return {
      mode: attempt.mode,
      status: attempt.consumedAt ? 'completed' : 'pending',
      provider: this.provider,
      deployment: input.deployment,
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt.toISOString(),
    };
  }

  public async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    return this.credentialRepository.disconnect({
      webId: input.webId,
      provider: this.provider,
      deployment: input.deployment,
    });
  }

  protected async createAttempt(input: ConnectBeginInput, expiresAt: Date, extra: Partial<ConnectAttempt> = {}): Promise<ConnectAttempt> {
    const attemptWithoutSignature: Omit<ConnectAttempt, 'signature'> = {
      id: token(this.randomBytes),
      provider: this.provider,
      deployment: input.deployment,
      webId: input.webId,
      mode: input.requestedMode,
      state: token(this.randomBytes),
      expiresAt,
      expectedCredentialVersion: input.expectedCredentialVersion,
      ...extra,
    };
    const signature = signAttempt(attemptWithoutSignature, this.signingSecret);
    return this.attempts.create({ ...attemptWithoutSignature, signature });
  }

  protected async loadValidAttempt(input: PollDeviceInput, mode: ConnectMode): Promise<ConnectAttempt> {
    const attempt = await this.attempts.get(input.attemptId);
    if (!attempt) {
      throw new Error('Connect attempt not found');
    }
    if (attempt.webId !== input.webId) {
      throw new Error('Connect attempt is bound to a different WebID');
    }
    if (attempt.deployment !== input.deployment) {
      throw new Error('Connect attempt is bound to a different deployment');
    }
    if (attempt.provider !== normalizeProvider(input.provider)) {
      throw new Error('Connect attempt is bound to a different provider');
    }
    if (attempt.mode !== mode) {
      throw new Error('Connect attempt mode mismatch');
    }
    if (attempt.state !== input.state) {
      throw new Error('Invalid Connect attempt state');
    }
    if (attempt.signature !== input.signature || attempt.signature !== signAttempt(attempt, this.signingSecret)) {
      throw new Error('Invalid Connect attempt signature');
    }
    if (attempt.expiresAt.getTime() <= this.now().getTime()) {
      throw new Error('Connect attempt expired');
    }
    return attempt;
  }

  protected assertInput(input: ConnectBeginInput, mode: ConnectMode): void {
    if (normalizeProvider(input.provider) !== this.provider) {
      throw new Error('Connect provider mismatch');
    }
    if (input.deployment !== this.deployment) {
      throw new Error('Connect deployment mismatch');
    }
    if (input.requestedMode !== mode) {
      throw new Error('Unsupported Connect mode');
    }
    if (!input.webId) {
      throw new Error('Connect WebID is required');
    }
  }
}

export interface KimiDeviceCodeConnectAdapterOptions extends Omit<BrowserAssistedApiKeyConnectAdapterOptions, 'provider' | 'consoleUrl'> {
  fetch?: typeof fetch;
  clientId: string;
  deviceAuthorizationEndpoint?: string;
  tokenEndpoint?: string;
  revokeEndpoint?: string;
}

export class KimiDeviceCodeConnectAdapter extends BrowserAssistedApiKeyConnectAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly deviceAuthorizationEndpoint: string;
  private readonly tokenEndpoint: string;
  private readonly revokeEndpoint: string;

  public constructor(options: KimiDeviceCodeConnectAdapterOptions) {
    super({
      ...options,
      provider: 'kimi',
      consoleUrl: 'https://kimi.moonshot.cn/device',
    });
    this.fetchImpl = options.fetch ?? fetch;
    this.clientId = options.clientId;
    this.deviceAuthorizationEndpoint = options.deviceAuthorizationEndpoint ?? 'https://kimi.moonshot.cn/oauth/device/code';
    this.tokenEndpoint = options.tokenEndpoint ?? 'https://kimi.moonshot.cn/oauth/token';
    this.revokeEndpoint = options.revokeEndpoint ?? 'https://kimi.moonshot.cn/oauth/revoke';
    for (const endpoint of [this.deviceAuthorizationEndpoint, this.tokenEndpoint, this.revokeEndpoint]) {
      assertKimiEndpoint(endpoint);
    }
  }

  public override async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    this.assertInput(input, 'deviceCodeOAuth');
    const now = this.now();
    const verifier = token(this.randomBytes);
    const challenge = codeChallenge(verifier);
    const response = await this.fetchImpl(this.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw new Error(`Kimi device authorization failed: ${safeProviderError(body)}`);
    }
    const expiresIn = numberFrom(body.expires_in, 300);
    const attempt = await this.createAttempt(input, new Date(now.getTime() + expiresIn * 1000), {
      mode: 'deviceCodeOAuth',
      codeVerifier: verifier,
      deviceCode: stringFrom(body.device_code),
      intervalSeconds: numberFrom(body.interval, 5),
    });
    return {
      mode: 'deviceCodeOAuth',
      status: 'pending',
      provider: 'kimi',
      deployment: input.deployment,
      attemptId: attempt.id,
      state: attempt.state,
      signature: attempt.signature,
      expiresAt: attempt.expiresAt.toISOString(),
      pkceChallenge: challenge,
      deviceCode: attempt.deviceCode,
      userCode: stringFrom(body.user_code),
      verificationUri: stringFrom(body.verification_uri),
      verificationUriComplete: stringFrom(body.verification_uri_complete),
      intervalSeconds: attempt.intervalSeconds,
    };
  }

  public async pollDevice(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadValidAttempt(input, 'deviceCodeOAuth');
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: attempt.deviceCode ?? '',
        client_id: this.clientId,
        code_verifier: attempt.codeVerifier ?? '',
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      if (body.error === 'authorization_pending') {
        return pendingResult(input, 'authorization_pending');
      }
      if (body.error === 'slow_down') {
        return pendingResult(input, 'slow_down');
      }
      if (body.error === 'expired_token') {
        await this.attempts.consume(input.attemptId, this.nowForConsume());
        return pendingResult(input, 'expired');
      }
      throw new Error(`Kimi device token failed: ${safeProviderError(body)}`);
    }
    await this.attempts.consume(input.attemptId, this.nowForConsume());
    const record = await this.storeOAuthCredential(input, body, attempt.expectedCredentialVersion);
    return {
      mode: 'deviceCodeOAuth',
      status: 'completed',
      provider: 'kimi',
      deployment: input.deployment,
      attemptId: input.attemptId,
      credentialId: record.id,
    };
  }

  public override async status(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const attempt = await this.loadValidAttempt(input, 'deviceCodeOAuth');
    return {
      mode: 'deviceCodeOAuth',
      status: attempt.consumedAt ? 'completed' : 'pending',
      provider: 'kimi',
      deployment: input.deployment,
      attemptId: attempt.id,
      expiresAt: attempt.expiresAt.toISOString(),
      deviceCode: attempt.deviceCode,
      intervalSeconds: attempt.intervalSeconds,
    };
  }

  public async refresh(input: RefreshInput): Promise<ConnectCredentialRecord | undefined> {
    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: this.clientId,
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      return this.credentialRepository.markReauthRequired({
        webId: input.webId,
        provider: 'kimi',
        deployment: input.deployment,
        reason: safeProviderError(body),
      });
    }
    return this.storeOAuthCredential(input, body);
  }

  public async revoke(input: RevokeInput): Promise<void> {
    if (!input.refreshToken) {
      await this.credentialRepository.disconnect({
        webId: input.webId,
        provider: 'kimi',
        deployment: input.deployment,
      });
      return;
    }
    await this.fetchImpl(this.revokeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: input.refreshToken,
        client_id: this.clientId,
      }),
    });
    await this.credentialRepository.disconnect({
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
    });
  }

  public override async disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    return this.credentialRepository.disconnect({
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
    });
  }

  private nowForConsume(): Date {
    return this.now();
  }

  private async storeOAuthCredential(
    input: { webId: string; deployment: GatewayDeployment },
    body: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<ConnectCredentialRecord> {
    const credentialIri = credentialIriFor(input.webId, input.deployment, 'kimi');
    const expiresAt = expiresAtFrom(body.expires_in, this.now());
    const secret: ProviderSecret = {
      type: 'deviceCodeOAuth',
      accessToken: stringFrom(body.access_token),
      refreshToken: stringFrom(body.refresh_token),
      expiresAt: expiresAt?.toISOString(),
      scope: stringFrom(body.scope),
      idToken: stringFrom(body.id_token),
    };
    const encryptedSecret = await this.vault.seal(principal(input.webId), credentialIri, 'kimi', secret);
    return this.credentialRepository.upsertConnectedCredential({
      id: credentialIdFor(input.deployment, 'kimi'),
      credentialIri,
      webId: input.webId,
      provider: 'kimi',
      deployment: input.deployment,
      authMode: 'deviceCodeOAuth',
      encryptedSecret,
      status: 'active',
      expiresAt,
      expectedVersion,
      metadata: {
        authoritativeSubject: decodeJwtSubject(stringFrom(body.id_token)),
      },
    });
  }
}

export class DeepSeekConnectAdapter implements ProviderConnectAdapter {
  public readonly provider = 'deepseek';

  public async begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    if (normalizeProvider(input.provider) !== this.provider) {
      throw new Error('Connect provider mismatch');
    }
    return {
      mode: 'connectUnsupported',
      status: 'unsupported',
      provider: 'deepseek',
      deployment: input.deployment,
      apiKeyManagementSupported: true,
      message: 'DeepSeek does not expose a supported third-party browser Connect flow; use authenticated API key management.',
    };
  }
}

export interface ProviderConnectServiceOptions {
  registry: ProviderRegistry;
  adapters: ProviderConnectAdapter[];
}

export class ProviderConnectService {
  private readonly registry: ProviderRegistry;
  private readonly adapters = new Map<string, ProviderConnectAdapter>();

  public constructor(options: ProviderConnectServiceOptions) {
    this.registry = options.registry;
    for (const adapter of options.adapters) {
      this.adapters.set(normalizeProvider(adapter.provider), adapter);
    }
  }

  public begin(input: ConnectBeginInput): Promise<ConnectBeginResult> {
    const descriptor = this.registry.requireProvider(input.provider);
    if (descriptor.connect?.mode !== input.requestedMode) {
      throw new Error('Requested Connect mode does not match provider capability');
    }
    return this.requireAdapter(input.provider).begin(input);
  }

  public completeApiKey(input: CompleteApiKeyInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.completeApiKey) {
      throw new Error('Provider does not support API key Connect completion');
    }
    return adapter.completeApiKey(input);
  }

  public pollDevice(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.pollDevice) {
      throw new Error('Provider does not support device-code polling');
    }
    return adapter.pollDevice(input);
  }

  public status(input: PollDeviceInput): Promise<ConnectBeginResult> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.status) {
      throw new Error('Provider does not support Connect status');
    }
    return adapter.status(input);
  }

  public refresh(input: RefreshInput): Promise<ConnectCredentialRecord | undefined> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.refresh) {
      throw new Error('Provider does not support refresh');
    }
    return adapter.refresh(input);
  }

  public disconnect(input: DisconnectInput): Promise<ConnectCredentialRecord | undefined> {
    const adapter = this.requireAdapter(input.provider);
    if (!adapter.disconnect) {
      throw new Error('Provider does not support disconnect');
    }
    return adapter.disconnect(input);
  }

  private requireAdapter(provider: string): ProviderConnectAdapter {
    const adapter = this.adapters.get(normalizeProvider(provider));
    if (!adapter) {
      throw new Error(`No Connect adapter registered for ${provider}`);
    }
    return adapter;
  }
}

function token(randomBytes: (bytes: number) => Buffer): string {
  return randomBytes(32).toString('base64url');
}

function signAttempt(
  attempt: Pick<ConnectAttempt, 'id' | 'provider' | 'deployment' | 'webId' | 'mode' | 'state' | 'expiresAt'>,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify({
      id: attempt.id,
      provider: attempt.provider,
      deployment: attempt.deployment,
      webId: attempt.webId,
      mode: attempt.mode,
      state: attempt.state,
      expiresAt: attempt.expiresAt.toISOString(),
    }))
    .digest('base64url');
}

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function credentialIdFor(deployment: GatewayDeployment, provider: string): string {
  return `settings/ai/credentials/${normalizeProvider(provider)}.ttl#${deployment}-${normalizeProvider(provider)}`;
}

function credentialIriFor(webId: string, deployment: GatewayDeployment, provider: string): string {
  const base = webId.includes('/profile/') ? webId.slice(0, webId.indexOf('/profile/') + 1) : `${webId.replace(/[#/]+$/u, '')}/`;
  return new URL(credentialIdFor(deployment, provider), base).toString();
}

function principal(webId: string): GatewayPrincipal {
  return { webId };
}

function cloneAttempt(attempt: ConnectAttempt): ConnectAttempt {
  return {
    ...attempt,
    expiresAt: new Date(attempt.expiresAt),
    consumedAt: attempt.consumedAt ? new Date(attempt.consumedAt) : undefined,
  };
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function expiresAtFrom(expiresIn: unknown, now: Date): Date | undefined {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    return undefined;
  }
  return new Date(now.getTime() + expiresIn * 1000);
}

function safeProviderError(body: Record<string, unknown>): string {
  return stringFrom(body.error) || stringFrom(body.error_description) || 'provider_error';
}

function pendingResult(input: PollDeviceInput, status: ConnectAttemptStatus): ConnectBeginResult {
  return {
    mode: 'deviceCodeOAuth',
    status,
    provider: 'kimi',
    deployment: input.deployment,
    attemptId: input.attemptId,
  };
}

function assertKimiEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== 'kimi.moonshot.cn') {
    throw new Error('Kimi Connect endpoint is not allowlisted');
  }
}

function decodeJwtSubject(idToken: string): string | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof decoded.sub === 'string' ? decoded.sub : undefined;
  } catch {
    return undefined;
  }
}
