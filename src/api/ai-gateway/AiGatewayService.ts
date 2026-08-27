import { createHash } from 'node:crypto';
import { GatewayProtocolError, normalizeGatewayError } from './errors';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, hasGatewayScope } from '../auth/AuthContext';
import type { CredentialVault } from './credentials/CredentialVault';
import type { EncryptedCredentialSecret } from './credentials/KeyWrapper';
import { ChatCompletionsFrontend, MessagesFrontend, ResponsesFrontend } from './protocol';
import type { ProviderRuntimeCredential } from './providers/ProviderRuntimeAdapter';
import type { ProviderImageGenerationRequest } from './providers/ProviderRuntimeAdapter';
import type { ProviderCapabilities, ProviderRegistry } from './providers/ProviderRegistry';
import { normalizeProviderId } from './providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from './providers/ProviderRuntimeRegistry';
import type { GatewayCredentialCandidate, ModelRouter, ModelRouteResult } from './routing/ModelRouter';
import type { CustomProviderModel } from './connect';
import { customModelsFromMetadata } from './connect';
import type {
  GatewayEvent,
  GatewayProtocol,
  GatewayProtocolFrontend,
  GatewayRequest,
  GatewayUsage,
} from './types';

export interface StoredGatewayCredential extends GatewayCredentialCandidate {
  encryptedSecret: EncryptedCredentialSecret;
  version?: number;
  runtimeCredential?: ProviderRuntimeCredential;
}

export interface GatewayCredentialStore {
  listCredentials(input: {
    webId: string;
    deployment: string;
    auth?: AuthContext;
    provider?: string;
  }): Promise<StoredGatewayCredential[]>;
  recordSuccess?(input: GatewayCredentialHealthRecord): Promise<void>;
  recordFailure?(input: GatewayCredentialHealthRecord): Promise<void>;
  rewrapCredential?(input: {
    webId: string;
    deployment: string;
    credentialId: string;
    expectedVersion?: number;
    encryptedSecret: EncryptedCredentialSecret;
  }): Promise<boolean>;
}

export interface GatewayCredentialHealthRecord {
  webId: string;
  deployment: string;
  provider: string;
  credentialId: string;
  credentialIri: string;
  status?: number;
  errorCode?: string;
}

export interface AiGatewayServiceOptions {
  deployment: string;
  registry: ProviderRegistry;
  router: ModelRouter;
  credentials: GatewayCredentialStore;
  vault: CredentialVault;
  runtimes: ProviderRuntimeRegistry;
  frontends?: GatewayProtocolFrontend[];
  now?: () => Date;
}

export interface GatewayExecutionInput {
  auth: AuthContext;
  protocol: GatewayProtocol;
  body: unknown;
  signal?: AbortSignal;
}

export interface GatewayImageGenerationInput {
  auth: AuthContext;
  body: unknown;
  mode?: 'generation' | 'edit';
  signal?: AbortSignal;
}

export interface GatewayExecution {
  protocol: GatewayProtocol;
  frontend: GatewayProtocolFrontend;
  request: GatewayRequest;
  route: ModelRouteResult;
  events: AsyncIterable<GatewayEvent>;
}

export interface GatewayModelListItem {
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

export interface GatewayAcceptanceProvenance {
  webId: string;
  gatewayKeyId: string;
  gatewayKeyFingerprint: string;
  credentialIriHash: string;
  secretCellRefHash: string;
  providerId: string;
  providerRouteSource: 'pod-credential';
  xpodBaseUrl: string;
  generatedAt: string;
}

export class AiGatewayService {
  private readonly deployment: string;
  private readonly registry: ProviderRegistry;
  private readonly router: ModelRouter;
  private readonly credentials: GatewayCredentialStore;
  private readonly vault: CredentialVault;
  private readonly runtimes: ProviderRuntimeRegistry;
  private readonly frontends = new Map<GatewayProtocol, GatewayProtocolFrontend>();
  private readonly now: () => Date;

