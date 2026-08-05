import { GatewayProtocolError } from '../errors';
import {
  normalizeProviderId,
  type ProviderAuthMode,
  type ProviderDescriptor,
  type ProviderCapabilities,
  type ProviderRegistry,
} from '../providers/ProviderRegistry';
import {
  type SessionAffinityStore,
} from './SessionAffinityStore';
import type { AuthContext } from '../../auth/AuthContext';
import type { GatewayProtocol } from '../types';

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
  defaultModel?: string;
  health?: GatewayCredentialHealth;
  quota?: {
    status: GatewayQuotaStatus;
  };
  cooldownUntil?: Date;
  metadata?: Record<string, unknown>;
}

export interface ModelRouterCredentialLookupInput {
  webId: string;
  deployment: string;
  auth?: AuthContext;
}

export interface ModelRouterOptions {
  registry: ProviderRegistry;
  affinityStore: SessionAffinityStore;
  credentials(input: ModelRouterCredentialLookupInput): Promise<GatewayCredentialCandidate[]>;
  /** Durable Pod model picks. Production wiring passes the shared singleton repository. */
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
    const candidates = await this.credentials({
      webId: input.webId,
      deployment: input.deployment,
      auth: input.auth,
    });
    const visibleTargets = await this.visibleTargets(input, candidates);
    const target = this.resolveTarget(input, candidates, visibleTargets);
    const provider = this.registry.requireProvider(target.providerId);
    const providerCandidates = candidates
      .filter((candidate) => normalizeProviderId(candidate.provider) === normalizeProviderId(provider.id))
      .filter((candidate) => !excludeCredentialIds.has(candidate.id) && !excludeCredentialIds.has(candidate.credentialIri));
    const selected = input.explicitCredentialId
      ? await this.selectExplicitCredential(input, providerCandidates, input.explicitCredentialId, target.model)
      : await this.selectCredential(input, providerCandidates, target);

    if (!selected) {
      throw new GatewayProtocolError('No usable credential is available for the requested model', {
        code: 'credential_unavailable',
        status: 403,
        details: {
          provider: provider.id,
          model: target.model,
        },
      });
    }

    if (input.conversationId && !input.explicitCredentialId) {
      await this.affinityStore.set({
        deployment: input.deployment,
        webId: input.webId,
        conversationId: input.conversationId,
        provider: provider.id,
        credentialId: selected.id,
      });
    }

