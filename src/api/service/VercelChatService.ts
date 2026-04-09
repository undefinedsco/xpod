import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../handlers/ChatHandler';
import type { PodChatKitStore } from '../chatkit/pod-store';
import type { StoreContext } from '../chatkit/store';
import { type AuthContext, getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';
import { CredentialStatus } from '../../credential/schema/types';
import type { UsageRepository } from '../../storage/quota/UsageRepository';
import type { QuotaService } from '../../quota/QuotaService';
import {
  getDefaultBaseUrl,
  supportsResponsesApi,
  supportsMessagesApi,
} from './provider-registry';
import {
  getAiGatewayApiKey,
  getAiGatewayBaseUrl,
  getPlatformApiBaseUrl,
  getPlatformApiKey,
  getPlatformDefaultModel,
  getPlatformTimeoutMs,
} from './platform-ai-config';

// Create a proxy-aware fetch function
function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  proxy?: string;
  credentialId?: string;
}

interface AiGatewayModelCache {
  fetchedAt: number;
  items: any[];
  modelIds: Set<string>;
}

export class VercelChatService {
  private static readonly AI_GATEWAY_MODEL_CACHE_TTL_MS = 30_000;
  private readonly logger = getLoggerFor(this);
  private usageRepo?: UsageRepository;
  private quotaService?: QuotaService;
  private aiGatewayModelCache: AiGatewayModelCache | null = null;
  private aiGatewayModelCachePromise: Promise<AiGatewayModelCache | null> | null = null;

  public constructor(private readonly store: PodChatKitStore) {
    this.logger.info('Initializing VercelChatService with Pod-based config support');
  }

  /**
   * Set optional usage tracking dependencies (injected after construction)
   */
  public setUsageTracking(usageRepo: UsageRepository, quotaService: QuotaService): void {
    this.usageRepo = usageRepo;
    this.quotaService = quotaService;
  }

  /**
   * Create a StoreContext from AuthContext for Pod operations
   */
  private createStoreContext(auth: AuthContext): StoreContext {
    return {
      userId: getWebId(auth) ?? getAccountId(auth) ?? 'anonymous',
      auth,
    };
  }

  private getAiGatewayBaseUrl(): string | null {
    return getAiGatewayBaseUrl() ?? null;
  }

  private getAiGatewayTimeoutMs(): number {
    return getPlatformTimeoutMs();
  }

  private getAiGatewayApiKey(): string | null {
    return getAiGatewayApiKey() ?? null;
  }

  private toModelId(model: any): string {
    return typeof model?.id === 'string' ? model.id : JSON.stringify(model);
  }

  private isAiGatewayModelCacheFresh(): boolean {
    return !!this.aiGatewayModelCache
      && Date.now() - this.aiGatewayModelCache.fetchedAt < VercelChatService.AI_GATEWAY_MODEL_CACHE_TTL_MS;
  }

  private async getAiGatewayModelCache(): Promise<AiGatewayModelCache | null> {
    if (!this.getAiGatewayBaseUrl()) {
      return null;
    }

    if (this.isAiGatewayModelCacheFresh()) {
      return this.aiGatewayModelCache;
    }

    if (this.aiGatewayModelCachePromise) {
      return this.aiGatewayModelCachePromise;
    }

    this.aiGatewayModelCachePromise = (async() => {
      const response = await this.sendAiGatewayRequest('/v1/models', 'GET', undefined, {
        'Accept': 'application/json',
      });
      const data = await response.json() as { data?: any[] };
      const items = Array.isArray(data.data) ? data.data : [];
      const cache: AiGatewayModelCache = {
        fetchedAt: Date.now(),
        items,
        modelIds: new Set(items.map((item) => this.toModelId(item))),
      };
      this.aiGatewayModelCache = cache;
      return cache;
    })();

    try {
      return await this.aiGatewayModelCachePromise;
    } catch (error) {
      if (this.aiGatewayModelCache) {
        this.logger.warn(`Failed to refresh ai-gateway models, using stale cache: ${error}`);
        return this.aiGatewayModelCache;
      }
      this.logger.warn(`Failed to fetch ai-gateway models: ${error}`);
      return null;
    } finally {
      this.aiGatewayModelCachePromise = null;
    }
  }