  public constructor(options: AiGatewayServiceOptions) {
    this.deployment = options.deployment;
    this.registry = options.registry;
    this.router = options.router;
    this.credentials = options.credentials;
    this.vault = options.vault;
    this.runtimes = options.runtimes;
    this.now = options.now ?? (() => new Date());
    for (const frontend of options.frontends ?? [
      new ResponsesFrontend(),
      new MessagesFrontend(),
      new ChatCompletionsFrontend(),
    ]) {
      this.frontends.set(frontend.protocol, frontend);
    }
  }

  public frontend(protocol: GatewayProtocol): GatewayProtocolFrontend {
    const frontend = this.frontends.get(protocol);
    if (!frontend) {
      throw new GatewayProtocolError('Unsupported gateway protocol', {
        code: 'invalid_request',
        status: 400,
        details: { protocol },
      });
    }
    return frontend;
  }

  public async execute(input: GatewayExecutionInput): Promise<GatewayExecution> {
    this.requireScope(input.auth, 'inference:write');
    const principal = this.requirePrincipal(input.auth);
    const frontend = this.frontend(input.protocol);
    const request = frontend.parseRequest(input.body);
    validateGatewayRequest(request, input.protocol);
    const route = await this.router.route({
      webId: principal.webId,
      deployment: this.deployment,
      auth: input.auth,
      model: request.model,
      conversationId: conversationIdFor(request),
      explicitCredentialId: explicitCredentialIdFor(request),
    });
    request.model = route.model;
    const events = this.executeWithCredentialFailover({
      principal,
      request,
      route,
      signal: input.signal,
    });

    return {
      protocol: input.protocol,
      frontend,
      request,
      route,
      events,
    };
  }

  public async complete(input: GatewayExecutionInput): Promise<Record<string, unknown>> {
    const execution = await this.execute(input);
    const events: GatewayEvent[] = [];
    for await (const event of execution.events) {
      events.push(event);
    }
    return aggregateEvents(execution.protocol, execution.request.model, events, this.now());
  }

  public async generateImage(input: GatewayImageGenerationInput): Promise<Record<string, unknown>> {
    this.requireScope(input.auth, 'inference:write');
    const principal = this.requirePrincipal(input.auth);
    const request = parseImageGenerationRequest(input.body, input.mode ?? 'generation');
    let route = await this.router.route({
      webId: principal.webId,
      deployment: this.deployment,
      auth: input.auth,
      model: request.model,
      explicitCredentialId: explicitImageCredentialId(input.body),
    });
    request.model = route.model;
    const attempted = new Set<string>();

    for (;;) {
      attempted.add(route.credential.id);
      const credential = route.credential as StoredGatewayCredential;
      this.requireImageCapability(route, Boolean(request.image));
      const adapter = this.runtimes.get(route.provider.id, route.provider);
      if (!adapter.generateImage) {
        throw new GatewayProtocolError(`${route.provider.id} does not expose image generation`, {
          code: 'invalid_request',
          status: 400,
          details: { provider: route.provider.id, capability: 'image_generation' },
        });
      }
      try {
        const apiKey = await this.openApiKey(principal, route, credential);
        const result = normalizeImageGenerationResult(await adapter.generateImage({
          request,
          apiKey,
          credential: credential.runtimeCredential ?? runtimeCredentialFromMetadata(credential.metadata),
          signal: input.signal,
        }));
        await this.credentials.recordSuccess?.(healthRecord(principal.webId, this.deployment, route));
        return result;
      } catch (error) {
        await this.recordRouteFailure(principal.webId, route, error);
        if (this.router.canFailOver(route)) {
          const nextRoute = await this.findImageFailoverRoute(principal.webId, input.auth, request, attempted);
          if (nextRoute) {
            route = nextRoute;
            request.model = route.model;
            continue;
          }
        }
        throw error;
      }
    }
  }

