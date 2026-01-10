import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../handlers/ChatHandler';
import type { InternalPodService } from './InternalPodService';
import { type AuthContext, getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';

// Create a proxy-aware fetch function
function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

export class VercelChatService {
  private readonly logger = getLoggerFor(this);

  public constructor(private readonly podService: InternalPodService) {
    this.logger.info('Initializing VercelChatService with Pod-based config support');
  }

  private async getProviderConfig(userId: string, auth: AuthContext) {
    let config: any;
    try {
      config = await this.podService.getAiConfig(userId, auth);
      this.logger.info(`Pod config for ${userId}: ${JSON.stringify(config)}`);
    } catch (error) {
      this.logger.warn(`Failed to get Pod config for ${userId}, falling back to env: ${error}`);
      config = undefined;
    }

    // Priority: Pod Config > Environment Variable > Default (Ollama)
    // Proxy only from Pod config (proxyUrl field)
    let baseURL = config?.baseUrl || process.env.XPOD_AI_BASE_URL;
    let apiKey = config?.apiKey || process.env.XPOD_AI_API_KEY;
    const proxy = config?.proxyUrl; // Only use proxy if configured in Pod

    // Special handling for Google/Gemini if configured in env
    if (!baseURL && !apiKey && process.env.GOOGLE_API_KEY) {
      baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai';
      apiKey = process.env.GOOGLE_API_KEY;
    }

    // Default to local Ollama if nothing else found
    baseURL = baseURL || 'http://localhost:11434/v1';
    apiKey = apiKey || 'ollama';

    this.logger.info(`Provider config: baseURL=${baseURL}, proxy=${proxy || 'none'}`);
    return { baseURL, apiKey, proxy };
  }

  private async getProvider(userId: string, auth: AuthContext) {
    const { baseURL, apiKey, proxy } = await this.getProviderConfig(userId, auth);

    this.logger.debug(`Using AI Provider: ${baseURL} (key length: ${apiKey?.length || 0}, proxy: ${proxy || 'none'})`);

    const options: any = { baseURL, apiKey };
    if (proxy) {
      options.fetch = createProxyFetch(proxy);
    }

    return createOpenAI(options);
  }

  public async complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse> {
    const { model, messages, temperature, max_tokens } = request;
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';

    try {
      const provider = await this.getProvider(userId, auth);
      
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
      this.logger.error(`AI completion failed for user ${userId}: ${error}`);
      throw error;
    }
  }

  public async stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any> {
    const { model, messages, temperature, max_tokens } = request;
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';

    const provider = await this.getProvider(userId, auth);

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
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    const { baseURL, apiKey, proxy } = await this.getProviderConfig(userId, auth);

    // Remove trailing slash if present
    const cleanBaseUrl = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const url = `${cleanBaseUrl}/responses`;

    this.logger.info(`Proxying responses request to ${url} for ${displayName} (acc: ${accountId}), proxy: ${proxy || 'none'}`);

    const fetchFn = proxy ? createProxyFetch(proxy) : fetch;
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
      throw new Error(`Provider error: ${response.statusText}`);
    }

    return response.json();
  }

  public async messages(body: any, auth: AuthContext): Promise<any> {
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    const { baseURL, apiKey, proxy } = await this.getProviderConfig(userId, auth);

    // Remove trailing slash if present
    const cleanBaseUrl = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const url = `${cleanBaseUrl}/messages`;

    this.logger.info(`Proxying messages request to ${url} for ${displayName} (acc: ${accountId}), proxy: ${proxy || 'none'}`);

    const fetchFn = proxy ? createProxyFetch(proxy) : fetch;
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
      throw new Error(`Provider error: ${response.statusText}`);
    }

    return response.json();
  }

  public async listModels(auth?: AuthContext): Promise<any[]> {
    // If auth provided, try to get models from Pod
    if (auth) {
      try {
        const podModels = await this.podService.listModels(auth);
        if (podModels.length > 0) {
          return podModels.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: m.providerId || 'user',
            display_name: m.displayName,
            type: m.modelType,
          }));
        }
      } catch (error) {
        this.logger.warn(`Failed to list models from Pod: ${error}`);
      }
    }

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

  private mapFinishReason(reason: string): 'stop' | 'length' | 'content_filter' {
    return reason as any;
  }
}
