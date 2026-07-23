import { GatewayProtocolError, normalizeGatewayError } from './errors';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, hasGatewayScope } from '../auth/AuthContext';
import type { CredentialVault } from './credentials/CredentialVault';
import type { EncryptedCredentialSecret } from './credentials/KeyWrapper';
import { ChatCompletionsFrontend, MessagesFrontend, ResponsesFrontend } from './protocol';
import type { ProviderRuntimeCredential } from './providers/ProviderRuntimeAdapter';
import type { ProviderCapabilities, ProviderRegistry } from './providers/ProviderRegistry';
import { normalizeProviderId } from './providers/ProviderRegistry';
import type { ProviderRuntimeRegistry } from './providers/ProviderRuntimeRegistry';
import type { GatewayCredentialCandidate, ModelRouter, ModelRouteResult } from './routing/ModelRouter';
import type {
  GatewayEvent,
  GatewayProtocol,
  GatewayProtocolFrontend,
  GatewayRequest,
  GatewayUsage,
} from './types';

export interface StoredGatewayCredential extends GatewayCredentialCandidate {
  encryptedSecret: EncryptedCredentialSecret;
  runtimeCredential?: ProviderRuntimeCredential;
}

export interface GatewayCredentialStore {
  listCredentials(input: {
    webId: string;
    deployment: string;
  }): Promise<StoredGatewayCredential[]>;
  recordSuccess?(input: GatewayCredentialHealthRecord): Promise<void>;
  recordFailure?(input: GatewayCredentialHealthRecord): Promise<void>;
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

  public async listModels(auth: AuthContext): Promise<GatewayModelListItem[]> {
    this.requireScope(auth, 'models:read');
    const principal = this.requirePrincipal(auth);
    const credentials = await this.credentials.listCredentials({
      webId: principal.webId,
      deployment: this.deployment,
    });
    const activeProviders = new Set(
      credentials
        .filter(isCredentialModelVisible)
        .map((credential) => normalizeProviderId(credential.provider)),
    );
    const seen = new Set<string>();
    const models: GatewayModelListItem[] = [];
    for (const provider of this.registry.listProviders()) {
      if (!activeProviders.has(normalizeProviderId(provider.id))) {
        continue;
      }
      for (const model of provider.models) {
        if (seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        models.push({
          id: model.id,
          object: 'model',
          owned_by: provider.id,
          ...(model.contextWindow !== undefined ? { context_window: model.contextWindow } : {}),
          ...(model.capabilities ? { capabilities: model.capabilities } : {}),
          ...(model.protocols ? { protocols: model.protocols } : {}),
        });
      }
    }
    return models;
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
        const adapter = this.runtimes.get(route.provider.id);
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
    const candidates = await this.credentials.listCredentials({ webId, deployment: this.deployment });
    const next = candidates
      .filter((credential) => normalizeProviderId(credential.provider) === normalizeProviderId(failedRoute.provider.id))
      .filter((credential) => !attempted.has(credential.id))
      .sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100))[0];
    if (!next) {
      return undefined;
    }
    return {
      ...failedRoute,
      credential: next,
      failover: {
        allowedBeforeFirstEvent: true,
        committed: false,
        clientEventEmitted: false,
      },
    };
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

function isCredentialModelVisible(credential: StoredGatewayCredential): boolean {
  return credential.enabled
    && (!credential.health || credential.health === 'healthy')
    && credential.quota?.status !== 'exhausted';
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
        {
          type: 'message',
          role: 'assistant',
          content: state.text ? [{ type: 'output_text', text: state.text }] : [],
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
} {
  const tools = new Map<string, { id: string; name: string; arguments: string }>();
  let id: string | undefined;
  let text = '';
  let usage: GatewayUsage | undefined;
  let finishReason: string | undefined;
  for (const event of events) {
    if (event.type === 'response.started') {
      id = event.id;
    } else if (event.type === 'text.delta') {
      text += event.text;
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