  public async listModels(auth: AuthContext): Promise<GatewayModelListItem[]> {
    this.requireScope(auth, 'models:read');
    const principal = this.requirePrincipal(auth);
    const credentials = await this.credentials.listCredentials({
      webId: principal.webId,
      deployment: this.deployment,
      auth,
    });
    const activeCredentialModels = new Map<string, Set<string> | undefined>();
    const customCredentialModels = new Map<string, CustomProviderModel[]>();
    for (const credential of credentials) {
      if (!isCredentialModelVisible(credential, this.now())) {
        continue;
      }
      const providerId = normalizeProviderId(credential.provider);
      const customModels = credential.customModels ?? customModelsFromMetadata(credential.metadata);
      if (customModels.length > 0) {
        const existing = customCredentialModels.get(providerId) ?? [];
        const known = new Set(existing.map((model) => model.id));
        for (const model of customModels) {
          if (!known.has(model.id)) {
            known.add(model.id);
            existing.push(model);
          }
        }
        customCredentialModels.set(providerId, existing);
      }
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
        models.add(model);
      }
      activeCredentialModels.set(providerId, models);
    }
    const seen = new Set<string>();
    const models: GatewayModelListItem[] = [];
    for (const provider of this.registry.listProviders()) {
      const providerId = normalizeProviderId(provider.id);
      if (!activeCredentialModels.has(providerId)) {
        continue;
      }
      const allowedModels = activeCredentialModels.get(providerId);
      const providerModelItems = provider.models
        .filter((model) => allowedModels === undefined || allowedModels.has(model.id))
        .map((model) => ({
          id: model.id,
          object: 'model' as const,
          owned_by: provider.id,
          ...(model.contextWindow !== undefined ? { context_window: model.contextWindow } : {}),
          ...(model.capabilities ? { capabilities: model.capabilities } : {}),
          ...(model.protocols ? { protocols: model.protocols } : {}),
        }));
      const registryModelIds = new Set(provider.models.map((model) => model.id));
      const credentialOnlyModelItems = allowedModels === undefined
        ? []
        : Array.from(allowedModels)
          .filter((model) => !registryModelIds.has(model))
          .map((model) => ({
            id: model,
            object: 'model' as const,
            owned_by: provider.id,
          }));
      const customModelItems = (customCredentialModels.get(providerId) ?? [])
        .filter((model) => !registryModelIds.has(model.id))
        .map((model) => ({
          id: model.id,
          object: 'model' as const,
          owned_by: provider.id,
          custom: true,
          ...(model.displayName ? { display_name: model.displayName } : {}),
          ...((model.inputModalities?.length || model.outputModalities?.length)
            ? {
                modalities: {
                  ...(model.inputModalities?.length ? { input: [...model.inputModalities] } : {}),
                  ...(model.outputModalities?.length ? { output: [...model.outputModalities] } : {}),
                },
              }
            : {}),
          ...(model.capabilities && model.capabilities.length > 0
            ? { custom_capabilities: [...model.capabilities] }
            : {}),
        }));
      for (const model of [ ...providerModelItems, ...credentialOnlyModelItems, ...customModelItems ]) {
        if (seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        models.push(model);
      }
    }
    return models;
  }

