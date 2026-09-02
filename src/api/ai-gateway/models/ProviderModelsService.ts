import type { GatewayDeployment } from '../auth/InvocationTokenCodec';
import type { AuthContext } from '../../auth/AuthContext';
import type { PodCredentialRepository } from '../connect';
import type { CredentialVault } from '../credentials/CredentialVault';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import { normalizeProvider } from '../quota/ProviderQuotaAdapter';
import {
  type DiscoveredProviderModel,
  type ModelsCredentialRecord,
  type ProviderModelDiscoverySource,
  type ProviderModelsAdapter,
  ProviderModelsFetchError,
  ProviderModelsResponseError,
} from './ProviderModelsAdapter';

export interface ProviderModelDiscovery {
  provider: string;
  credential: string;
  models: DiscoveredProviderModel[];
  observedAt: string;
  source: string;
}

export interface ProviderModelsServiceOptions {
  vault: CredentialVault;
  adapters: ProviderModelsAdapter[];
  providerRegistry?: ProviderRegistry;
  credentialRepository?: PodCredentialRepository;
  credentials?: ModelsCredentialRecord[];
  now?: () => Date;
}

export class ProviderModelsService {
  private readonly vault: CredentialVault;
  private readonly adapters = new Map<string, ProviderModelsAdapter>();
  private readonly protocolHandlers = new Map<string, ProviderModelsAdapter>();
  private readonly providerRegistry?: ProviderRegistry;
  private readonly credentialRepository?: PodCredentialRepository;
  private readonly credentials: ModelsCredentialRecord[];
  private readonly now: () => Date;

  public constructor(options: ProviderModelsServiceOptions) {
    this.vault = options.vault;
    this.providerRegistry = options.providerRegistry;
    this.credentialRepository = options.credentialRepository;
    this.credentials = options.credentials ?? [];
    this.now = options.now ?? (() => new Date());
    for (const adapter of options.adapters) {
      if (adapter.provider) this.adapters.set(normalizeProvider(adapter.provider), adapter);
      if (adapter.protocol && !this.protocolHandlers.has(adapter.protocol)) {
        this.protocolHandlers.set(adapter.protocol, adapter);
      }
    }
  }

