import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../handlers/ChatHandler';
import type { PodChatKitStore } from '../chatkit/pod-store';
import type { StoreContext } from '../chatkit/store';
import {
  type AuthContext,
  getAccountId,
  getDisplayName,
  getWebId,
  hasSolidClientCredentialsAuthority,
} from '../auth/AuthContext';
import { CredentialStatus } from '../../credential/schema/types';
import type { QuotaService } from '../../quota/QuotaService';
import type { UsageRepository } from '../../storage/quota/UsageRepository';
import {
  getAiGatewayApiKey,
  getAiGatewayBaseUrl,
  getPlatformDefaultModel,
  getPlatformGenerationTimeoutMs,
  getPlatformQueryTimeoutMs,
} from './platform-ai-config';
import {
  buildAiGatewayChatCompletionsBody,
  buildAiGatewayResponsesBody,
  buildChatCompletionsBodyFromMessages,
  extractPromptFromMessagesBody,
  extractPromptFromResponsesBody,
  mapChatCompletionToMessagesResponse,
} from './chat-protocol-adapters';
import { AiGatewayTransport } from './ai-gateway-transport';
import { ProviderHttpTransport } from './provider-http-transport';
import { getDefaultBaseUrl, resolveServerProviderTransport } from './provider-registry';
import {
  resolveChatExecutionRoute,
  resolveMessagesProviderRoute,
  resolveResponsesProviderRoute,
} from './chat-routing';

interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  proxy?: string;
  credentialId?: string;
}

function createProviderFetch(proxyUrl?: string): typeof fetch {
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return (url, init) => fetch(url, {
    ...init,
    redirect: 'error',
    ...(agent ? { dispatcher: agent } : {}),
  } as any);
}

function modelIdOf(model: unknown): string {
  return typeof (model as any)?.id === 'string'
    ? (model as any).id
    : JSON.stringify(model);
}

export class VercelChatService {
  private readonly logger = getLoggerFor(this);
  private usageRepo?: UsageRepository;
  private quotaService?: QuotaService;
  private readonly aiGatewayTransport: AiGatewayTransport;
  private readonly providerHttpTransport = new ProviderHttpTransport();
  private readonly platformDefaultModel: string;

  public constructor(private readonly store: PodChatKitStore) {
    this.logger.info('Initializing VercelChatService with xpod API provider routing');
    const aiGatewayBaseUrl = getAiGatewayBaseUrl() ?? null;
    const aiGatewayApiKey = getAiGatewayApiKey() ?? null;
    const platformQueryTimeoutMs = getPlatformQueryTimeoutMs();
    const platformGenerationTimeoutMs = getPlatformGenerationTimeoutMs();
    this.platformDefaultModel = getPlatformDefaultModel();
    this.aiGatewayTransport = new AiGatewayTransport({
      getBaseUrl: () => aiGatewayBaseUrl,
      getApiKey: () => aiGatewayApiKey,
      getQueryTimeoutMs: () => platformQueryTimeoutMs,
      getGenerationTimeoutMs: () => platformGenerationTimeoutMs,
    });
  }

  public setUsageTracking(usageRepo: UsageRepository, quotaService: QuotaService): void {
    this.usageRepo = usageRepo;
    this.quotaService = quotaService;
  }

  private createStoreContext(auth: AuthContext): StoreContext {
    return {
      userId: getWebId(auth) ?? getAccountId(auth) ?? 'anonymous',
      auth,
    };
  }

  private async shouldUseAiGateway(model?: string): Promise<boolean> {
    return this.aiGatewayTransport.shouldHandleModel(model);
  }

  private async forwardAiGatewayJson(path: string, body: unknown): Promise<any> {
    return this.aiGatewayTransport.sendJson(path, body);
  }

  private async forwardAiGatewayStream(path: string, body: unknown): Promise<{
    toTextStreamResponse: () => Response;
  }> {
    return this.aiGatewayTransport.sendStream(path, body);
  }

  private getProviderChatCompletionsUrl(baseURL: string): string {
    const cleanBaseUrl = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    return cleanBaseUrl.endsWith('/chat/completions')
      ? cleanBaseUrl
      : `${cleanBaseUrl}/chat/completions`;
  }

  private async getProviderConfig(context: StoreContext): Promise<ProviderConfig | null> {
    const auth = context.auth as AuthContext | undefined;
    if (!hasSolidClientCredentialsAuthority(auth)) {
      this.logger.warn(`Xpod API cannot read Pod AI config for ${context.userId} without caller-owned Solid client credentials`);
      return null;
    }

    const config = await this.store.getAiConfig(context);
    if (!config?.apiKey) {
      return null;
    }

    const transport = resolveServerProviderTransport({
      providerId: config.providerId || '',
      baseUrl: config.baseUrl || getDefaultBaseUrl(config.providerId),
      proxyUrl: config.proxyUrl,
    });

    return {
      baseURL: transport.baseUrl,
      apiKey: config.apiKey,
      proxy: transport.proxyUrl,
      credentialId: config.credentialId,
    };
  }