  public async acceptanceProvenance(input: {
    auth: AuthContext;
    model: string;
    xpodBaseUrl: string;
  }): Promise<GatewayAcceptanceProvenance> {
    this.requireScope(input.auth, 'acceptance:read');
    const principal = this.requirePrincipal(input.auth);
    if (input.auth.type !== 'solid' || input.auth.viaGatewayApiKey !== true || !input.auth.gatewayKeyFingerprint) {
      throw new GatewayProtocolError('Acceptance provenance requires a Gateway API key principal', {
        code: 'invalid_request',
        status: 403,
      });
    }
    let route: ModelRouteResult;
    try {
      route = await this.router.route({
        webId: principal.webId,
        deployment: this.deployment,
        auth: input.auth,
        model: input.model,
      });
    } catch (error) {
      if (error instanceof GatewayProtocolError && error.code === 'credential_unavailable') {
        throw new GatewayProtocolError('Acceptance provenance credential route was not resolved', {
          code: 'credential_unavailable',
          status: 404,
          details: error.details,
        });
      }
      throw error;
    }
    if (route.model !== requestedRouteModel(input.model)) {
      throw new GatewayProtocolError('Acceptance provenance credential route was not resolved', {
        code: 'credential_unavailable',
        status: 404,
        details: { model: input.model },
      });
    }
    const credential = route.credential as StoredGatewayCredential;
    return {
      webId: principal.webId,
      gatewayKeyId: input.auth.type === 'solid' ? input.auth.gatewayKeyId ?? 'unknown' : 'unknown',
      gatewayKeyFingerprint: input.auth.gatewayKeyFingerprint,
      credentialIriHash: hashProvenanceValue(credential.credentialIri),
      secretCellRefHash: hashProvenanceValue(credential.encryptedSecret.credentialIri),
      providerId: route.provider.id,
      providerRouteSource: 'pod-credential',
      xpodBaseUrl: input.xpodBaseUrl,
      generatedAt: this.now().toISOString(),
    };
  }

  private async *executeWithCredentialFailover(input: {
    principal: { webId: string };
    request: GatewayRequest;
    route: ModelRouteResult;
    signal?: AbortSignal;
  }): AsyncIterable<GatewayEvent> {
    let route = input.route;
    let firstClientEventEmitted = false;
    const attempted = new Set<string>();

    for (;;) {
      attempted.add(route.credential.id);
      const credential = route.credential as StoredGatewayCredential;
      try {
        const apiKey = await this.openApiKey(input.principal, route, credential);
        const adapter = this.runtimes.get(route.provider.id, route.provider);
        const upstream = adapter.execute({
          request: input.request,
          apiKey,
          credential: credential.runtimeCredential ?? runtimeCredentialFromMetadata(credential.metadata),
          signal: input.signal,
        });
        for await (const event of upstream) {
          if (!firstClientEventEmitted) {
            firstClientEventEmitted = true;
            this.router.markClientEventEmitted(route);
          }
          yield event;
        }
        await this.credentials.recordSuccess?.(healthRecord(input.principal.webId, this.deployment, route));
        return;
      } catch (error) {
        await this.recordRouteFailure(input.principal.webId, route, error);
        if (!firstClientEventEmitted && this.router.canFailOver(route)) {
          const nextRoute = await this.findFailoverRoute(input.principal.webId, input.request, route, attempted);
          if (nextRoute) {
            route = nextRoute;
            continue;
          }
        }
        throw error;
      }
    }
  }

  private async findFailoverRoute(
    webId: string,
    request: GatewayRequest,
    failedRoute: ModelRouteResult,
    attempted: Set<string>,
  ): Promise<ModelRouteResult | undefined> {
    try {
      return await this.router.route({
        webId,
        deployment: this.deployment,
        model: `${failedRoute.provider.id}/${failedRoute.model}`,
        conversationId: conversationIdFor(request),
      }, attempted);
    } catch (error) {
      if (error instanceof GatewayProtocolError && error.code === 'credential_unavailable') {
        return undefined;
      }
      throw error;
    }
  }

  private async findImageFailoverRoute(
    webId: string,
    auth: AuthContext,
    request: ProviderImageGenerationRequest,
    attempted: Set<string>,
  ): Promise<ModelRouteResult | undefined> {
    try {
      return await this.router.route({
        webId,
        deployment: this.deployment,
        auth,
        model: request.model,
      }, attempted);
    } catch (error) {
      if (error instanceof GatewayProtocolError && error.code === 'credential_unavailable') {
        return undefined;
      }
      throw error;
    }
  }

