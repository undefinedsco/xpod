import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../handlers/ChatHandler';
import type { PodChatKitStore } from '../chatkit/pod-store';
import type { StoreContext } from '../chatkit/store';
import { type AuthContext, getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';
import { isDefaultAgentAvailable, runDefaultAgent, streamDefaultAgent, type DefaultAgentContext } from '../chatkit/default-agent';
import { CredentialStatus } from '../../credential/schema/types';

// Create a proxy-aware fetch function
function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

export class VercelChatService {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly store: PodChatKitStore) {
    this.logger.info('Initializing VercelChatService with Pod-based config support');
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


  private getDefaultBaseUrl(provider?: string): string {
    const normalized = (provider || 'openrouter').toLowerCase();
    const urls: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
      google: 'https://generativelanguage.googleapis.com/v1beta/openai',
      anthropic: 'https://api.anthropic.com/v1',
      deepseek: 'https://api.deepseek.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      ollama: 'http://localhost:11434/v1',
      mistral: 'https://api.mistral.ai/v1',
      cohere: 'https://api.cohere.ai/v1',
      zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    };
    return urls[normalized] || urls.openrouter;
  }

  private async getProviderConfig(context: StoreContext): Promise<{
    baseURL: string;
    apiKey: string;
    proxy?: string;
    credentialId?: string;
  } | null> {
    let config: Awaited<ReturnType<PodChatKitStore['getAiConfig']>> | undefined;
    try {
      config = await this.store.getAiConfig(context);
      this.logger.info(`Pod config: ${JSON.stringify(config)}`);
    } catch (error) {
      this.logger.warn(`Failed to get Pod config, falling back to defaults: ${error}`);
      config = undefined;
    }

    // Priority: Pod config > DEFAULT_API_KEY env > Default Agent fallback
    if (config?.apiKey) {
      const baseURL = config.baseUrl || this.getDefaultBaseUrl('openrouter');
      const proxy = config.proxyUrl;
      this.logger.info(`Provider config: baseURL=${baseURL}, proxy=${proxy || 'none'} (source=pod)`);
      return { baseURL, apiKey: config.apiKey, proxy, credentialId: config.credentialId };
    }

    if (process.env.DEFAULT_API_KEY) {
      const provider = process.env.DEFAULT_PROVIDER || 'openrouter';
      const baseURL = process.env.DEFAULT_BASE_URL || this.getDefaultBaseUrl(provider);
      this.logger.info(`Provider config: baseURL=${baseURL}, proxy=none (source=default-env)`);
      return { baseURL, apiKey: process.env.DEFAULT_API_KEY, proxy: undefined, credentialId: undefined };
    }

    this.logger.warn('No AI provider config found in Pod or DEFAULT_API_KEY');
    return null;
  }

  private async getProvider(context: StoreContext) {
    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or DEFAULT_API_KEY');
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
    const config = await this.getProviderConfig(context);

    if (!config) {
      return this.completeWithDefaultAgent(messages, auth, model);
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
    const config = await this.getProviderConfig(context);

    if (!config) {
      return this.streamWithDefaultAgent(messages, auth, model);
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

    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      return this.responsesWithDefaultAgent(body, auth);
    }

    const { baseURL, apiKey, proxy, credentialId } = providerConfig;

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

    const providerConfig = await this.getProviderConfig(context);
    if (!providerConfig) {
      return this.messagesWithDefaultAgent(body, auth);
    }

    const { baseURL, apiKey, proxy, credentialId } = providerConfig;

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


  private async responsesWithDefaultAgent(body: any, auth: AuthContext): Promise<any> {
    const prompt = this.extractPromptFromResponsesBody(body);
    const result = await runDefaultAgent(prompt, this.buildDefaultAgentContext(auth));

    if (!result.success) {
      const err = new Error(result.error || 'Default Agent is not available');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const outputText = result.content;
    const now = Math.floor(Date.now() / 1000);

    return {
      id: `resp_${Date.now()}`,
      object: 'response',
      created: now,
      status: 'completed',
      model: body?.model || process.env.DEFAULT_MODEL || 'stepfun/step-3.5-flash:free',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: outputText }],
      }],
      usage: {
        input_tokens: prompt.length,
        output_tokens: outputText.length,
        total_tokens: prompt.length + outputText.length,
      },
    };
  }

  private async messagesWithDefaultAgent(body: any, auth: AuthContext): Promise<any> {
    const prompt = this.extractPromptFromMessagesBody(body);
    const result = await runDefaultAgent(prompt, this.buildDefaultAgentContext(auth));

    if (!result.success) {
      const err = new Error(result.error || 'Default Agent is not available');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const text = result.content;
    return {
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: body?.model || process.env.DEFAULT_MODEL || 'stepfun/step-3.5-flash:free',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: prompt.length,
        output_tokens: text.length,
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
    // TODO: Get models from Pod when store.listModels is implemented
    // Fallback to default models
    return [
      {
        id: 'llama3',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'ollama',
      },
      {
        id: 'gpt-4o',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'openai',
      },
    ];
  }

  private async completeWithDefaultAgent(
    messages: ChatCompletionRequest['messages'],
    auth: AuthContext,
    requestedModel: string,
  ): Promise<ChatCompletionResponse> {
    const agentContext = this.buildDefaultAgentContext(auth);
    const prompt = messages.filter((m) => m.role === 'user').pop()?.content || '';

    const result = await runDefaultAgent(prompt, agentContext);
    if (!result.success) {
      const err = new Error(result.error || 'Default Agent is not available');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const completionTokens = result.content.length;
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: prompt.length,
        completion_tokens: completionTokens,
        total_tokens: prompt.length + completionTokens,
      },
    };
  }

  private async streamWithDefaultAgent(
    messages: ChatCompletionRequest['messages'],
    auth: AuthContext,
    _requestedModel: string,
  ): Promise<{ toTextStreamResponse: () => Response }> {
    const agentContext = this.buildDefaultAgentContext(auth);
    const prompt = messages.filter((m) => m.role === 'user').pop()?.content || '';

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for await (const chunk of streamDefaultAgent(prompt, agentContext)) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return {
      toTextStreamResponse: () => new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Vercel-AI-Data-Stream': 'v1',
        },
      }),
    };
  }

  private buildDefaultAgentContext(auth: AuthContext): DefaultAgentContext {
    if (!isDefaultAgentAvailable()) {
      const err = new Error('No AI provider configured. Please configure Pod AI provider or DEFAULT_API_KEY');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const webId = getWebId(auth);
    if (!webId) {
      const err = new Error('No WebID in auth context');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const solidToken = this.getSolidToken(auth);
    if (!solidToken) {
      const err = new Error('No Solid token available for Default Agent');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    return {
      solidToken,
      podBaseUrl: this.getPodBaseUrlFromWebId(webId),
      webId,
    };
  }

  private getPodBaseUrlFromWebId(webId: string): string {
    const url = new URL(webId);
    if (url.pathname.endsWith('/profile/card')) {
      const podPath = url.pathname.replace('/profile/card', '');
      return `${url.protocol}//${url.host}${podPath}/`;
    }
    return `${url.protocol}//${url.host}/`;
  }

  private getSolidToken(auth: AuthContext): string | undefined {
    const candidate = auth as any;
    if (typeof candidate.token === 'string') {
      return candidate.token;
    }
    if (typeof candidate.accessToken === 'string') {
      return candidate.accessToken;
    }
    if (candidate.credentials && typeof candidate.credentials === 'object') {
      if (typeof candidate.credentials.accessToken === 'string') {
        return candidate.credentials.accessToken;
      }
      if (typeof candidate.credentials.token === 'string') {
        return candidate.credentials.token;
      }
    }
    return undefined;
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
}