  private async getProvider(context: StoreContext) {
    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No user AI provider configured in Pod for this model.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const options: any = {
      baseURL: providerConfig.baseURL,
      apiKey: providerConfig.apiKey,
    };
    options.fetch = createProviderFetch(providerConfig.proxy);

    return createOpenAI(options);
  }

  public async complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse> {
    const { model } = request;
    const context = this.createStoreContext(auth);
    const accountId = getAccountId(auth);
    if (accountId) {
      await this.checkTokenQuota(accountId);
    }

    if (await resolveChatExecutionRoute({
      model,
      shouldUseAiGateway: this.shouldUseAiGateway.bind(this),
    }) === 'ai-gateway') {
      const result = await this.forwardAiGatewayJson('/v1/chat/completions', buildAiGatewayChatCompletionsBody(request)) as ChatCompletionResponse;
      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    }

    const config = await this.getProviderConfig(context);
    if (!config) {
      const err = new Error('No user AI provider configured in Pod for this model.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    try {
      const result = await this.providerHttpTransport.postJson({
        url: this.getProviderChatCompletionsUrl(config.baseURL),
        apiKey: config.apiKey,
        proxy: config.proxy,
        body: request,
      }) as ChatCompletionResponse;

      if (config.credentialId) {
        this.store.recordCredentialSuccess(context, config.credentialId).catch((err) => {
          this.logger.debug(`Failed to record credential success: ${err}`);
        });
      }

      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    } catch (error) {
      if (config.credentialId) {
        await this.handleApiError(error, context, config.credentialId);
      }
      throw error;
    }
  }

  public async stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any> {
    const { model } = request;
    const context = this.createStoreContext(auth);

    if (await resolveChatExecutionRoute({
      model,
      shouldUseAiGateway: this.shouldUseAiGateway.bind(this),
    }) === 'ai-gateway') {
      return this.forwardAiGatewayStream('/v1/chat/completions', buildAiGatewayChatCompletionsBody(request));
    }

    const config = await this.getProviderConfig(context);
    if (!config) {
      const err = new Error('No user AI provider configured in Pod for this model.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const response = await this.providerHttpTransport.postStream({
      url: this.getProviderChatCompletionsUrl(config.baseURL),
      apiKey: config.apiKey,
      proxy: config.proxy,
      body: request,
      headers: {
        Accept: 'text/event-stream',
      },
    });

    return {
      toTextStreamResponse: () => new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      }),
    };
  }

  public async responses(body: any, auth: AuthContext): Promise<any> {
    const context = this.createStoreContext(auth);
    const displayName = getDisplayName(auth) || context.userId;
    const accountId = getAccountId(auth);

    if (await resolveChatExecutionRoute({
      model: body?.model,
      shouldUseAiGateway: this.shouldUseAiGateway.bind(this),
    }) === 'ai-gateway') {
      this.logger.info(`Forwarding responses request for model ${body?.model} to ai-gateway for ${displayName} (acc: ${accountId})`);
      const result = await this.forwardAiGatewayJson('/v1/responses', buildAiGatewayResponsesBody(body));
      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    }

    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No user AI provider configured in Pod for this model.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    if (resolveResponsesProviderRoute(providerConfig.baseURL) === 'chat-fallback') {
      return this.responsesViaCompletions(body, context, providerConfig);
    }

    const cleanBaseUrl = providerConfig.baseURL.endsWith('/')
      ? providerConfig.baseURL.slice(0, -1)
      : providerConfig.baseURL;

    try {
      const result = await this.providerHttpTransport.postJson({
        url: `${cleanBaseUrl}/responses`,
        apiKey: providerConfig.apiKey,
        proxy: providerConfig.proxy,
        body,
      });
      if (providerConfig.credentialId) {
        this.store.recordCredentialSuccess(context, providerConfig.credentialId).catch(() => {});
      }
      return result;
    } catch (error) {
      if (providerConfig.credentialId) {
        await this.handleApiError(error, context, providerConfig.credentialId);
      }
      throw error;
    }
  }

  public async messages(body: any, auth: AuthContext): Promise<any> {
    const context = this.createStoreContext(auth);
    const displayName = getDisplayName(auth) || context.userId;
    const accountId = getAccountId(auth);

    if (await resolveChatExecutionRoute({
      model: body?.model,
      shouldUseAiGateway: this.shouldUseAiGateway.bind(this),
    }) === 'ai-gateway') {
      this.logger.info(`Forwarding messages request for model ${body?.model} to ai-gateway for ${displayName} (acc: ${accountId})`);
      const completion = await this.forwardAiGatewayJson(
        '/v1/chat/completions',
        buildChatCompletionsBodyFromMessages(body),
      );
      const result = mapChatCompletionToMessagesResponse(body, completion);
      this.recordForwardedUsage(accountId, String(context.userId), result);
      return result;
    }

    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No user AI provider configured in Pod for this model.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    if (resolveMessagesProviderRoute(providerConfig.baseURL) === 'chat-fallback') {
      return this.messagesViaCompletions(body, context, providerConfig);
    }

    const cleanBaseUrl = providerConfig.baseURL.endsWith('/')
      ? providerConfig.baseURL.slice(0, -1)
      : providerConfig.baseURL;

    try {
      const result = await this.providerHttpTransport.postJson({
        url: `${cleanBaseUrl}/messages`,
        apiKey: providerConfig.apiKey,
        proxy: providerConfig.proxy,
        body,
        headers: {
          'x-api-key': providerConfig.apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (providerConfig.credentialId) {
        this.store.recordCredentialSuccess(context, providerConfig.credentialId).catch(() => {});
      }
      return result;
    } catch (error) {
      if (providerConfig.credentialId) {
        await this.handleApiError(error, context, providerConfig.credentialId);
      }
      throw error;
    }
  }

  public async listModels(auth?: AuthContext): Promise<any[]> {
    const models: any[] = [];
    const indexes = new Map<string, number>();

    const pushOrReplace = (items: any[], options: { replaceExisting?: boolean } = {}) => {
      for (const model of items) {
        const modelId = modelIdOf(model);
        const existingIndex = indexes.get(modelId);
        if (existingIndex === undefined) {
          indexes.set(modelId, models.length);
          models.push(model);
        } else if (options.replaceExisting !== false) {
          models[existingIndex] = model;
        }
      }
    };

    pushOrReplace(await this.aiGatewayTransport.listModels());

    if (auth && hasSolidClientCredentialsAuthority(auth)) {
      try {
        pushOrReplace(await this.store.listAvailableModels(this.createStoreContext(auth)), {
          replaceExisting: false,
        });
      } catch (error) {
        this.logger.warn(`Failed to merge caller-owned Pod models into platform catalog: ${error}`);
      }
    }

    return models;
  }

  private async responsesViaCompletions(
    body: any,
    context: StoreContext,
    providerConfig: ProviderConfig,
  ): Promise<any> {
    const prompt = extractPromptFromResponsesBody(body);
    const model = body?.model || this.platformDefaultModel;
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
    providerConfig: ProviderConfig,
  ): Promise<any> {
    const prompt = extractPromptFromMessagesBody(body);
    const model = body?.model || this.platformDefaultModel;
    const coreMessages: any[] = [];

    if (body?.system) {
      const systemText = typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((item: any) => item?.text ?? '').join('\n')
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
              ? msg.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')
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

  private async handleApiError(
    error: unknown,
    context: StoreContext,
    credentialId: string,
  ): Promise<void> {
    const errorInfo = this.parseApiError(error);

    if (errorInfo.statusCode === 429) {
      const resetAt = errorInfo.retryAfter
        ? new Date(Date.now() + errorInfo.retryAfter * 1000)
        : new Date(Date.now() + 60000);

      await this.store.updateCredentialStatus(
        context,
        credentialId,
        CredentialStatus.RATE_LIMITED,
        { rateLimitResetAt: resetAt },
      );
    } else if (errorInfo.statusCode === 401 || errorInfo.statusCode === 403) {
      await this.store.updateCredentialStatus(
        context,
        credentialId,
        CredentialStatus.INACTIVE,
        { incrementFailCount: true },
      );
    } else if (errorInfo.statusCode >= 500) {
      await this.store.updateCredentialStatus(
        context,
        credentialId,
        CredentialStatus.ACTIVE,
        { incrementFailCount: true },
      );
    }
  }

  private parseApiError(error: unknown): { statusCode: number; retryAfter?: number } {
    if (error && typeof error === 'object') {
      const err = error as any;
      if (typeof err.status === 'number') {
        return {
          statusCode: err.status,
          retryAfter: err.retryAfter || err.headers?.['retry-after'],
        };
      }

      if (err.response && typeof err.response.status === 'number') {
        return {
          statusCode: err.response.status,
          retryAfter: err.response.headers?.get?.('retry-after'),
        };
      }

      if (err.message) {
        const match = err.message.match(/(\d{3})/);
        if (match) {
          return { statusCode: parseInt(match[1], 10) };
        }
      }
    }

    return { statusCode: 0 };
  }

  private async checkTokenQuota(accountId: string): Promise<void> {
    if (!this.quotaService || !this.usageRepo) {
      return;
    }

    try {
      const quota = await this.quotaService.getAccountQuota(accountId);
      if (!quota.tokenLimitMonthly) {
        return;
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
      this.logger.warn(`Token quota check failed: ${error}`);
    }
  }

  private recordTokenUsage(accountId: string, podId: string, tokens: number): void {
    if (!this.usageRepo) {
      return;
    }

    this.usageRepo.incrementTokenUsage(accountId, podId, tokens).catch((err) => {
      this.logger.warn(`Failed to record token usage: ${err}`);
    });
  }
}