  private async shouldUseAiGateway(model?: string): Promise<boolean> {
    if (!model || !this.getAiGatewayBaseUrl()) {
      return false;
    }

    const cache = await this.getAiGatewayModelCache();
    return cache?.modelIds.has(model) ?? false;
  }

  private buildAiGatewayUrl(path: string): string {
    const baseUrl = this.getAiGatewayBaseUrl();
    if (!baseUrl) {
      throw new Error('DEFAULT_API_BASE is not configured');
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (baseUrl.endsWith('/v1') && normalizedPath.startsWith('/v1/')) {
      return `${baseUrl}${normalizedPath.slice(3)}`;
    }

    return `${baseUrl}${normalizedPath}`;
  }

  private createAiGatewayAbortSignal(): AbortSignal | undefined {
    const abortSignal = AbortSignal as typeof AbortSignal & {
      timeout?: (milliseconds: number) => AbortSignal;
    };
    return typeof abortSignal.timeout === 'function'
      ? abortSignal.timeout(this.getAiGatewayTimeoutMs())
      : undefined;
  }

  private async sendAiGatewayRequest(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    headers?: HeadersInit,
  ): Promise<Response> {
    const apiKey = this.getAiGatewayApiKey();
    if (!apiKey) {
      throw new Error('DEFAULT_API_KEY is not configured');
    }

    const requestHeaders = new Headers(headers);
    requestHeaders.set('Authorization', `Bearer ${apiKey}`);
    if (body !== undefined && !requestHeaders.has('Content-Type')) {
      requestHeaders.set('Content-Type', 'application/json');
    }

    const response = await fetch(this.buildAiGatewayUrl(path), {
      method,
      headers: requestHeaders,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: this.createAiGatewayAbortSignal(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.logger.warn(`Platform AI request failed: ${response.status} ${errorText}`);

      const error = new Error(`Platform AI error: ${response.status} ${response.statusText}`);
      (error as any).status = response.status;
      (error as any).headers = response.headers;
      (error as any).body = errorText;
      throw error;
    }

    return response;
  }

  private async forwardAiGatewayJson(path: string, body: unknown, _auth: AuthContext): Promise<any> {
    const response = await this.sendAiGatewayRequest(path, 'POST', body, {
      'Accept': 'application/json',
    });
    return response.json();
  }

  private async forwardAiGatewayStream(path: string, body: unknown, _auth: AuthContext): Promise<{
    toTextStreamResponse: () => Response;
  }> {
    const response = await this.sendAiGatewayRequest(path, 'POST', body, {
      'Accept': 'text/event-stream',
    });

    return {
      toTextStreamResponse: () => new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      }),
    };
  }

  private extractCompletionText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((item) => item && typeof item === 'object' && typeof (item as any).text === 'string')
        .map((item) => (item as any).text)
        .join('\n');
    }