  private requireImageCapability(route: ModelRouteResult, editing: boolean): void {
    const explicit = route.credential.runtimeCapabilities;
    const capability = editing ? 'image_editing' : 'image_generation';
    const supported = explicit === undefined
      ? editing ? route.provider.capabilities.imageEditing === true : route.provider.capabilities.imageGeneration === true
      : explicit.includes(capability);
    if (!supported) {
      throw new GatewayProtocolError(`${route.provider.id} does not support ${editing ? 'image editing' : 'image generation'}`, {
        code: 'invalid_request',
        status: 400,
        details: { provider: route.provider.id, model: route.model, capability },
      });
    }
    const model = route.provider.models.find((candidate) => candidate.id === route.model);
    const modelSupported = editing
      ? model?.capabilities?.imageEditing === true
      : model?.capabilities?.imageGeneration === true;
    if (!modelSupported) {
      throw new GatewayProtocolError(`${route.model} is not declared for ${editing ? 'image editing' : 'image generation'}`, {
        code: 'invalid_request',
        status: 400,
        details: { provider: route.provider.id, model: route.model, capability, scope: 'model' },
      });
    }
  }

  private async openApiKey(
    principal: { webId: string },
    route: ModelRouteResult,
    credential: StoredGatewayCredential,
  ): Promise<string> {
    const secret = await this.vault.open(
      principal,
      credential.credentialIri,
      route.provider.id,
      credential.encryptedSecret,
    );
    if (this.vault.needsRewrap?.(credential.encryptedSecret) && this.credentials.rewrapCredential) {
      const rewrapped = await this.vault.rewrap(principal, credential.encryptedSecret);
      await this.credentials.rewrapCredential({
        webId: principal.webId,
        deployment: this.deployment,
        credentialId: credential.id,
        expectedVersion: credential.version,
        encryptedSecret: rewrapped,
      });
    }
    const apiKey = secret.apiKey ?? secret.accessToken ?? secret.token;
    if (typeof apiKey !== 'string' || !apiKey) {
      throw new GatewayProtocolError('Credential secret does not contain a usable provider token', {
        code: 'credential_unavailable',
        status: 403,
        details: { provider: route.provider.id, credentialId: credential.id },
      });
    }
    return apiKey;
  }

  private async recordRouteFailure(webId: string, route: ModelRouteResult, error: unknown): Promise<void> {
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : error instanceof GatewayProtocolError
        ? error.status
        : undefined;
    if (status === 429) {
      await this.router.recordCooldown({
        webId,
        deployment: this.deployment,
        credentialId: route.credential.id,
        until: new Date(this.now().getTime() + 60_000),
      });
    }
    const normalized = normalizeGatewayError(error);
    await this.credentials.recordFailure?.({
      ...healthRecord(webId, this.deployment, route),
      status,
      errorCode: normalized.error.code,
    });
  }

  private requirePrincipal(auth: AuthContext): { webId: string } {
    const webId = getWebId(auth);
    if (!webId) {
      throw new GatewayProtocolError('Gateway requests require a Solid WebID principal', {
        code: 'invalid_request',
        status: 401,
      });
    }
    return { webId };
  }

