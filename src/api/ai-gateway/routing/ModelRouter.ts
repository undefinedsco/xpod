import { GatewayProtocolError } from '../errors';
import { customModelsFromMetadata, type CustomProviderModel } from '../connect';
import {
  normalizeProviderId,
  type ProviderAuthMode,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../providers/ProviderRegistry';
import {
  type SessionAffinityStore,
} from './SessionAffinityStore';
import type { AuthContext } from '../../auth/AuthContext';
import type { ProviderRuntimeCredential } from '../providers/ProviderRuntimeAdapter';
import { assertAllowedProviderEndpoint } from './ProviderEndpointPolicy';

export type GatewayCredentialHealth = 'healthy' | 'reauthRequired' | 'disabled' | 'error';
export type GatewayQuotaStatus = 'available' | 'unsupported' | 'exhausted' | 'error';
export type ModelRouteSource =
  | 'alias'
  | 'explicit-provider'
  | 'exact-model'
  | 'default-provider'
  | 'default-model';

export interface GatewayCredentialCandidate {
  id: string;
  credentialIri: string;
  provider: string;
  authMode: ProviderAuthMode;
  enabled: boolean;
  priority?: number;
  models?: string[];
  customModels?: CustomProviderModel[];
  defaultModel?: string;
  health?: GatewayCredentialHealth;
  quota?: {
    status: GatewayQuotaStatus;
  };
  cooldownUntil?: Date;
  runtimeCredential?: ProviderRuntimeCredential;
  runtimeCapabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface ModelRouterCredentialLookupInput {
  webId: string;
  deployment: string;
  auth?: AuthContext;
  provider?: string;
}

export interface ModelRouterOptions {
  registry: ProviderRegistry;
  affinityStore: SessionAffinityStore;
  credentials(input: ModelRouterCredentialLookupInput): Promise<GatewayCredentialCandidate[]>;
  defaultProvider?: string;
  defaultModel?: string;
  now?: () => Date;
}

export interface ModelRouteInput {
  webId: string;
  deployment: string;
  auth?: AuthContext;
  model?: string;
  conversationId?: string;
  explicitCredentialId?: string;
  rawPrompt?: string;
}

export interface ModelRouteFailoverState {
  allowedBeforeFirstEvent: boolean;
  committed: boolean;
  clientEventEmitted: boolean;
}

export interface ModelRouteResult {
  provider: ProviderDescriptor;
  model: string;
  credential: GatewayCredentialCandidate;
  source: ModelRouteSource;
  affinityKey?: string;
  failover: ModelRouteFailoverState;
}

interface ResolvedModelTarget {
  providerId: string;
  model: string;
  source: ModelRouteSource;
  provider?: ProviderDescriptor;
}

export class ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly affinityStore: SessionAffinityStore;
  private readonly credentials: ModelRouterOptions['credentials'];
  private readonly defaultProvider?: string;
  private readonly defaultModel?: string;
  private readonly now: () => Date;

  public constructor(options: ModelRouterOptions) {
    this.registry = options.registry;
    this.affinityStore = options.affinityStore;
    this.credentials = options.credentials;
    this.defaultProvider = options.defaultProvider ? normalizeProviderId(options.defaultProvider) : undefined;
    this.defaultModel = options.defaultModel;
    this.now = options.now ?? (() => new Date());
  }

  public async route(
    input: ModelRouteInput,
    excludeCredentialIds: ReadonlySet<string> = new Set(),
  ): Promise<ModelRouteResult> {
    const explicitProvider = input.model ? this.parseExplicitProviderModel(input.model)?.providerId : undefined;
    const candidates = await this.credentials({
      webId: input.webId,
      deployment: input.deployment,
      auth: input.auth,
      provider: explicitProvider,
    });
    const target = this.resolveTarget(input, candidates);
    const registeredProvider = target.provider ?? this.registry.requireProvider(target.providerId);
    const providerCandidates = candidates
      .filter((candidate) => normalizeProviderId(candidate.provider) === normalizeProviderId(registeredProvider.id))
      .filter((candidate) => !excludeCredentialIds.has(candidate.id) && !excludeCredentialIds.has(candidate.credentialIri));
    const selected = input.explicitCredentialId
      ? await this.selectExplicitCredential(input, providerCandidates, input.explicitCredentialId, target.model)
      : await this.selectCredential(input, providerCandidates, target);

    if (!selected) {
      throw new GatewayProtocolError('No usable credential is available for the requested model', {
        code: 'credential_unavailable',
        status: 403,
        details: {
          provider: registeredProvider.id,
          model: target.model,
        },
      });
    }

    if (input.conversationId && !input.explicitCredentialId) {
      await this.affinityStore.set({
        deployment: input.deployment,
        webId: input.webId,
        conversationId: input.conversationId,
        provider: registeredProvider.id,
        credentialId: selected.id,
      });
    }

    const credential = normalizeRuntimeCredentialBaseUrl(registeredProvider.id, selected);
    const provider = await this.resolveRuntimeProvider(registeredProvider, credential, input.deployment);
    return {
      provider,
      model: target.model,
      credential,
      source: target.source,
      affinityKey: input.conversationId ? this.affinityStore.affinityKey({
        deployment: input.deployment,
        webId: input.webId,
        conversationId: input.conversationId,
        provider: provider.id,
      }) : undefined,
      failover: {
        allowedBeforeFirstEvent: !input.explicitCredentialId,
        committed: false,
        clientEventEmitted: false,
      },
    };
  }

  private async resolveRuntimeProvider(
    provider: ProviderDescriptor,
    credential: GatewayCredentialCandidate,
    deployment: string,
  ): Promise<ProviderDescriptor> {
    const runtime = credential.runtimeCredential;
    const configuredBaseUrl = runtime?.baseUrl?.trim();
    if (!configuredBaseUrl) return provider;
    const baseUrl = normalizeProviderBaseUrl(provider.id, configuredBaseUrl);

    const allowPrivateNetwork = deployment === 'local';
    await assertAllowedProviderEndpoint(baseUrl, { allowPrivateNetwork });
    if (runtime?.proxy) {
      await assertAllowedProviderEndpoint(runtime.proxy, { allowPrivateNetwork });
    }

    const capabilities = new Set(credential.runtimeCapabilities ?? []);
    const protocols = [
      ...(capabilities.has('responses') ? ['responses' as const] : []),
      ...(capabilities.has('chat_completions') ? ['chatCompletions' as const] : []),
    ];
    return {
      ...provider,
      defaultBaseUrl: baseUrl,
      safeBaseUrls: [baseUrl],
      ...(protocols.length > 0 ? { protocols } : {}),
      capabilities: {
        ...provider.capabilities,
        toolCalls: capabilities.has('tool_calls'),
        imageInput: capabilities.has('image_input'),
        imageGeneration: capabilities.has('image_generation'),
        imageEditing: capabilities.has('image_editing'),
      },
    };
  }

  public markClientEventEmitted(route: ModelRouteResult): ModelRouteFailoverState {
    route.failover.clientEventEmitted = true;
    route.failover.committed = true;
    route.failover.allowedBeforeFirstEvent = false;
    return { ...route.failover };
  }

  public canFailOver(route: ModelRouteResult): boolean {
    return route.failover.allowedBeforeFirstEvent
      && !route.failover.committed
      && !route.failover.clientEventEmitted;
  }

  public async recordCooldown(input: {
    webId: string;
    deployment: string;
    credentialId: string;
    until: Date;
  }): Promise<void> {
    await this.affinityStore.setCooldown(input);
  }

  private resolveTarget(
    input: ModelRouteInput,
    candidates: GatewayCredentialCandidate[],
  ): ResolvedModelTarget {
    const requestedModel = input.model?.trim();
    if (requestedModel) {
      const alias = this.registry.resolveAlias(requestedModel);
      if (alias) {
        return {
          providerId: normalizeProviderId(alias.provider),
          model: alias.model,
          source: 'alias',
        };
      }

      const explicit = this.parseExplicitProviderModel(requestedModel);
      const dynamicCredential = explicit
        ? candidates.find((candidate) =>
          normalizeProviderId(candidate.provider) === explicit.providerId
          && typeof candidate.runtimeCredential?.baseUrl === 'string'
          && candidate.runtimeCredential.baseUrl.length > 0)
        : undefined;
      const dynamicBaseUrl = dynamicCredential?.runtimeCredential?.baseUrl;
      if (explicit && !this.registry.getProvider(explicit.providerId)) {
        const credential = dynamicCredential;
        const baseUrl = dynamicBaseUrl;
        if (!credential || !baseUrl) {
          throw new GatewayProtocolError('Unknown provider in explicit model route', {
            code: 'invalid_request',
            status: 400,
            details: {
              provider: explicit.providerId,
              model: explicit.model,
            },
          });
        }
        const runtimeCapabilities = new Set(credential.runtimeCapabilities ?? ['chat_completions']);
        const explicitCustomModel = (credential.customModels ?? customModelsFromMetadata(credential.metadata))
          .find((model) => model.id === explicit.model);
        const modelCapabilities = new Set(explicitCustomModel?.capabilities ?? []);
        const provider: ProviderDescriptor = {
          id: explicit.providerId,
          label: explicit.providerId,
          authModes: ['apiKey'],
          protocols: [
            ...(runtimeCapabilities.has('responses') ? ['responses' as const] : []),
            ...(runtimeCapabilities.has('chat_completions') ? ['chatCompletions' as const] : []),
          ],
          defaultBaseUrl: baseUrl,
          safeBaseUrls: [baseUrl],
          capabilities: {
            toolCalls: runtimeCapabilities.has('tool_calls'),
            imageInput: runtimeCapabilities.has('image_input'),
            imageGeneration: runtimeCapabilities.has('image_generation'),
            imageEditing: runtimeCapabilities.has('image_editing'),
          },
          models: [{
            id: explicit.model,
            ...(explicitCustomModel?.inputModalities?.length ? { inputModalities: explicitCustomModel.inputModalities } : {}),
            capabilities: {
              toolCalls: modelCapabilities.has('tool_calls'),
              imageInput: modelCapabilities.has('image_input'),
              imageGeneration: modelCapabilities.has('image_generation'),
              imageEditing: modelCapabilities.has('image_editing'),
            },
          }],
        };
        return {
          ...explicit,
          provider,
          source: 'explicit-provider',
        };
      }
      if (explicit) {
        return {
          ...explicit,
          source: 'explicit-provider',
        };
      }

      const exact = this.findExactModelTarget(requestedModel, candidates);
      if (exact) {
        return exact;
      }
    }

    const defaultProviderTarget = this.findDefaultProviderTarget(requestedModel, candidates);
    if (defaultProviderTarget) {
      return defaultProviderTarget;
    }

    const defaultModelTarget = this.findDefaultModelTarget(candidates);
    if (defaultModelTarget) {
      return defaultModelTarget;
    }

    throw new GatewayProtocolError('Unable to resolve model route', {
      code: 'invalid_request',
      status: 400,
      details: { model: input.model },
    });
  }

  private parseExplicitProviderModel(model: string): { providerId: string; model: string } | undefined {
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) {
      return undefined;
    }
    return {
      providerId: normalizeProviderId(model.slice(0, slash)),
      model: model.slice(slash + 1),
    };
  }

  private findExactModelTarget(
    model: string,
    candidates: GatewayCredentialCandidate[],
  ): ResolvedModelTarget | undefined {
    const registryMatches = this.registry.findModel(model);
    if (registryMatches.length > 0) {
      const candidateMatch = registryMatches.find((match) =>
        candidates.some((candidate) =>
          normalizeProviderId(candidate.provider) === normalizeProviderId(match.provider.id)
          && credentialSupportsModel(candidate, match.model.id)));
      const match = candidateMatch ?? registryMatches[0];
      return {
        providerId: normalizeProviderId(match.provider.id),
        model: match.model.id,
        source: 'exact-model',
      };
    }

    const candidate = candidates.find((item) => credentialSupportsModel(item, model));
    if (candidate) {
      return {
        providerId: normalizeProviderId(candidate.provider),
        model,
        source: 'exact-model',
      };
    }
    return undefined;
  }

  private findDefaultProviderTarget(
    requestedModel: string | undefined,
    candidates: GatewayCredentialCandidate[],
  ): ResolvedModelTarget | undefined {
    if (!this.defaultProvider || requestedModel) {
      return undefined;
    }
    const credential = candidates.find((item) => normalizeProviderId(item.provider) === this.defaultProvider);
    const model = this.defaultModel
      ?? credential?.defaultModel
      ?? credential?.models?.[0]
      ?? this.registry.requireProvider(this.defaultProvider).models[0]?.id;
    if (!model) {
      return undefined;
    }
    return {
      providerId: this.defaultProvider,
      model,
      source: this.defaultModel ? 'default-model' : 'default-provider',
    };
  }

  private findDefaultModelTarget(candidates: GatewayCredentialCandidate[]): ResolvedModelTarget | undefined {
    for (const candidate of candidates) {
      const model = candidate.defaultModel ?? candidate.models?.[0];
      if (model) {
        return {
          providerId: normalizeProviderId(candidate.provider),
          model,
          source: 'default-model',
        };
      }
    }
    for (const provider of this.registry.listProviders()) {
      const model = provider.models[0]?.id;
      if (model && candidates.some((candidate) => normalizeProviderId(candidate.provider) === normalizeProviderId(provider.id))) {
        return {
          providerId: normalizeProviderId(provider.id),
          model,
          source: 'default-model',
        };
      }
    }
    return undefined;
  }

  private async selectExplicitCredential(
    input: ModelRouteInput,
    candidates: GatewayCredentialCandidate[],
    credentialId: string,
    model: string,
  ): Promise<GatewayCredentialCandidate> {
    const selected = candidates.find((candidate) => candidate.id === credentialId || candidate.credentialIri === credentialId);
    if (!selected || !await this.isCredentialUsable(input, selected, model)) {
      throw new GatewayProtocolError('Requested credential is not available for this model', {
        code: 'credential_unavailable',
        status: 403,
        details: { credentialId },
      });
    }
    return selected;
  }

  private async selectCredential(
    input: ModelRouteInput,
    candidates: GatewayCredentialCandidate[],
    target: ResolvedModelTarget,
  ): Promise<GatewayCredentialCandidate | undefined> {
    const usable: GatewayCredentialCandidate[] = [];
    for (const candidate of candidates) {
      if (await this.isCredentialUsable(input, candidate, target.model)) {
        usable.push(candidate);
      }
    }
    usable.sort(compareCredentialPriority);

    if (input.conversationId) {
      const affinity = await this.affinityStore.get({
        deployment: input.deployment,
        webId: input.webId,
        conversationId: input.conversationId,
        provider: target.providerId,
      });
      const existing = affinity
        ? usable.find((candidate) => candidate.id === affinity.credentialId)
        : undefined;
      if (existing) {
        return existing;
      }
    }

    return usable[0];
  }

  private async isCredentialUsable(
    input: ModelRouteInput,
    candidate: GatewayCredentialCandidate,
    model: string,
  ): Promise<boolean> {
    if (!candidate.enabled) {
      return false;
    }
    if (candidate.health && candidate.health !== 'healthy') {
      return false;
    }
    if (candidate.quota?.status === 'exhausted') {
      return false;
    }
    const cooldownUntil = await this.effectiveCooldownUntil(input, candidate);
    if (cooldownUntil && cooldownUntil.getTime() > this.now().getTime()) {
      return false;
    }
    return credentialSupportsModel(candidate, model);
  }

  private async effectiveCooldownUntil(
    input: ModelRouteInput,
    candidate: GatewayCredentialCandidate,
  ): Promise<Date | undefined> {
    const storedCooldown = await this.affinityStore.getCooldown({
      deployment: input.deployment,
      webId: input.webId,
      credentialId: candidate.id,
    });
    const futureCooldowns = [ candidate.cooldownUntil, storedCooldown ]
      .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
    if (futureCooldowns.length === 0) {
      return undefined;
    }
    return futureCooldowns.reduce((latest, value) =>
      value.getTime() > latest.getTime() ? value : latest);
  }
}

