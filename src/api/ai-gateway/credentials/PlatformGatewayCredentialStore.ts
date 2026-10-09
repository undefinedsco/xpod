import type { GatewayCredentialStore, StoredGatewayCredential, GatewayCredentialHealthRecord, GatewayCredentialRenewalRequest } from '../AiGatewayService';
import { encodePlaintextCredential } from './PlaintextCredentialPayload';
import { normalizeProviderId, type ProviderRegistry } from '../providers/ProviderRegistry';
import { parseGatewayModelList } from '../models/GatewayModelProjection';
import type { GatewayModelProjection } from '../routing/ModelRouter';
import { ProviderHttpTransport } from '../../service/provider-http-transport';

export interface PlatformGatewayConfiguration {
  provider: string;
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

/** The existing DEFAULT_* deployment keys describe operator-owned service capacity. */
export function platformGatewayConfiguration(env: NodeJS.ProcessEnv = process.env): PlatformGatewayConfiguration | undefined {
  const apiKey = env.DEFAULT_API_KEY?.trim();
  const base = env.DEFAULT_API_BASE?.trim();
  if (!apiKey || !base) return undefined;
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('invalid_platform_provider_endpoint'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_platform_provider_endpoint');
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return {
    provider: `platform-${normalizeProviderId(env.DEFAULT_PROVIDER?.trim() || 'undefineds')}`,
    baseUrl: url.href.replace(/\/$/u, ''),
    apiKey,
    defaultModel: env.DEFAULT_MODEL?.trim() || undefined,
  };
}

export function registerPlatformGatewayProvider(registry: ProviderRegistry, config: PlatformGatewayConfiguration): void {
  registry.register({
    id: config.provider,
    label: 'Platform models',
    deploymentManaged: true,
    runtimeProtocol: 'openai-compatible',
    authModes: ['apiKey'],
    protocols: ['chatCompletions', 'responses', 'anthropic'],
    defaultBaseUrl: config.baseUrl,
    safeBaseUrls: [config.baseUrl],
    capabilities: { toolCalls: true },
    models: [],
  });
}

/**
 * Adds operator capacity through the same store used by model listing and inference.
 * Platform secrets and lifecycle state never enter the user's credential repository.
 */
export class PlatformGatewayCredentialStore implements GatewayCredentialStore {
  private readonly credentialId: string;
  private models: string[];
  private names: Record<string, string> = {};
  private projections: GatewayModelProjection[];
  private refreshedAt = 0;
  private refresh?: Promise<void>;
  private health: StoredGatewayCredential['health'] = 'healthy';
  private cooldownUntil?: Date;

  public constructor(private readonly options: {
    personal: GatewayCredentialStore;
    config: PlatformGatewayConfiguration;
    transport: ProviderHttpTransport;
    now?: () => number;
  }) {
    this.credentialId = `urn:xpod:platform-credential:${options.config.provider}`;
    this.models = options.config.defaultModel ? [options.config.defaultModel] : [];
    this.projections = this.models.map((id) => ({ id, object: 'model', owned_by: options.config.provider }));
  }

  public async listCredentials(input: Parameters<GatewayCredentialStore['listCredentials']>[0]): Promise<StoredGatewayCredential[]> {
    const [personal] = await Promise.all([this.options.personal.listCredentials(input), this.refreshModels()]);
    return [...personal, {
      id: this.credentialId,
      credentialIri: this.credentialId,
      provider: this.options.config.provider,
      source: 'platform',
      authMode: 'apiKey',
      enabled: true,
      priority: Number.MAX_SAFE_INTEGER,
      models: [...this.models],
      modelNames: { ...this.names },
      modelProjections: structuredClone(this.projections),
      defaultModel: this.options.config.defaultModel,
      health: this.health,
      cooldownUntil: this.cooldownUntil,
      storageMode: 'plaintext-v1',
      secretPayload: encodePlaintextCredential({ apiKey: this.options.config.apiKey }),
    }];
  }

  public async recordSuccess(input: GatewayCredentialHealthRecord): Promise<void> {
    if (!this.isPlatform(input)) await this.options.personal.recordSuccess?.(input);
    else {
      this.health = 'healthy';
      this.cooldownUntil = undefined;
    }
  }
  public async recordFailure(input: GatewayCredentialHealthRecord): Promise<void> {
    if (!this.isPlatform(input)) await this.options.personal.recordFailure?.(input);
    else if (input.status === 401) this.health = 'invalid';
    else if (input.status === 429 || (input.status !== undefined && input.status >= 500)) {
      this.cooldownUntil = input.rateLimitResetAt ?? new Date((this.options.now?.() ?? Date.now()) + 60_000);
    }
  }
  public async renewCredential(input: GatewayCredentialRenewalRequest): Promise<boolean> {
    return !this.isPlatform(input) && (await this.options.personal.renewCredential?.(input) ?? false);
  }
  public async rewrapCredential(input: Parameters<NonNullable<GatewayCredentialStore['rewrapCredential']>>[0]): Promise<boolean> {
    return input.credentialId !== this.credentialId && (await this.options.personal.rewrapCredential?.(input) ?? false);
  }
  private isPlatform(input: { credentialId: string; credentialIri: string }): boolean {
    return input.credentialId === this.credentialId || input.credentialIri === this.credentialId;
  }
  private async refreshModels(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (this.refreshedAt && now - this.refreshedAt < 60_000) return;
    if (!this.refresh) {
      this.refresh = this.discoverModels().finally(() => {
        this.refreshedAt = this.options.now?.() ?? Date.now();
        this.refresh = undefined;
      });
    }
    await this.refresh;
  }
  private async discoverModels(): Promise<void> {
    try {
      const body = await this.options.transport.getJson({
        url: `${this.options.config.baseUrl}/models`,
        headers: { authorization: `Bearer ${this.options.config.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!body || typeof body !== 'object' || !Array.isArray((body as { data?: unknown }).data)) {
        throw new Error('invalid_platform_models_response');
      }
      const models = parseGatewayModelList(body, { ownerOverride: this.options.config.provider });
      this.models = Array.from(new Set([
        ...models.map((model) => model.id),
        ...(this.options.config.defaultModel ? [this.options.config.defaultModel] : []),
      ]));
      this.names = Object.fromEntries(models.flatMap((model) => model.display_name ? [[model.id, model.display_name]] : []));
      this.projections = [...models];
      for (const id of this.models) {
        if (!this.projections.some((model) => model.id === id)) {
          this.projections.push({ id, object: 'model', owned_by: this.options.config.provider });
        }
      }
    } catch {
      // Keep the last successful discovery, or the explicitly configured default on first failure.
      // Upstream error bodies can contain service secrets and are deliberately not logged.
    }
  }
}