  private requireScope(auth: AuthContext, scope: string): void {
    if (!hasGatewayScope(auth, scope)) {
      throw new GatewayProtocolError(`Missing required scope: ${scope}`, {
        code: 'invalid_request',
        status: 403,
        details: { scope },
      });
    }
  }
}

function hashProvenanceValue(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function requestedRouteModel(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}

function isCredentialModelVisible(credential: StoredGatewayCredential, now: Date): boolean {
  return credential.enabled
    && (!credential.health || credential.health === 'healthy')
    && credential.quota?.status !== 'exhausted'
    && (!credential.cooldownUntil || credential.cooldownUntil.getTime() <= now.getTime());
}

function validateGatewayRequest(request: GatewayRequest, protocol: GatewayProtocol): void {
  if (!request.model) {
    throw new GatewayProtocolError('model is required', {
      code: 'invalid_request',
      status: 400,
      details: { protocol, field: 'model' },
    });
  }
  if (request.messages.length === 0) {
    throw new GatewayProtocolError('messages or input are required', {
      code: 'invalid_request',
      status: 400,
      details: { protocol, field: protocol === 'responses' ? 'input' : 'messages' },
    });
  }
}

function parseImageGenerationRequest(body: unknown, mode: 'generation' | 'edit'): ProviderImageGenerationRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayProtocolError('Image generation request must be an object', {
      code: 'invalid_request',
      status: 400,
    });
  }
  const record = body as Record<string, unknown>;
  const provider = nonEmptyString(record.provider);
  const requestedModel = nonEmptyString(record.model);
  const prompt = nonEmptyString(record.prompt);
  if (!requestedModel) {
    throw new GatewayProtocolError('model is required', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'model' },
    });
  }
  if (!prompt) {
    throw new GatewayProtocolError('prompt is required', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'prompt' },
    });
  }
  if (prompt.length > 32_000) {
    throw new GatewayProtocolError('prompt exceeds the 32000 character limit', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'prompt' },
    });
  }
  const explicitProvider = requestedModel.includes('/') ? requestedModel.split('/', 1)[0] : undefined;
  if (provider && explicitProvider && normalizeProviderId(provider) !== normalizeProviderId(explicitProvider)) {
    throw new GatewayProtocolError('provider conflicts with the model route', {
      code: 'invalid_request',
      status: 400,
      details: { provider, model: requestedModel },
    });
  }
  const n = record.n === undefined ? undefined : Number(record.n);
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 4)) {
    throw new GatewayProtocolError('n must be an integer between 1 and 4', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'n' },
    });
  }
  const responseFormat = record.response_format ?? record.responseFormat;
  if (responseFormat !== undefined && responseFormat !== 'b64_json' && responseFormat !== 'url') {
    throw new GatewayProtocolError('response_format must be b64_json or url', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'response_format' },
    });
  }
  const image = parseImageEditInput(record.image);
  if (mode === 'edit' && !image) {
    throw new GatewayProtocolError('image is required for image editing', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'image' },
    });
  }
  if (mode === 'generation' && image) {
    throw new GatewayProtocolError('image is only accepted by the image edits endpoint', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'image' },
    });
  }
  return {
    model: provider && !explicitProvider ? `${normalizeProviderId(provider)}/${requestedModel}` : requestedModel,
    prompt,
    ...(n !== undefined ? { n } : {}),
    ...(nonEmptyString(record.size) ? { size: nonEmptyString(record.size) } : {}),
    ...(nonEmptyString(record.quality) ? { quality: nonEmptyString(record.quality) } : {}),
    ...(nonEmptyString(record.style) ? { style: nonEmptyString(record.style) } : {}),
    ...(responseFormat ? { responseFormat } : {}),
    ...(image ? { image } : {}),
  };
}

function parseImageEditInput(value: unknown): ProviderImageGenerationRequest['image'] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayProtocolError('image must be an object', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'image' },
    });
  }
  const image = value as Record<string, unknown>;
  const encoded = nonEmptyString(image.data);
  const mimeType = nonEmptyString(image.mime_type ?? image.mimeType)?.toLowerCase();
  if (!encoded || !mimeType || !/^image\/(?:png|jpeg|webp)$/u.test(mimeType)) {
    throw new GatewayProtocolError('image requires base64 data and a PNG, JPEG, or WebP MIME type', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'image' },
    });
  }
  const normalized = encoded.replace(/^data:[^;]+;base64,/iu, '').replace(/\s+/gu, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
    throw new GatewayProtocolError('image data must be valid base64', {
      code: 'invalid_request',
      status: 400,
      details: { field: 'image.data' },
    });
  }
  const data = Buffer.from(normalized, 'base64');
  if (data.byteLength === 0 || data.byteLength > 25 * 1024 * 1024) {
    throw new GatewayProtocolError('image must be between 1 byte and 25 MB', {
      code: 'invalid_request',
      status: 413,
      details: { field: 'image.data' },
    });
  }
  const requestedName = nonEmptyString(image.name) ?? 'image.png';
  const name = requestedName.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 128) || 'image.png';
  return { data, mimeType, name };
}