    return content == null ? '' : String(content);
  }

  private buildChatCompletionsBodyFromMessages(body: any): Record<string, unknown> {
    const messages: Array<{ role: string; content: string }> = [];

    if (body?.system) {
      const systemText = this.extractCompletionText(body.system);
      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }

    if (Array.isArray(body?.messages)) {
      for (const message of body.messages) {
        if (!message?.role || message?.content == null) {
          continue;
        }

        messages.push({
          role: String(message.role),
          content: this.extractCompletionText(message.content),
        });
      }
    }

    if (messages.length === 0 && body?.content != null) {
      messages.push({
        role: 'user',
        content: this.extractCompletionText(body.content),
      });
    }

    return {
      model: body?.model,
      messages,
      ...(body?.temperature != null ? { temperature: body.temperature } : {}),
      ...(body?.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
      ...(Array.isArray(body?.stop_sequences) && body.stop_sequences.length > 0
        ? { stop: body.stop_sequences }
        : {}),
    };
  }

  private mapChatCompletionFinishReason(reason: string | null | undefined): string {
    if (reason === 'length') {
      return 'max_tokens';
    }
    if (reason === 'content_filter') {
      return 'stop_sequence';
    }
    return 'end_turn';
  }

  private mapChatCompletionToMessagesResponse(body: any, completion: any): any {
    const choice = Array.isArray(completion?.choices) ? completion.choices[0] : undefined;
    const text = this.extractCompletionText(choice?.message?.content);
    const prompt = this.extractPromptFromMessagesBody(body);

    return {
      id: completion?.id ?? `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: completion?.model ?? body?.model,
      content: [{ type: 'text', text }],
      stop_reason: this.mapChatCompletionFinishReason(choice?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: completion?.usage?.prompt_tokens ?? prompt.length,
        output_tokens: completion?.usage?.completion_tokens ?? text.length,
      },
    };
  }

  private extractTotalTokens(usage: any): number {
    if (!usage || typeof usage !== 'object') {
      return 0;
    }

    if (typeof usage.total_tokens === 'number') {
      return usage.total_tokens;
    }
    if (typeof usage.totalTokens === 'number') {
      return usage.totalTokens;
    }
    if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
      return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
      return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    }

    return 0;
  }

  private recordForwardedUsage(accountId: string | undefined, podId: string, payload: any): void {
    const totalTokens = this.extractTotalTokens(payload?.usage);
    if (accountId && totalTokens > 0) {
      this.recordTokenUsage(accountId, podId, totalTokens);
    }
  }

  private async getProviderConfig(context: StoreContext): Promise<ProviderConfig | null> {
    let config: Awaited<ReturnType<PodChatKitStore['getAiConfig']>> | undefined;
    try {
      config = await this.store.getAiConfig(context);
      this.logger.info(`Pod config: ${JSON.stringify(config)}`);
    } catch (error) {
      this.logger.warn(`Failed to get Pod config, falling back to defaults: ${error}`);
      config = undefined;
    }

    // Priority: Pod config > Platform Provider
    if (config?.apiKey) {
      const baseURL = config.baseUrl || getDefaultBaseUrl();
      const proxy = config.proxyUrl;
      this.logger.info(`Provider config: baseURL=${baseURL}, proxy=${proxy || 'none'} (source=pod)`);
      return { baseURL, apiKey: config.apiKey, proxy, credentialId: config.credentialId };
    }

    // 平台 Provider
    const platformBase = getPlatformApiBaseUrl();
    if (platformBase) {
      this.logger.info(`Provider config: baseURL=${platformBase}, proxy=none (source=platform)`);
      return { baseURL: platformBase, apiKey: getPlatformApiKey(), proxy: undefined, credentialId: undefined };
    }

    this.logger.warn('No AI provider config found in Pod or DEFAULT_API_BASE');
    return null;
  }

  private async getProvider(context: StoreContext) {
    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or set DEFAULT_API_BASE.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const { baseURL, apiKey, proxy } = providerConfig;

    this.logger.debug(`Using AI Provider: ${baseURL} (key length: ${apiKey?.length || 0}, proxy: ${proxy || 'none'})`);

    const options: any = { baseURL, apiKey };
    if (proxy) {
      options.fetch = createProxyFetch(proxy);
    }

    return createOpenAI(options);
  }

  public async complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse> {
    const { model, messages, temperature, max_tokens } = request;
    const context = this.createStoreContext(auth);
    const accountId = getAccountId(auth);
    if (accountId) {
      await this.checkTokenQuota(accountId);
    }

    if (await this.shouldUseAiGateway(model)) {
      this.logger.info(`Forwarding chat completion for model ${model} to ai-gateway`);
      const result = await this.forwardAiGatewayJson('/v1/chat/completions', request, auth) as ChatCompletionResponse;
      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    }

    const config = await this.getProviderConfig(context);
    if (!config) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or set DEFAULT_API_BASE.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    try {
      const provider = await this.getProvider(context);

      const coreMessages: any[] = messages.map((m) => ({
        role: m.role as any,
        content: m.content,
      }));

      const result = await generateText({
        model: provider.chat(model),
        messages: coreMessages,
        temperature,
        maxTokens: max_tokens,
      } as any);

      // Record successful API call
      if (config?.credentialId) {
        this.store.recordCredentialSuccess(context, config.credentialId).catch((err) => {
          this.logger.debug(`Failed to record credential success: ${err}`);
        });
      }

      // Record token usage
      const totalTokens = (result.usage as any)?.totalTokens ?? 0;
      if (accountId && totalTokens > 0) {
        this.recordTokenUsage(accountId, String(context.userId), totalTokens);
      }

      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.text,
            },
            finish_reason: this.mapFinishReason(result.finishReason),
          },
        ],
        usage: {
          prompt_tokens: (result.usage as any).promptTokens,
          completion_tokens: (result.usage as any).completionTokens,
          total_tokens: (result.usage as any).totalTokens,
        },
      };
    } catch (error) {
      this.logger.error(`AI completion failed: ${error}`);

      // Handle error and update credential status
      if (config?.credentialId) {
        await this.handleApiError(error, context, config.credentialId);
      }

      throw error;
    }
  }

  public async stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any> {
    const { model, messages, temperature, max_tokens } = request;
    const context = this.createStoreContext(auth);

    if (await this.shouldUseAiGateway(model)) {
      this.logger.info(`Forwarding chat stream for model ${model} to ai-gateway`);
      return this.forwardAiGatewayStream('/v1/chat/completions', request, auth);
    }

    const config = await this.getProviderConfig(context);

    if (!config) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or set DEFAULT_API_BASE.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const provider = await this.getProvider(context);

    const coreMessages: any[] = messages.map((m) => ({
      role: m.role as any,
      content: m.content,
    }));

    return streamText({
      model: provider.chat(model),
      messages: coreMessages,
      temperature,
      maxTokens: max_tokens,
    } as any);
  }

  public async responses(body: any, auth: AuthContext): Promise<any> {
    const context = this.createStoreContext(auth);
    const displayName = getDisplayName(auth) || context.userId;
    const accountId = getAccountId(auth);

    if (await this.shouldUseAiGateway(body?.model)) {
      this.logger.info(`Forwarding responses request for model ${body?.model} to ai-gateway for ${displayName} (acc: ${accountId})`);
      const result = await this.forwardAiGatewayJson('/v1/responses', body, auth);
      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    }

    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or set DEFAULT_API_BASE.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const { baseURL } = providerConfig;

    // Only OpenAI natively supports /v1/responses; all others go through Chat Completions
    if (!supportsResponsesApi(baseURL)) {
      this.logger.info(`Provider ${baseURL} does not support Responses API, converting to Chat Completions for ${displayName} (acc: ${accountId})`);
      return this.responsesViaCompletions(body, context, providerConfig);
    }

    const { apiKey, proxy, credentialId } = providerConfig;

    // Remove trailing slash if present
    const cleanBaseUrl = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const url = `${cleanBaseUrl}/responses`;

    this.logger.info(`Proxying responses request to ${url} for ${displayName} (acc: ${accountId}), proxy: ${proxy || 'none'}`);

    const fetchFn = proxy ? createProxyFetch(proxy) : fetch;

    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Responses API failed: ${response.status} ${errorText}`);

        // Handle error and update credential status
        if (credentialId) {
          await this.handleApiError(
            { status: response.status, headers: response.headers },
            context,
            credentialId,
          );
        }

        throw new Error(`Provider error: ${response.statusText}`);
      }

      // Record successful API call
      if (credentialId) {
        this.store.recordCredentialSuccess(context, credentialId).catch(() => {});
      }

      return response.json();
    } catch (error) {
      if (credentialId && !(error instanceof Error && error.message.startsWith('Provider error'))) {
        await this.handleApiError(error, context, credentialId);
      }
      throw error;
    }
  }

  public async messages(body: any, auth: AuthContext): Promise<any> {
    const context = this.createStoreContext(auth);
    const displayName = getDisplayName(auth) || context.userId;
    const accountId = getAccountId(auth);

    if (await this.shouldUseAiGateway(body?.model)) {
      this.logger.info(`Forwarding messages request for model ${body?.model} to ai-gateway for ${displayName} (acc: ${accountId})`);
      const completionBody = this.buildChatCompletionsBodyFromMessages(body);
      const completion = await this.forwardAiGatewayJson('/v1/chat/completions', completionBody, auth);
      const result = this.mapChatCompletionToMessagesResponse(body, completion);
      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    }

    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or set DEFAULT_API_BASE.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const { baseURL } = providerConfig;

    // Only Anthropic natively supports /v1/messages; all others go through Chat Completions
    if (!supportsMessagesApi(baseURL)) {
      this.logger.info(`Provider ${baseURL} does not support Messages API, converting to Chat Completions for ${displayName} (acc: ${accountId})`);
      return this.messagesViaCompletions(body, context, providerConfig);
    }

    const { apiKey, proxy, credentialId } = providerConfig;

    // Remove trailing slash if present
    const cleanBaseUrl = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const url = `${cleanBaseUrl}/messages`;

    this.logger.info(`Proxying messages request to ${url} for ${displayName} (acc: ${accountId}), proxy: ${proxy || 'none'}`);

    const fetchFn = proxy ? createProxyFetch(proxy) : fetch;

    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Messages API failed: ${response.status} ${errorText}`);

        // Handle error and update credential status
        if (credentialId) {
          await this.handleApiError(
            { status: response.status, headers: response.headers },
            context,
            credentialId,
          );
        }

        throw new Error(`Provider error: ${response.statusText}`);
      }

      // Record successful API call
      if (credentialId) {
        this.store.recordCredentialSuccess(context, credentialId).catch(() => {});
      }

      return response.json();
    } catch (error) {
      if (credentialId && !(error instanceof Error && error.message.startsWith('Provider error'))) {
        await this.handleApiError(error, context, credentialId);
      }
      throw error;
    }
  }




  private async responsesViaCompletions(
    body: any,
    context: StoreContext,
    providerConfig: { baseURL: string; apiKey: string; proxy?: string; credentialId?: string },
  ): Promise<any> {
    const prompt = this.extractPromptFromResponsesBody(body);
    const model = body?.model || getPlatformDefaultModel();

    const provider = await this.getProvider(context);
    const result = await generateText({
      model: provider.chat(model),
      messages: [{ role: 'user' as const, content: prompt }],
      ...(body?.temperature != null ? { temperature: body.temperature } : {}),
      ...(body?.max_output_tokens != null ? { maxTokens: body.max_output_tokens } : {}),
    } as any);

    if (providerConfig.credentialId) {
      this.store.recordCredentialSuccess(context, providerConfig.credentialId).catch(() => {});
    }

    const outputText = result.text;
    const now = Math.floor(Date.now() / 1000);
    return {
      id: `resp_${Date.now()}`,
      object: 'response',
      created: now,
      status: 'completed',
      model,
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: outputText }],
      }],
      usage: {
        input_tokens: (result.usage as any)?.promptTokens ?? prompt.length,
        output_tokens: (result.usage as any)?.completionTokens ?? outputText.length,
        total_tokens: (result.usage as any)?.totalTokens ?? (prompt.length + outputText.length),
      },
    };
  }

  private async messagesViaCompletions(
    body: any,
    context: StoreContext,
    providerConfig: { baseURL: string; apiKey: string; proxy?: string; credentialId?: string },
  ): Promise<any> {
    const prompt = this.extractPromptFromMessagesBody(body);
    const model = body?.model || getPlatformDefaultModel();

    const coreMessages: any[] = [];
    if (body?.system) {
      const systemText = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((b: any) => b?.text ?? '').join('\n')
          : '';
      if (systemText) {
        coreMessages.push({ role: 'system', content: systemText });
      }
    }
    if (Array.isArray(body?.messages)) {
      for (const msg of body.messages) {
        if (msg?.role && msg?.content != null) {
          const content = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
              : String(msg.content);
          coreMessages.push({ role: msg.role, content });
        }
      }
    }
    if (coreMessages.length === 0) {
      coreMessages.push({ role: 'user', content: prompt });
    }

    const provider = await this.getProvider(context);
    const result = await generateText({
      model: provider.chat(model),
      messages: coreMessages,
      ...(body?.temperature != null ? { temperature: body.temperature } : {}),
      ...(body?.max_tokens != null ? { maxTokens: body.max_tokens } : {}),
    } as any);

    if (providerConfig.credentialId) {
      this.store.recordCredentialSuccess(context, providerConfig.credentialId).catch(() => {});
    }

    const text = result.text;
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: (result.usage as any)?.promptTokens ?? prompt.length,
        output_tokens: (result.usage as any)?.completionTokens ?? text.length,
      },
    };
  }

  private extractPromptFromResponsesBody(body: any): string {
    if (!body || typeof body !== 'object') {
      return '';
    }

    if (typeof body.input === 'string') {
      return body.input;
    }

    if (typeof body.prompt === 'string') {
      return body.prompt;
    }

    if (Array.isArray(body.input)) {
      const textParts: string[] = [];
      for (const item of body.input) {
        if (item && typeof item === 'object') {
          const candidate = (item as any).content;
          if (typeof candidate === 'string') {
            textParts.push(candidate);
          } else if (Array.isArray(candidate)) {
            for (const part of candidate) {
              if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
                textParts.push((part as any).text);
              }
            }
          }
        }
      }
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }

    return '';
  }

  private extractPromptFromMessagesBody(body: any): string {
    if (!body || typeof body !== 'object') {
      return '';
    }

    if (typeof body.content === 'string') {
      return body.content;
    }

    if (Array.isArray(body.messages)) {
      const lastUser = [...body.messages].reverse().find((item: any) => item?.role === 'user');
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          return lastUser.content;
        }
        if (Array.isArray(lastUser.content)) {
          return lastUser.content
            .filter((part: any) => part && typeof part === 'object' && typeof part.text === 'string')
            .map((part: any) => part.text)
            .join('\n');
        }
      }
    }

    return '';
  }

  public async listModels(_auth?: AuthContext): Promise<any[]> {
    const models: any[] = [];
    const seenModelIds = new Set<string>();

    const pushModels = (items: any[]): void => {
      for (const model of items) {
        const modelId = this.toModelId(model);
        if (seenModelIds.has(modelId)) {
          continue;
        }
        seenModelIds.add(modelId);
        models.push(model);
      }
    };

    const aiGatewayCache = await this.getAiGatewayModelCache();
    if (aiGatewayCache) {
      pushModels(aiGatewayCache.items);
    }

    // 平台 Provider 模型（从 DEFAULT_API_BASE 获取）
    const platformBase = getPlatformApiBaseUrl();
    const platformKey = getPlatformApiKey();
    const aiGatewayBase = this.getAiGatewayBaseUrl();
    const normalizedAiGatewayModelsUrl = aiGatewayBase
      ? this.buildAiGatewayUrl('/v1/models')
      : undefined;
    const normalizedPlatformModelsUrl = platformBase
      ? `${platformBase.replace(/\/$/, '')}/models`
      : undefined;
    if (platformBase && normalizedPlatformModelsUrl !== normalizedAiGatewayModelsUrl) {
      try {
        const url = normalizedPlatformModelsUrl!;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (platformKey) {
          headers['Authorization'] = `Bearer ${platformKey}`;
        }
        const resp = await fetch(url, { headers });
        if (resp.ok) {
          const data = await resp.json() as { data?: any[] };
          if (Array.isArray(data.data)) {
            pushModels(data.data);
          }
        } else {
          this.logger.warn(`Failed to fetch platform models: ${resp.status}`);
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch platform models: ${error}`);
      }
    }

    // TODO: 合并用户 Pod Providers 的模型
    return models;
  }

  private mapFinishReason(reason: string): 'stop' | 'length' | 'content_filter' {
    return reason as any;
  }

  /**
   * Handle API errors and update credential status accordingly
   */
  private async handleApiError(
    error: unknown,
    context: StoreContext,
    credentialId: string,
  ): Promise<void> {
    const errorInfo = this.parseApiError(error);

    if (errorInfo.statusCode === 429) {
      // Rate limit error - mark credential as rate limited
      const resetAt = errorInfo.retryAfter
        ? new Date(Date.now() + errorInfo.retryAfter * 1000)
        : new Date(Date.now() + 60000); // Default 1 minute cooldown

      this.logger.warn(`Rate limit hit for credential ${credentialId}, reset at: ${resetAt.toISOString()}`);

      await this.store.updateCredentialStatus(
        context,
        credentialId,
        CredentialStatus.RATE_LIMITED,
        { rateLimitResetAt: resetAt },
      );
    } else if (errorInfo.statusCode === 401 || errorInfo.statusCode === 403) {
      // Auth error - mark credential as inactive
      this.logger.warn(`Auth error for credential ${credentialId}, marking as inactive`);

      await this.store.updateCredentialStatus(
        context,
        credentialId,
        CredentialStatus.INACTIVE,
        { incrementFailCount: true },
      );
    } else if (errorInfo.statusCode >= 500) {
      // Server error - increment fail count but keep active
      this.logger.warn(`Server error ${errorInfo.statusCode} for credential ${credentialId}`);

      await this.store.updateCredentialStatus(
        context,
        credentialId,
        CredentialStatus.ACTIVE,
        { incrementFailCount: true },
      );
    }
  }

  /**
   * Parse error to extract status code and retry-after header
   */
  private parseApiError(error: unknown): { statusCode: number; retryAfter?: number } {
    // Handle different error formats from AI SDK
    if (error && typeof error === 'object') {
      const err = error as any;

      // Direct status code
      if (typeof err.status === 'number') {
        return {
          statusCode: err.status,
          retryAfter: err.retryAfter || err.headers?.['retry-after'],
        };
      }

      // Nested response object
      if (err.response && typeof err.response.status === 'number') {
        return {
          statusCode: err.response.status,
          retryAfter: err.response.headers?.get?.('retry-after'),
        };
      }

      // Error message parsing (fallback)
      if (err.message) {
        const match = err.message.match(/(\d{3})/);
        if (match) {
          return { statusCode: parseInt(match[1], 10) };
        }
      }
    }

    return { statusCode: 0 };
  }

  /**
   * Check if account has remaining token quota
   */
  private async checkTokenQuota(accountId: string): Promise<void> {
    if (!this.quotaService || !this.usageRepo) {
      return; // No quota enforcement if not configured
    }

    try {
      const quota = await this.quotaService.getAccountQuota(accountId);
      if (!quota.tokenLimitMonthly) {
        return; // No limit set
      }

      const usage = await this.usageRepo.getAccountUsage(accountId);
      const tokensUsed = usage?.tokensUsed ?? 0;

      if (tokensUsed >= quota.tokenLimitMonthly) {
        const err = new Error('Token quota exceeded for this month');
        (err as any).code = 'quota_exceeded';
        throw err;
      }
    } catch (error) {
      if ((error as any).code === 'quota_exceeded') {
        throw error;
      }
      // Log but don't block on quota check errors
      this.logger.warn(`Token quota check failed: ${error}`);
    }
  }

  /**
   * Record token usage (fire-and-forget)
   */
  private recordTokenUsage(accountId: string, podId: string, tokens: number): void {
    if (!this.usageRepo) {
      return;
    }

    this.usageRepo.incrementTokenUsage(accountId, podId, tokens).catch((err) => {
      this.logger.warn(`Failed to record token usage: ${err}`);
    });
  }
}