    return {
      provider,
      model: target.model,
      credential: selected,
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

  /**
   * Return the exact model projection shared by /v1/models and route target
   * resolution. The optional legacy path is retained only for lightweight
   * callers that predate durable model selections; production wiring always
   * supplies the singleton Pod selection repository.
   */
  public async listVisibleModels(input: ModelRouterVisibleModelsInput): Promise<GatewayModelProjection[]> {
    const candidates = await this.credentials({
      webId: input.webId,
      deployment: input.deployment,
      auth: input.auth,
    });
    const targets = await this.visibleTargets({
      webId: input.webId,
      deployment: input.deployment,
      auth: input.auth,
    }, candidates);
    return targets.map((target) => target.projection);
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

  private async visibleTargets(
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
    candidates: GatewayCredentialCandidate[],
  ): Promise<VisibleModelTarget[]> {
    const selections = this.selectionRepository
      ? await this.selectionRepository.listActiveSelections({ webId: input.webId, auth: input.auth })
      : undefined;
    if (selections === undefined) {
      return this.legacyVisibleTargets(input, candidates);
    }

    const selectionByProvider = new Map<string, GatewayModelSelection>();
    for (const selection of selections) {
      const providerId = normalizeProviderId(selection.provider);
      if (!selectionByProvider.has(providerId)) {
        selectionByProvider.set(providerId, selection);
      }
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
      for (const selected of activeModels) {
        const model = modelIdentity(selected.id);
        const modelKey = model.toLowerCase();
        if (!model || seen.has(modelKey)) {
          continue;
        }
        seen.add(modelKey);
        const usable = await this.hasUsableCredential(input, candidates, providerId, model);
        if (!usable) {
          continue;
        }
        targets.push({
          providerId,
          model,
          source: 'exact-model',
          selectionDefault: Boolean(selection.defaultModel && sameModel(selection.defaultModel, selected.id)),
          projection: modelProjection(provider, model),
        });
      }
    }
    return targets;
  }

  private async legacyVisibleTargets(
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
    candidates: GatewayCredentialCandidate[],
  ): Promise<VisibleModelTarget[]> {
    const activeCredentialModels = new Map<string, Set<string> | undefined>();
    for (const credential of candidates) {
      if (!await this.isCredentialVisible(input, credential)) {
        continue;
      }
      const providerId = normalizeProviderId(credential.provider);
      const allowedModels = credential.models ?? [];
      if (allowedModels.length === 0) {
        activeCredentialModels.set(providerId, undefined);
        continue;
      }
      const existing = activeCredentialModels.get(providerId);
      if (existing === undefined && activeCredentialModels.has(providerId)) {
        continue;
      }
      const models = existing ?? new Set<string>();
      for (const model of allowedModels) {
        models.add(modelIdentity(model));
      }
      activeCredentialModels.set(providerId, models);
    }

    const targets: VisibleModelTarget[] = [];
    const seen = new Set<string>();
    for (const provider of this.registry.listProviders()) {
      const providerId = normalizeProviderId(provider.id);
      if (!activeCredentialModels.has(providerId)) {
        continue;
      }
      const allowedModels = activeCredentialModels.get(providerId);
      const providerModels = allowedModels === undefined
        ? provider.models.map((model) => model.id)
        : Array.from(allowedModels);
      for (const model of providerModels) {
        if (!model || seen.has(`${providerId}\u0000${model}`)) {
          continue;
        }
        if (!await this.hasUsableCredential(input, candidates, providerId, model)) {
          continue;
        }
        seen.add(`${providerId}\u0000${model}`);
        targets.push({
          providerId,
          model,
          source: 'exact-model',
          selectionDefault: false,
          projection: modelProjection(provider, model),
        });
      }
      if (allowedModels !== undefined) {
        const registryIds = new Set(provider.models.map((model) => modelIdentity(model.id)));
        for (const model of Array.from(allowedModels).filter((value) => !registryIds.has(value))) {
          if (!await this.hasUsableCredential(input, candidates, providerId, model)) {
            continue;
          }
          seen.add(`${providerId}\u0000${model}`);
          targets.push({
            providerId,
            model,
            source: 'exact-model',
            selectionDefault: false,
            projection: modelProjection(provider, model),
          });
        }
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
      if (normalizeProviderId(candidate.provider) !== providerId) {
        continue;
      }
      if (await this.isCredentialUsable(input, candidate, model)) {
        return true;
      }
    }
    return false;
  }

  private async isCredentialVisible(
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
    candidate: GatewayCredentialCandidate,
  ): Promise<boolean> {
    if (!candidate.enabled || (candidate.health && candidate.health !== 'healthy')) {
      return false;
    }
    if (candidate.quota?.status === 'exhausted') {
      return false;
    }
    const cooldownUntil = await this.effectiveCooldownUntil(input, candidate);
    return !cooldownUntil || cooldownUntil.getTime() <= this.now().getTime();
  }

  private resolveTarget(
    input: ModelRouteInput,
    candidates: GatewayCredentialCandidate[],
    visibleTargets: VisibleModelTarget[],
  ): ResolvedModelTarget {
    const requestedModel = input.model?.trim();
    if (requestedModel) {
      const alias = this.registry.resolveAlias(requestedModel);
      if (alias) {
        const visible = visibleTargets.find((target) =>
          target.providerId === normalizeProviderId(alias.provider)
          && sameModel(target.model, alias.model));
        if (!visible && this.selectionRepository) {
          throw modelNotAvailableError(requestedModel);
        }
        return {
          providerId: normalizeProviderId(alias.provider),
          model: visible?.model ?? alias.model,
          source: 'alias',
        };
      }

      const explicit = this.parseExplicitProviderModel(requestedModel);
      if (explicit && !this.registry.getProvider(explicit.providerId)) {
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
        if (!visible && this.selectionRepository) {
          throw modelNotAvailableError(requestedModel);
        }
        return {
          providerId: explicit.providerId,
          model: visible?.model ?? explicit.model,
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
      if (!this.selectionRepository) {
        const legacyExact = this.findExactModelTarget(requestedModel, candidates);
        if (legacyExact) {
          return legacyExact;
        }
      }
      if (this.selectionRepository) {
        throw modelNotAvailableError(requestedModel);
      }
    }

    const defaultProviderTarget = this.findDefaultProviderTarget(requestedModel, candidates, visibleTargets);
    if (defaultProviderTarget) {
      return defaultProviderTarget;
    }

    const defaultModelTarget = this.findDefaultModelTarget(candidates, visibleTargets);
    if (defaultModelTarget) {
      return defaultModelTarget;
    }

    throw new GatewayProtocolError('Unable to resolve model route', {
      code: 'invalid_request',
      status: 400,
      details: { model: input.model },
    });
  }

  private visibleTargetMatches(target: VisibleModelTarget, requestedModel: string): boolean {
    if (sameModel(target.model, requestedModel)) {
      return true;
    }
    const descriptor = this.registry.getProvider(target.providerId)?.models.find((model) => sameModel(model.id, target.model));
    return Boolean(descriptor?.aliases?.some((alias) => sameModel(alias, requestedModel)));
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
    visibleTargets: VisibleModelTarget[],
  ): ResolvedModelTarget | undefined {
    if (!this.defaultProvider || requestedModel) {
      return undefined;
    }
    const providerTargets = visibleTargets.filter((target) => target.providerId === this.defaultProvider);
    const credential = candidates.find((item) => normalizeProviderId(item.provider) === this.defaultProvider);
    const preferredModel = this.defaultModel
      ?? providerTargets.find((target) => target.selectionDefault)?.model
      ?? credential?.defaultModel
      ?? credential?.models?.[0];
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

  private findDefaultModelTarget(
    candidates: GatewayCredentialCandidate[],
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
    if (this.selectionRepository) {
      return visibleTargets[0]
        ? {
          providerId: visibleTargets[0].providerId,
          model: visibleTargets[0].model,
          source: 'default-model',
        }
        : undefined;
    }
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
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
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
    // Durable Pod picks are the authoritative model boundary in production.
    // Credential metadata may contain a stale pre-selection allowlist, so it
    // is only consulted by the compatibility path without a selection reader.
    return this.selectionRepository ? true : credentialSupportsModel(candidate, model);
  }

  private async effectiveCooldownUntil(
    input: ModelRouteInput | ModelRouterVisibleModelsInput,
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

function credentialSupportsModel(candidate: GatewayCredentialCandidate, model: string): boolean {
  const models = candidate.models ?? [];
  return models.length === 0 || models.some((candidateModel) => sameModel(candidateModel, model));
}

function modelIdentity(value: string): string {
  const normalized = value.trim();
  const fragment = normalized.lastIndexOf('#');
  return fragment >= 0 ? normalized.slice(fragment + 1) : normalized;
}

function sameModel(left: string, right: string): boolean {
  return modelIdentity(left).toLowerCase() === modelIdentity(right).toLowerCase();
}

function modelProjection(provider: ProviderDescriptor, modelId: string): GatewayModelProjection {
  const descriptor = provider.models.find((model) =>
    sameModel(model.id, modelId)
    || (model.aliases ?? []).some((alias) => sameModel(alias, modelId)));
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

function compareCredentialPriority(
  left: GatewayCredentialCandidate,
  right: GatewayCredentialCandidate,
): number {
  return (left.priority ?? 100) - (right.priority ?? 100)
    || left.id.localeCompare(right.id);
}