  public async list(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    credentialIri?: string;
    auth?: AuthContext;
    signal?: AbortSignal;
  }): Promise<ProviderModelDiscovery> {
    const provider = normalizeProvider(input.provider);
    if (!this.providerRegistry && !this.adapters.has(provider)) {
      throw new Error(`models_adapter_not_found:${provider}`);
    }
    if (!input.credentialIri && this.credentialRepository) {
      return this.listAcrossCredentials({
        ...input,
        provider,
      });
    }
    const credential = await this.resolveCredential({
      webId: input.webId,
      deployment: input.deployment,
      provider,
      credentialIri: input.credentialIri,
      auth: input.auth,
    });
    const secret = await this.vault.open(
      { webId: input.webId },
      credential.credentialIri,
      provider,
      credential.encryptedSecret,
    );
    const models = await this.fetchModels(provider, credential, secret, input.signal);
    return {
      provider,
      credential: credential.credentialIri,
      models,
      observedAt: this.now().toISOString(),
      source: discoverySource(provider, credential.offeringId),
    };
  }

  public async listFromSecret(input: {
    webId: string;
    provider: string;
    offeringId?: string;
    credentialId: string;
    authMode?: ModelsCredentialRecord['authMode'];
    secret?: Record<string, unknown>;
    apiKey?: string;
    baseUrl?: string;
    proxyUrl?: string;
    compatibility?: 'auto' | 'openai' | 'anthropic';
    signal?: AbortSignal;
  }): Promise<ProviderModelDiscovery> {
    const provider = normalizeProvider(input.provider);
    if (!this.providerRegistry && !this.adapters.has(provider)) {
      throw new Error(`models_adapter_not_found:${provider}`);
    }
    const credential: ModelsCredentialRecord = {
        id: input.credentialId,
        credentialIri: input.credentialId,
        webId: input.webId,
        deployment: 'local',
        provider,
        offeringId: input.offeringId,
        authMode: input.authMode ?? 'apiKey',
        status: 'active',
        reauthRequired: false,
        encryptedSecret: {} as never,
        baseUrl: input.baseUrl,
        proxyUrl: input.proxyUrl,
        metadata: input.compatibility ? { compatibility: input.compatibility } : undefined,
      };
    const models = await this.fetchModels(
      provider,
      credential,
      normalizeCallerSuppliedModelsSecret(input),
      input.signal,
    );
    return {
      provider,
      credential: input.credentialId,
      models,
      observedAt: this.now().toISOString(),
      source: discoverySource(provider, input.offeringId),
    };
  }

  private async listAcrossCredentials(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    auth?: AuthContext;
    signal?: AbortSignal;
  }): Promise<ProviderModelDiscovery> {
    const source = `${input.provider}:/models`;
    const credentials = (await this.credentialRepository!.listProviderCredentials({
      webId: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      auth: input.auth,
    }))
      .filter(isEligibleCredential) as ModelsCredentialRecord[];
    if (credentials.length === 0) {
      throw new Error('models_credential_not_found');
    }

    const settled = await Promise.allSettled(credentials.map(async (credential) => {
      const secret = await this.vault.open(
        { webId: input.webId },
        credential.credentialIri,
        input.provider,
        credential.encryptedSecret,
      );
      return {
        credential,
        models: await this.fetchModels(input.provider, credential, secret, input.signal),
      };
    }));
    const merged = new Map<string, DiscoveredProviderModel>();
    const errors = new Map<string, ProviderModelDiscoverySource>();
    let firstFailure: unknown;

    settled.forEach((result, index) => {
      const credential = credentials[index];
      if (result.status === 'rejected') {
        firstFailure ??= result.reason;
        errors.set(credential.credentialIri, {
          credential: credential.credentialIri,
          source,
          status: 'error',
          error: errorMessage(result.reason),
        });
        return;
      }
      for (const model of result.value.models) {
        const credentialSource = discoverySource(input.provider, result.value.credential.offeringId);
        const existing = merged.get(model.id);
        const sources = [
          ...existing?.metadata?.sources ?? [],
          {
            credential: result.value.credential.credentialIri,
            source: credentialSource,
            status: 'available' as const,
          },
        ];
        merged.set(model.id, {
          ...model,
          ...optionalModelDetails(existing, model),
          availability: 'available',
          metadata: { sources },
        });
      }
    });

    for (const credential of credentials) {
      for (const modelId of selectedModelIdsFromMetadata(credential.metadata)) {
        const sourceEntry = errors.get(credential.credentialIri) ?? {
          credential: credential.credentialIri,
          source,
          status: 'unavailable' as const,
        };
        const existing = merged.get(modelId);
        if (existing) {
          merged.set(modelId, {
            ...existing,
            metadata: {
              sources: appendUniqueSource(existing.metadata?.sources ?? [], sourceEntry),
            },
          });
          continue;
        }
        merged.set(modelId, {
          id: modelId,
          availability: 'unavailable',
          metadata: { sources: [sourceEntry] },
        });
      }
    }

    const models = Array.from(merged.values());
    if (models.length === 0 && firstFailure) {
      throw firstFailure;
    }
    return {
      provider: input.provider,
      credential: firstSuccessfulCredential(settled, credentials)?.credentialIri ?? credentials[0].credentialIri,
      models,
      observedAt: this.now().toISOString(),
      source,
    };
  }

  private findAdapter(provider: string, credential: ModelsCredentialRecord): ProviderModelsAdapter {
    if (provider === 'custom') {
      const protocol = customModelsProtocol(credential);
      const handler = this.protocolHandlers.get(protocol);
      if (!handler) throw new Error(`models_protocol_handler_not_found:${protocol}`);
      return handler;
    }
    if (this.providerRegistry && credential.offeringId) {
      const offering = this.providerRegistry.requireOffering(provider, credential.offeringId);
      const capability = offering.upstream.find((candidate) => candidate.capability === 'models');
      if (!capability) throw new Error(`models_capability_not_found:${provider}/${credential.offeringId}`);
      const handler = this.protocolHandlers.get(capability.protocol);
      if (!handler) throw new Error(`models_protocol_handler_not_found:${capability.protocol}`);
      return handler;
    }
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`models_adapter_not_found:${provider}`);
    return adapter;
  }

  private async fetchModels(
    provider: string,
    credential: ModelsCredentialRecord,
    secret: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DiscoveredProviderModel[]> {
    if (provider === 'custom' && customCompatibility(credential) === 'auto') {
      const openai = this.protocolHandlers.get('openai-models');
      const anthropic = this.protocolHandlers.get('anthropic-models');
      if (!openai || !anthropic) throw new Error('models_protocol_handler_not_found:auto');
      try {
        return await openai.fetch({ credential, secret, signal });
      } catch (openaiError) {
        try {
          return await anthropic.fetch({ credential, secret, signal });
        } catch (anthropicError) {
          throw new ProviderModelsResponseError(
            `OpenAI compatible probe failed (${safeProtocolFailure(openaiError)}); `
            + `Anthropic compatible probe failed (${safeProtocolFailure(anthropicError)})`,
          );
        }
      }
    }
    return this.findAdapter(provider, credential).fetch({ credential, secret, signal });
  }

  private async resolveCredential(input: {
    webId: string;
    deployment: GatewayDeployment;
    provider: string;
    credentialIri?: string;
    auth?: AuthContext;
  }): Promise<ModelsCredentialRecord> {
    const listed = this.credentials.find((candidate) =>
      candidate.webId === input.webId
      && candidate.deployment === input.deployment
      && normalizeProvider(candidate.provider) === input.provider
      && (!input.credentialIri || candidate.credentialIri === input.credentialIri));
    if (listed) {
      return listed;
    }

    if (input.credentialIri && this.credentialRepository) {
      const exact = (await this.credentialRepository.listProviderCredentials({
        webId: input.webId,
        deployment: input.deployment,
        provider: input.provider,
        auth: input.auth,
      })).find((candidate) =>
        candidate.credentialIri === input.credentialIri
        && isEligibleCredential(candidate));
      if (exact) {
        return exact as ModelsCredentialRecord;
      }
      throw new Error('models_credential_not_found');
    }

    const active = await this.credentialRepository?.getActiveCredential({
      webId: input.webId,
      deployment: input.deployment,
      provider: input.provider,
      auth: input.auth,
    });
    if (
      active
      && (!input.credentialIri || active.credentialIri === input.credentialIri)
    ) {
      return active as ModelsCredentialRecord;
    }
    throw new Error('models_credential_not_found');
  }
}

