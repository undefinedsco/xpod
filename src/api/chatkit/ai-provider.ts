/**
 * AI Provider Adapter
 * 
 * Adapts existing AI services to the ChatKit AiProvider interface.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { AiProvider } from './service';
import type { InternalPodService } from '../service/InternalPodService';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, getAccountId } from '../auth/AuthContext';

// Create a proxy-aware fetch function
function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

export interface VercelAiProviderOptions {
  podService: InternalPodService;
}

/**
 * Vercel AI SDK based provider
 * 
 * Uses the same configuration as VercelChatService to get AI provider settings from Pod.
 */
export class VercelAiProvider implements AiProvider {
  private readonly logger = getLoggerFor(this);
  private readonly podService: InternalPodService;

  public constructor(options: VercelAiProviderOptions) {
    this.podService = options.podService;
  }

  /**
   * Stream a response for the given messages
   */
  public async *streamResponse(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      context?: unknown;
    },
  ): AsyncIterable<string> {
    // Get auth from options context if provided
    const context = options?.context as Record<string, unknown> | undefined;
    const auth = context?.auth as AuthContext | undefined;
    const userId = auth ? (getWebId(auth) ?? getAccountId(auth) ?? 'anonymous') : 'anonymous';
    
    // 从 Pod 获取配置，包括默认模型
    const config = await this.getProviderConfig(userId, auth);
    const model = options?.model ?? config.defaultModel ?? 'gpt-4o-mini';

    this.logger.debug(`Streaming response for ${userId}, model: ${model}`);

    const provider = await this.getProvider(config);

    const result = streamText({
      model: provider.chat(model),
      messages: messages as any,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    } as any);

    // Stream text chunks
    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }

  private async getProviderConfig(userId: string, auth?: AuthContext) {
    let config: any;
    if (auth) {
      try {
        config = await this.podService.getAiConfig(userId, auth);
        this.logger.debug(`Pod config for ${userId}: ${JSON.stringify(config)}`);
      } catch (error) {
        this.logger.warn(`Failed to get Pod config for ${userId}, falling back to env: ${error}`);
        config = undefined;
      }
    }

    // Priority: Pod Config > Environment Variable > Default (Ollama)
    let baseURL = config?.baseUrl || process.env.XPOD_AI_BASE_URL;
    let apiKey = config?.apiKey || process.env.XPOD_AI_API_KEY;
    const proxy = config?.proxyUrl;
    const defaultModel = config?.defaultModel; // 从 Pod 配置读取默认模型

    // Special handling for Google/Gemini
    if (!baseURL && !apiKey && process.env.GOOGLE_API_KEY) {
      baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai';
      apiKey = process.env.GOOGLE_API_KEY;
    }

    // Default to local Ollama
    baseURL = baseURL || 'http://localhost:11434/v1';
    apiKey = apiKey || 'ollama';

    return { baseURL, apiKey, proxy, defaultModel };
  }

  private async getProvider(config: { baseURL: string; apiKey: string; proxy?: string }) {
    const { baseURL, apiKey, proxy } = config;

    this.logger.debug(`Using AI Provider: ${baseURL} (proxy: ${proxy || 'none'})`);

    const options: any = { baseURL, apiKey };
    if (proxy) {
      options.fetch = createProxyFetch(proxy);
    }

    return createOpenAI(options);
  }
}