function explicitImageCredentialId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  return nonEmptyString(record.credential)
    ?? nonEmptyString(record.credential_id)
    ?? nonEmptyString(record.xpod_credential_id);
}

function normalizeImageGenerationResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayProtocolError('Image provider returned an invalid response', {
      code: 'provider_error',
      status: 502,
    });
  }
  const record = value as Record<string, unknown>;
  const data = Array.isArray(record.data)
    ? record.data.flatMap((entry): Record<string, unknown>[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const image = entry as Record<string, unknown>;
        const b64Json = nonEmptyString(image.b64_json);
        const url = nonEmptyString(image.url);
        if (!b64Json && !url) return [];
        if (b64Json && !isBoundedImageBase64(b64Json)) {
          throw new GatewayProtocolError('Image provider returned invalid or oversized image data', {
            code: 'provider_error',
            status: 502,
          });
        }
        if (url && !isSafeImageResultUrl(url)) {
          throw new GatewayProtocolError('Image provider returned an unsafe image URL', {
            code: 'provider_error',
            status: 502,
          });
        }
        return [{
          ...(b64Json ? { b64_json: b64Json } : {}),
          ...(url ? { url } : {}),
          ...(nonEmptyString(image.revised_prompt) ? { revised_prompt: nonEmptyString(image.revised_prompt) } : {}),
        }];
      })
    : [];
  if (data.length === 0) {
    throw new GatewayProtocolError('Image provider returned no image data', {
      code: 'provider_error',
      status: 502,
    });
  }
  return {
    created: typeof record.created === 'number' && Number.isFinite(record.created)
      ? record.created
      : Math.floor(Date.now() / 1000),
    data,
  };
}

function isBoundedImageBase64(value: string): boolean {
  const maxLength = Math.ceil((25 * 1024 * 1024) / 3) * 4 + 4;
  return value.length <= maxLength
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/u.test(value);
}

function isSafeImageResultUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname));
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function conversationIdFor(request: GatewayRequest): string | undefined {
  const extensions = request.protocolExtensions.responses ?? request.protocolExtensions.chatCompletions ?? request.protocolExtensions.anthropic;
  return request.previousResponseId
    ?? stringExtension(extensions, 'conversation')
    ?? stringExtension(extensions, 'conversation_id')
    ?? stringExtension(extensions, 'thread_id');
}

function explicitCredentialIdFor(request: GatewayRequest): string | undefined {
  const extensions = request.protocolExtensions.responses ?? request.protocolExtensions.chatCompletions ?? request.protocolExtensions.anthropic;
  return stringExtension(extensions, 'credential')
    ?? stringExtension(extensions, 'credential_id')
    ?? stringExtension(extensions, 'xpod_credential_id');
}