function safeProtocolFailure(error: unknown): string {
  if (error instanceof ProviderModelsFetchError) return `HTTP ${error.providerStatus}`;
  if (error instanceof ProviderModelsResponseError) return 'provider response rejected';
  return 'connection failed';
}

function normalizeCallerSuppliedModelsSecret(input: {
  authMode?: ModelsCredentialRecord['authMode'];
  secret?: Record<string, unknown>;
  apiKey?: string;
}): Record<string, unknown> {
  if (input.authMode === 'local') return { type: 'local' };
  if (input.authMode === 'deviceCodeOAuth') {
    const accessToken = input.secret?.accessToken;
    return typeof accessToken === 'string' && accessToken.trim()
      ? { type: 'oauth', accessToken }
      : { type: 'oauth' };
  }
  const apiKey = typeof input.secret?.apiKey === 'string' && input.secret.apiKey.trim()
    ? input.secret.apiKey
    : input.apiKey;
  return typeof apiKey === 'string' && apiKey.trim()
    ? { type: 'apiKey', apiKey }
    : { type: 'apiKey' };
}

function discoverySource(provider: string, offeringId?: string): string {
  return offeringId ? `${provider}:${offeringId}:/models` : `${provider}:/models`;
}

function customModelsProtocol(credential: ModelsCredentialRecord): string {
  const compatibility = customCompatibility(credential);
  if (compatibility === 'anthropic' || credential.offeringId === 'anthropic-compatible') {
    return 'anthropic-models';
  }
  return 'openai-models';
}

function customCompatibility(credential: ModelsCredentialRecord): 'auto' | 'openai' | 'anthropic' {
  const compatibility = credential.metadata?.compatibility;
  if (compatibility === 'auto' || compatibility === 'openai' || compatibility === 'anthropic') {
    return compatibility;
  }
  return credential.offeringId === 'anthropic-compatible' ? 'anthropic' : 'openai';
}

function isEligibleCredential(credential: ModelsCredentialRecord): boolean {
  return credential.status === 'active'
    && credential.enabled !== false
    && credential.reauthRequired !== true
    && credential.health !== 'disabled'
    && credential.health !== 'reauthRequired';
}

function selectedModelIdsFromMetadata(metadata: Record<string, unknown> | undefined): string[] {
  const ids = new Set<string>();
  const models = metadata?.models;
  if (Array.isArray(models)) {
    for (const model of models) {
      if (typeof model === 'string' && model.trim()) {
        ids.add(model.trim());
      }
    }
  }
  const defaultModel = metadata?.defaultModel;
  if (typeof defaultModel === 'string' && defaultModel.trim()) {
    ids.add(defaultModel.trim());
  }
  return Array.from(ids);
}

function firstSuccessfulCredential(
  settled: Array<PromiseSettledResult<{ credential: ModelsCredentialRecord; models: DiscoveredProviderModel[] }>>,
  credentials: ModelsCredentialRecord[],
): ModelsCredentialRecord | undefined {
  const index = settled.findIndex((result) => result.status === 'fulfilled');
  return index === -1 ? undefined : credentials[index];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalModelDetails(
  existing: DiscoveredProviderModel | undefined,
  model: DiscoveredProviderModel,
): Pick<DiscoveredProviderModel, 'displayName' | 'capabilities'> {
  const displayName = existing?.displayName ?? model.displayName;
  const capabilities = existing?.capabilities ?? model.capabilities;
  return {
    ...(displayName ? { displayName } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function appendUniqueSource(
  sources: ProviderModelDiscoverySource[],
  source: ProviderModelDiscoverySource,
): ProviderModelDiscoverySource[] {
  if (
    source.status !== 'available'
    && sources.some((candidate) =>
      candidate.credential === source.credential
      && candidate.source === source.source
      && candidate.status === 'available')
  ) {
    return sources;
  }
  if (sources.some((candidate) =>
    candidate.credential === source.credential
    && candidate.source === source.source
    && candidate.status === source.status
    && candidate.error === source.error)) {
    return sources;
  }
  return [...sources, source];
}
