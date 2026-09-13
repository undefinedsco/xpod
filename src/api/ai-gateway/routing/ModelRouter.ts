import { GatewayProtocolError } from '../errors';
import { customModelsFromMetadata, type CustomProviderModel } from '../connect';
import {
  normalizeProviderId,
  type ProviderAuthMode,
  type ProviderCapabilities,
  type ProviderDescriptor,
  type ProviderRegistry,
} from '../providers/ProviderRegistry';
import {
  type SessionAffinityStore,
} from './SessionAffinityStore';
import type { AuthContext } from '../../auth/AuthContext';
import type { GatewayProtocol } from '../types';
import type { ProviderRuntimeCredential } from '../providers/ProviderRuntimeAdapter';

export type GatewayCredentialHealth = 'healthy' | 'reauthRequired' | 'disabled' | 'error' | 'invalid' | 'unknown';
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
  selectionRepository?: GatewayModelSelectionRepository;
  defaultProvider?: string;
  defaultModel?: string;
  now?: () => Date;
}

export interface GatewayModelSelection {
  provider: string;
  models: Array<string | {
    id: string;
    modelType?: string;
    status?: 'active' | 'inactive';
  }>;
  version?: string;
  defaultModel?: string;
}

export interface GatewayModelSelectionRepository {
  listActiveSelections(input: {
    webId: string;
    auth?: AuthContext;
  }): Promise<GatewayModelSelection[]>;
}

export interface GatewayModelProjection {
  id: string;
  object: 'model';
  owned_by: string;
  context_window?: number;
  capabilities?: ProviderCapabilities;
  protocols?: GatewayProtocol[];
  custom?: boolean;
  display_name?: string;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  custom_capabilities?: string[];
}

export interface ModelRouterVisibleModelsInput {
  webId: string;
  deployment: string;
  auth?: AuthContext;
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

interface VisibleModelTarget extends ResolvedModelTarget {
  projection: GatewayModelProjection;
  selectionDefault: boolean;
}

export class ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly affinityStore: SessionAffinityStore;
  private readonly credentials: ModelRouterOptions['credentials'];
  private readonly selectionRepository?: GatewayModelSelectionRepository;
  private readonly defaultProvider?: string;
  private readonly defaultModel?: string;
  private readonly now: () => Date;