function stringExtension(extensions: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = extensions?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function runtimeCredentialFromMetadata(metadata: Record<string, unknown> | undefined): ProviderRuntimeCredential | undefined {
  const runtime = metadata?.runtimeCredential;
  return runtime && typeof runtime === 'object' && !Array.isArray(runtime)
    ? runtime as ProviderRuntimeCredential
    : undefined;
}

function healthRecord(webId: string, deployment: string, route: ModelRouteResult): GatewayCredentialHealthRecord {
  return {
    webId,
    deployment,
    provider: route.provider.id,
    credentialId: route.credential.id,
    credentialIri: route.credential.credentialIri,
  };
}

function aggregateEvents(
  protocol: GatewayProtocol,
  model: string,
  events: GatewayEvent[],
  now: Date,
): Record<string, unknown> {
  const state = collectEventState(events);
  if (protocol === 'responses') {
    return {
      id: state.id ?? `resp_${now.getTime()}`,
      object: 'response',
      created_at: Math.floor(now.getTime() / 1000),
      status: 'completed',
      model,
      output: [
        ...(state.reasoning ? [{
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: state.reasoning }],
          ...(state.reasoningSignatures[0] ? { encrypted_content: state.reasoningSignatures[0].signature } : {}),
        }] : []),
        {
          type: 'message',
          role: 'assistant',
          content: state.text ? [{
            type: 'output_text',
            text: state.text,
            ...(state.annotations.length > 0 ? { annotations: state.annotations } : {}),
          }] : [],
        },
        ...state.tools.map((tool) => ({
          type: 'function_call',
          call_id: tool.id,
          name: tool.name,
          arguments: tool.arguments,
        })),
      ],
      usage: openAiUsage(state.usage),
    };
  }
  if (protocol === 'anthropic') {
    return {
      id: state.id ?? `msg_${now.getTime()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [
        ...(state.reasoning ? [{
          type: 'thinking',
          thinking: state.reasoning,
          ...(state.reasoningSignatures[0] ? { signature: state.reasoningSignatures[0].signature } : {}),
        }] : []),
        ...(state.text ? [{ type: 'text', text: state.text }] : []),
        ...state.tools.map((tool) => ({
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: parseJsonOrString(tool.arguments),
        })),
      ],
      stop_reason: state.finishReason ?? 'end_turn',
      usage: anthropicUsage(state.usage),
    };
  }
  return {
    id: state.id ?? `chatcmpl_${now.getTime()}`,
    object: 'chat.completion',
    created: Math.floor(now.getTime() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: state.text || null,
        ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
        ...(state.reasoningSignatures[0] ? { reasoning_signature: state.reasoningSignatures[0].signature } : {}),
        ...(state.tools.length > 0 ? {
          tool_calls: state.tools.map((tool) => ({
            id: tool.id,
            type: 'function',
            function: {
              name: tool.name,
              arguments: tool.arguments,
            },
          })),
        } : {}),
      },
      finish_reason: state.finishReason ?? 'stop',
    }],
    usage: chatUsage(state.usage),
  };
}

function collectEventState(events: GatewayEvent[]): {
  id?: string;
  text: string;
  usage?: GatewayUsage;
  finishReason?: string;
  tools: Array<{ id: string; name: string; arguments: string }>;
  reasoning: string;
  annotations: Record<string, unknown>[];
  reasoningSignatures: Array<{ provider: string; signature: string }>;
} {
  const tools = new Map<string, { id: string; name: string; arguments: string }>();
  let id: string | undefined;
  let text = '';
  let reasoning = '';
  const annotations = new Map<string, Record<string, unknown>>();
  const reasoningSignatures: Array<{ provider: string; signature: string }> = [];
  let usage: GatewayUsage | undefined;
  let finishReason: string | undefined;
  for (const event of events) {
    if (event.type === 'response.started') {
      id = event.id;
    } else if (event.type === 'text.delta') {
      text += event.text;
    } else if (event.type === 'text.annotations') {
      for (const annotation of event.annotations) {
        annotations.set(JSON.stringify(annotation), annotation);
      }
    } else if (event.type === 'reasoning.delta') {
      reasoning += event.text;
    } else if (event.type === 'reasoning.signature') {
      reasoningSignatures.push({ provider: event.provider, signature: event.signature });
    } else if (event.type === 'tool.started') {
      tools.set(event.callId, { id: event.callId, name: event.name, arguments: '' });
    } else if (event.type === 'tool.arguments.delta') {
      const tool = tools.get(event.callId);
      if (tool) {
        tool.arguments += event.delta;
      }
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'response.completed') {
      finishReason = event.finishReason;
    }
  }
  return {
    id,
    text,
    usage,
    finishReason,
    tools: Array.from(tools.values()),
    reasoning,
    annotations: Array.from(annotations.values()),
    reasoningSignatures,
  };
}

function chatUsage(usage: GatewayUsage | undefined): Record<string, number> {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
  };
}

function openAiUsage(usage: GatewayUsage | undefined): Record<string, number> {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
  };
}

function anthropicUsage(usage: GatewayUsage | undefined): Record<string, number> {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
  };
}

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return value;
  }
}