function normalizeProviderBaseUrl(provider: string, value: string): string {
  if (normalizeProviderId(provider) !== 'openai') return value;
  const url = new URL(value);
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1';
  return url.href.replace(/\/$/u, '');
}

function normalizeRuntimeCredentialBaseUrl(
  provider: string,
  credential: GatewayCredentialCandidate,
): GatewayCredentialCandidate {
  const baseUrl = credential.runtimeCredential?.baseUrl?.trim();
  if (!baseUrl) return credential;
  const normalizedBaseUrl = normalizeProviderBaseUrl(provider, baseUrl);
  if (normalizedBaseUrl === baseUrl) return credential;
  return {
    ...credential,
    runtimeCredential: { ...credential.runtimeCredential, baseUrl: normalizedBaseUrl },
  };
}

function credentialSupportsModel(candidate: GatewayCredentialCandidate, model: string): boolean {
  const models = candidate.models ?? [];
  if (models.length === 0) {
    return true;
  }
  if (models.some((candidateModel) => candidateModel === model)) {
    return true;
  }
  const customModels = candidate.customModels ?? customModelsFromMetadata(candidate.metadata);
  return customModels.some((customModel) => customModel.id === model);
}

function compareCredentialPriority(
  left: GatewayCredentialCandidate,
  right: GatewayCredentialCandidate,
): number {
  return (left.priority ?? 100) - (right.priority ?? 100)
    || left.id.localeCompare(right.id);
}