  public constructor(options: ModelRouterOptions) {
    this.registry = options.registry;
    this.affinityStore = options.affinityStore;
    this.credentials = options.credentials;
    this.selectionRepository = options.selectionRepository;
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
    const requestedModel = this.normalizeLegacyStoredModelRoute(input.model?.trim());
    const explicit = requestedModel ? this.parseExplicitProviderModel(requestedModel) : undefined;
    // 合并取舍:带 runtimeCredential.baseUrl 的候选走 origin 的内联隔离 ProviderDescriptor
    // (providerId 保持显式值,见 resolveTarget);无 runtime baseUrl 的 Pod-defined provider
    // 仍走本地 custom 兼容适配器路径。
    const hasRuntimeBaseUrl = (candidate: GatewayCredentialCandidate): boolean => (
      typeof candidate.runtimeCredential?.baseUrl === 'string' && candidate.runtimeCredential.baseUrl.length > 0
    );
    const dynamicCustomTarget: ResolvedModelTarget | undefined = this.registry.getProvider('custom')
      ? explicit
        && !this.registry.getProvider(explicit.providerId)
        && candidates.some((candidate) => (
          (normalizeProviderId(candidate.provider) === explicit.providerId && !hasRuntimeBaseUrl(candidate))
          || (normalizeProviderId(candidate.provider) === 'custom'
            && credentialSupportsModel(candidate, explicit.model))
        ))
          ? { providerId: 'custom', model: explicit.model, source: 'explicit-provider' as const }
          : requestedModel && !explicit && candidates.some((candidate) => (
            !this.registry.getProvider(normalizeProviderId(candidate.provider))
            && !this.registry.getProduct(normalizeProviderId(candidate.provider))
            && !hasRuntimeBaseUrl(candidate)
            && credentialSupportsModel(candidate, requestedModel)
          ))
            ? { providerId: 'custom', model: requestedModel, source: 'exact-model' as const }
            : undefined
      : undefined;
    const visibleTargets = await this.visibleTargets(input, candidates);
    const target = dynamicCustomTarget ?? (visibleTargets
      ? this.resolveSelectedTarget(input, visibleTargets)
      : this.resolveTarget(input, candidates));
    const registeredProvider = target.provider ?? this.registry.requireProvider(target.providerId);
    const providerCandidates = candidates
      .filter((candidate) => this.credentialMatchesProvider(candidate, registeredProvider.id))
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

    // 合并取舍:不在路由期对 runtime baseUrl 做 endpointPolicy 拦截(origin 会在 cloud
    // 私网/HTTP 端点直接抛 400)。本地设计把该决策下沉到运行时凭据
    // (AiGatewayService.runtimeCredentialFor 按 deployment 派生 allowPrivateNetwork)
    // 并由 ProviderHttpTransport 的连接级 SSRF  pinning 强制执行,二者均须保留。
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

  public async listVisibleModels(input: ModelRouterVisibleModelsInput): Promise<GatewayModelProjection[]> {
    const candidates = await this.credentials({
      webId: input.webId,
      deployment: input.deployment,
      auth: input.auth,
    });
    const selectedTargets = await this.visibleTargets(input, candidates);
    if (selectedTargets) {
      return selectedTargets.map((target) => target.projection);
    }
    return this.credentialVisibleModels(candidates);
  }

  private async visibleTargets(
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
    candidates: GatewayCredentialCandidate[],
  ): Promise<VisibleModelTarget[] | undefined> {
    if (!this.selectionRepository) {
      return undefined;
    }
    const selections = await this.selectionRepository.listActiveSelections({
      webId: input.webId,
      auth: input.auth,
    });
    const selectionByProvider = new Map<string, GatewayModelSelection>();
    for (const selection of selections) {
      const rawProviderId = normalizeProviderId(selection.provider);
      const providerId = isCustomProviderInstance(rawProviderId) && this.registry.getProvider('custom')
        ? 'custom'
        : rawProviderId;
      const existing = selectionByProvider.get(providerId);
      selectionByProvider.set(providerId, existing
        ? { ...existing, models: [...existing.models, ...selection.models] }
        : { ...selection, provider: providerId });
    }

    const targets: VisibleModelTarget[] = [];
    for (const provider of this.registry.listProviders()) {
      const providerId = normalizeProviderId(provider.id);
      const selection = selectionByProvider.get(providerId);
      if (!selection) {
        continue;
      }
      const seen = new Set<string>();
      const activeModels = selection.models
        .map((selected) => typeof selected === 'string' ? { id: selected } : selected)
        .filter((model) => model.status !== 'inactive');
      const customModelIndex = indexCustomModels(candidates
        .filter((candidate) => this.credentialMatchesProvider(candidate, providerId)));
      for (const selected of activeModels) {
        const model = modelIdentity(selected.id);
        const modelKey = model.toLowerCase();
        if (!model || seen.has(modelKey)) {
          continue;
        }
        seen.add(modelKey);
        if (!await this.hasUsableCredential(input, candidates, providerId, model)) {
          continue;
        }
        const customModel = customModelIndex.get(modelKey);
        targets.push({
          providerId,
          model,
          source: 'exact-model',
          selectionDefault: Boolean(selection.defaultModel && sameModel(selection.defaultModel, selected.id)),
          projection: customModel && !registryModelDescriptor(provider, model)
            ? customModelProjection(providerId, customModel)
            : modelProjection(provider, model),
        });
      }
    }
    return targets;
  }

  private async hasUsableCredential(
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
    candidates: GatewayCredentialCandidate[],
    providerId: string,
    model: string,
  ): Promise<boolean> {
    for (const candidate of candidates) {
      if (!this.credentialMatchesProvider(candidate, providerId)) {
        continue;
      }
      if (await this.isCredentialUsable(input, candidate, model)) {
        return true;
      }
    }
    return false;
  }

  private resolveTarget(
    input: ModelRouteInput,
    candidates: GatewayCredentialCandidate[],
  ): ResolvedModelTarget {
    const requestedModel = this.normalizeLegacyStoredModelRoute(input.model?.trim());
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
        // 合并取舍:带 runtimeCredential.baseUrl 的显式未知 provider 优先走 origin 的内联
        // 隔离 ProviderDescriptor 路径(providerId 保持显式值,不注册进 registry);
        // 否则回退到本地 'custom' 注册 provider 路径(经 ProviderRuntimeAdapter 统一处理)。
        if (dynamicCredential && dynamicBaseUrl) {
          const credential = dynamicCredential;
          const baseUrl = dynamicBaseUrl;
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
        const customCandidate = candidates.find((candidate) => (
          normalizeProviderId(candidate.provider) === explicit.providerId
        ));
        if (customCandidate && this.registry.getProvider('custom')) {
          return { providerId: 'custom', model: explicit.model, source: 'explicit-provider' };
        }
        throw new GatewayProtocolError('Unknown provider in explicit model route', {
          code: 'invalid_request',
          status: 400,
          details: {
            provider: explicit.providerId,
            model: explicit.model,
          },
        });
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

  private resolveSelectedTarget(
    input: ModelRouteInput,
    visibleTargets: VisibleModelTarget[],
  ): ResolvedModelTarget {
    const requestedModel = this.normalizeLegacyStoredModelRoute(input.model?.trim());
    if (requestedModel) {
      const alias = this.registry.resolveAlias(requestedModel);
      if (alias) {
        const visible = visibleTargets.find((target) =>
          target.providerId === normalizeProviderId(alias.provider)
          && this.visibleTargetMatches(target, alias.model));
        if (!visible) throw modelNotAvailableError(requestedModel);
        return {
          providerId: normalizeProviderId(alias.provider),
          model: visible.model,
          source: 'alias',
        };
      }

      const explicit = this.parseExplicitProviderModel(requestedModel);
      if (explicit && !this.registry.getProvider(explicit.providerId)) {
        const customVisible = visibleTargets.find((target) => (
          target.providerId === 'custom' && this.visibleTargetMatches(target, explicit.model)
        ));
        if (customVisible) {
          return { providerId: 'custom', model: customVisible.model, source: 'explicit-provider' };
        }
        throw new GatewayProtocolError('Unknown provider in explicit model route', {
          code: 'invalid_request',
          status: 400,
          details: {
            provider: explicit.providerId,
            model: explicit.model,
          },
        });
      }
      if (explicit) {
        const visible = visibleTargets.find((target) =>
          target.providerId === explicit.providerId
          && this.visibleTargetMatches(target, explicit.model));
        if (!visible) throw modelNotAvailableError(requestedModel);
        return {
          providerId: explicit.providerId,
          model: visible.model,
          source: 'explicit-provider',
        };
      }

      const exactMatches = visibleTargets.filter((target) => this.visibleTargetMatches(target, requestedModel));
      const exact = exactMatches.find((target) => target.selectionDefault) ?? exactMatches[0];
      if (exact) {
        return {
          providerId: exact.providerId,
          model: exact.model,
          source: 'exact-model',
        };
      }
      throw modelNotAvailableError(requestedModel);
    }

    const defaultProviderTarget = this.findSelectedDefaultProviderTarget(requestedModel, visibleTargets);
    if (defaultProviderTarget) {
      return defaultProviderTarget;
    }

    const defaultModelTarget = this.findSelectedDefaultModelTarget(visibleTargets);
    if (defaultModelTarget) {
      return defaultModelTarget;
    }

    throw noModelAvailableError();
  }

  private visibleTargetMatches(target: VisibleModelTarget, requestedModel: string): boolean {
    if (sameModel(target.model, requestedModel)) {
      return true;
    }
    const descriptor = this.registry.getProvider(target.providerId)?.models.find((model) => sameModel(model.id, target.model));
    return Boolean(descriptor?.aliases?.some((alias) => sameModel(alias, requestedModel)));
  }

  private findSelectedDefaultProviderTarget(
    requestedModel: string | undefined,
    visibleTargets: VisibleModelTarget[],
  ): ResolvedModelTarget | undefined {
    if (!this.defaultProvider || requestedModel) {
      return undefined;
    }
    const providerTargets = visibleTargets.filter((target) => target.providerId === this.defaultProvider);
    const preferredModel = this.defaultModel
      ?? providerTargets.find((target) => target.selectionDefault)?.model;
    const target = preferredModel
      ? providerTargets.find((item) => sameModel(item.model, preferredModel))
      : providerTargets[0];
    if (!target) {
      return undefined;
    }
    return {
      providerId: this.defaultProvider,
      model: target.model,
      source: this.defaultModel || target.selectionDefault ? 'default-model' : 'default-provider',
    };
  }

  private findSelectedDefaultModelTarget(
    visibleTargets: VisibleModelTarget[],
  ): ResolvedModelTarget | undefined {
    const selectionDefault = visibleTargets.find((target) => target.selectionDefault);
    if (selectionDefault) {
      return {
        providerId: selectionDefault.providerId,
        model: selectionDefault.model,
        source: 'default-model',
      };
    }
    return visibleTargets[0]
      ? {
        providerId: visibleTargets[0].providerId,
        model: visibleTargets[0].model,
        source: 'default-model',
      }
      : undefined;
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

  private normalizeLegacyStoredModelRoute(model?: string): string | undefined {
    if (!model) return model;
    let candidate = model;
    try {
      const url = new URL(model);
      candidate = `${url.pathname}${url.hash}`;
    } catch {
      // Plain model ids and provider/model routes are expected here.
    }
    const match = candidate.match(/(?:^|\/)(?:settings\/providers\/)+([^\/#]+?)(?:\.ttl)?(?:#|\/)(.+)$/u);
    if (!match) return model;
    const providerId = normalizeProviderId(match[1]);
    return this.registry.getProvider(providerId) ? `${providerId}/${match[2]}` : model;
  }

  private findExactModelTarget(
    model: string,
    candidates: GatewayCredentialCandidate[],
  ): ResolvedModelTarget | undefined {
    const registryMatches = this.registry.findModel(model);
    if (registryMatches.length > 0) {
      const candidateMatch = registryMatches.find((match) =>
        candidates.some((candidate) =>
          this.credentialMatchesProvider(candidate, match.provider.id)
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
        providerId: this.routeProviderIdForCredential(candidate),
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
    const credential = candidates.find((item) => this.credentialMatchesProvider(item, this.defaultProvider!));
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
        const providerId = this.routeProviderIdForCredential(candidate);
        return {
          providerId,
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

  private credentialMatchesProvider(candidate: GatewayCredentialCandidate, providerId: string): boolean {
    const normalizedProviderId = normalizeProviderId(providerId);
    const candidateProviderId = normalizeProviderId(candidate.provider);
    if (candidateProviderId === normalizedProviderId) {
      return true;
    }
    if (normalizedProviderId === 'custom' && !this.registry.getProvider(candidateProviderId)) {
      return true;
    }
    const product = this.registry.getProduct(normalizedProviderId);
    if (!product || normalizeProviderId(product.id) !== normalizedProviderId) {
      return false;
    }
    const offeringId = stringMetadata(candidate.metadata, 'offeringId');
    const offerings = offeringId
      ? product.offerings.filter((offering) => normalizeProviderId(offering.id) === normalizeProviderId(offeringId))
      : product.offerings;
    return offerings.some((offering) =>
      offering.runtimeProviderIds.some((runtimeProviderId) =>
        normalizeProviderId(runtimeProviderId) === candidateProviderId));
  }

  private routeProviderIdForCredential(candidate: GatewayCredentialCandidate): string {
    const providerId = normalizeProviderId(candidate.provider);
    const product = this.registry.getProduct(providerId);
    if (product) {
      return normalizeProviderId(product.id);
    }
    return providerId;
  }

  private credentialVisibleModels(candidates: GatewayCredentialCandidate[]): GatewayModelProjection[] {
    const seen = new Set<string>();
    const models: GatewayModelProjection[] = [];
    for (const provider of this.registry.listProviders()) {
      const providerId = normalizeProviderId(provider.id);
      const providerCandidates = candidates
        .filter((candidate) => this.isCredentialModelVisible(candidate))
        .filter((candidate) => this.credentialMatchesProvider(candidate, providerId));
      if (providerCandidates.length === 0) {
        continue;
      }
      const unrestricted = providerCandidates.some((candidate) => candidate.models === undefined);
      const selected = unrestricted
        ? provider.models.map((model) => model.id)
        : providerCandidates.flatMap((candidate) => candidate.models ?? []);
      const customModelIndex = indexCustomModels(providerCandidates);
      for (const model of selected) {
        const customModel = customModelIndex.get(modelIdentity(model).toLowerCase());
        const projection = customModel && !registryModelDescriptor(provider, model)
          ? customModelProjection(providerId, customModel)
          : modelProjection(provider, model);
        const projectionKey = `${providerId}:${modelIdentity(projection.id).toLowerCase()}`;
        if (seen.has(projectionKey)) {
          continue;
        }
        seen.add(projectionKey);
        models.push(projection);
      }
      const registryModelIds = new Set(provider.models.map((model) => modelIdentity(model.id).toLowerCase()));
      for (const credential of providerCandidates) {
        if (credential.models !== undefined && credential.models.length === 0) {
          continue;
        }
        const customModels = credential.customModels ?? customModelsFromMetadata(credential.metadata);
        for (const customModel of customModels) {
          const id = modelIdentity(customModel.id);
          const normalizedId = id.toLowerCase();
          const key = `${providerId}:${normalizedId}`;
          if (!id || seen.has(key) || registryModelIds.has(normalizedId)) {
            continue;
          }
          seen.add(key);
          models.push(customModelProjection(providerId, customModel));
        }
      }
    }
    return models;
  }

  private isCredentialModelVisible(candidate: GatewayCredentialCandidate): boolean {
    return candidate.enabled
      && (!candidate.health || candidate.health === 'healthy')
      && candidate.quota?.status !== 'exhausted'
      && (!candidate.cooldownUntil || candidate.cooldownUntil.getTime() <= this.now().getTime());
  }
}

function isCustomProviderInstance(providerId: string): boolean {
  const resource = providerId.slice(providerId.lastIndexOf('/') + 1);
  return resource.startsWith('custom-instance-');
}

function modelIdentity(value: string): string {
  const normalized = value.trim();
  const fragment = normalized.lastIndexOf('#');
  return fragment >= 0 ? normalized.slice(fragment + 1) : normalized;
}

function sameModel(left: string, right: string): boolean {
  return modelIdentity(left).toLowerCase() === modelIdentity(right).toLowerCase();
}

function registryModelDescriptor(provider: ProviderDescriptor, modelId: string) {
  return provider.models.find((model) =>
    sameModel(model.id, modelId)
    || (model.aliases ?? []).some((alias) => sameModel(alias, modelId)));
}

function indexCustomModels(candidates: GatewayCredentialCandidate[]): Map<string, CustomProviderModel> {
  const index = new Map<string, CustomProviderModel>();
  for (const candidate of candidates) {
    if (candidate.models !== undefined && candidate.models.length === 0) {
      continue;
    }
    for (const customModel of candidate.customModels ?? customModelsFromMetadata(candidate.metadata)) {
      const id = modelIdentity(customModel.id);
      if (id) {
        index.set(id.toLowerCase(), customModel);
      }
    }
  }
  return index;
}

function customModelProjection(providerId: string, customModel: CustomProviderModel): GatewayModelProjection {
  const id = modelIdentity(customModel.id);
  return {
    id,
    object: 'model',
    owned_by: providerId,
    custom: true,
    ...(customModel.displayName ? { display_name: customModel.displayName } : {}),
    ...((customModel.inputModalities?.length || customModel.outputModalities?.length)
      ? {
          modalities: {
            ...(customModel.inputModalities?.length ? { input: [...customModel.inputModalities] } : {}),
            ...(customModel.outputModalities?.length ? { output: [...customModel.outputModalities] } : {}),
          },
        }
      : {}),
    ...(customModel.capabilities?.length ? { custom_capabilities: [...customModel.capabilities] } : {}),
  };
}

function modelProjection(provider: ProviderDescriptor, modelId: string): GatewayModelProjection {
  const descriptor = registryModelDescriptor(provider, modelId);
  return {
    id: modelIdentity(modelId),
    object: 'model',
    owned_by: provider.id,
    ...(descriptor?.contextWindow !== undefined ? { context_window: descriptor.contextWindow } : {}),
    ...(descriptor?.capabilities ? { capabilities: descriptor.capabilities } : {}),
    ...(descriptor?.protocols ? { protocols: descriptor.protocols } : {}),
  };
}

function modelNotAvailableError(model: string): GatewayProtocolError {
  return new GatewayProtocolError('Requested model is not available for this account', {
    code: 'model_not_available',
    status: 404,
    details: { model },
  });
}

function noModelAvailableError(): GatewayProtocolError {
  return new GatewayProtocolError('No model is available for this account', {
    code: 'no_model_available',
    status: 404,
  });
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
  const models = candidate.models;
  if (models === undefined) {
    return true;
  }
  if (models.length === 0) {
    return false;
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

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
