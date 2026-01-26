/**
 * AI Provider Adapter
 *
 * Adapts existing AI services to the ChatKit AiProvider interface.
 * Includes 429 rate limit handling with credential status backfill.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { streamText, APICallError } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { AiProvider } from './service';
import type { StoreContext } from './store';
import type { PodChatKitStore } from './pod-store';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, getAccountId } from '../auth/AuthContext';
import { CredentialStatus } from '../../credential/schema/types';

// Create a proxy-aware fetch function
function createProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  return (url, init) => fetch(url, { ...init, dispatcher: agent } as any);
}

export interface VercelAiProviderOptions {
  store: PodChatKitStore;
}

/**
 * Vercel AI SDK based provider
 *
 * Uses PodChatKitStore to get AI provider settings from Pod.
 * Reuses the same Session cached in StoreContext.
 */
export class VercelAiProvider implements AiProvider {
  private readonly logger = getLoggerFor(this);
  private readonly store: PodChatKitStore;

  public constructor(options: VercelAiProviderOptions) {
    this.store = options.store;
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
    // Get context (contains auth and cached session)
    const context = options?.context as StoreContext | undefined;
    const auth = context?.auth as AuthContext | undefined;
    const userId = auth ? (getWebId(auth) ?? getAccountId(auth) ?? 'anonymous') : 'anonymous';

    // 从 Pod 获取配置（复用 context 中缓存的 Session）
    const config = await this.getProviderConfig(context);
    const model = options?.model ?? config.defaultModel ?? 'gemini-3-flash-preview';

    this.logger.debug(`Streaming response for ${userId}, model: ${model}`);

    const provider = this.createProvider(config);

    try {
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
    } catch (error) {
      // Handle 429 rate limit errors
      if (this.isRateLimitError(error)) {
        await this.handleRateLimitError(error, context, config.credentialId);
      }
      throw error;
    }
  }

  /**
   * Check if error is a 429 rate limit error
   */
  private isRateLimitError(error: unknown): boolean {
    if (error instanceof APICallError) {
      return error.statusCode === 429;
    }
    // Check for generic error with status
    if (error && typeof error === 'object') {
      const err = error as any;
      return err.status === 429 || err.statusCode === 429 || err.code === 'rate_limit_exceeded';
    }
    return false;
  }

  /**
   * Handle 429 rate limit error by updating credential status
   */
  private async handleRateLimitError(
    error: unknown,
    context: StoreContext | undefined,
    credentialId: string | undefined,
  ): Promise<void> {
    if (!context || !credentialId) {
      this.logger.debug('Cannot update credential status: missing context or credentialId');
      return;
    }

    // Parse Retry-After header if available
    let rateLimitResetAt: Date | undefined;
    if (error instanceof APICallError && error.responseHeaders) {
      const retryAfter = error.responseHeaders['retry-after'];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          rateLimitResetAt = new Date(Date.now() + seconds * 1000);
        } else {
          // Try parsing as HTTP date
          const date = new Date(retryAfter);
          if (!isNaN(date.getTime())) {
            rateLimitResetAt = date;
          }
        }
      }
    }

    // Default to 60 seconds if no Retry-After header
    if (!rateLimitResetAt) {
      rateLimitResetAt = new Date(Date.now() + 60 * 1000);
    }

    this.logger.warn(
      `Rate limited for credential ${credentialId}, reset at ${rateLimitResetAt.toISOString()}`,
    );

    try {
      await this.store.updateCredentialStatus(context, credentialId, CredentialStatus.RATE_LIMITED, {
        rateLimitResetAt,
        incrementFailCount: true,
      });
    } catch (updateError) {
      this.logger.error(`Failed to update credential status: ${updateError}`);
    }
  }

  private async getProviderConfig(context: StoreContext | undefined): Promise<{
    baseURL: string;
    apiKey: string;
    proxy?: string;
    defaultModel?: string;
    credentialId?: string;
  }> {
    let config: Awaited<ReturnType<PodChatKitStore['getAiConfig']>> | undefined;

    if (context) {
      try {
        config = await this.store.getAiConfig(context);
        this.logger.debug(`Pod config: ${JSON.stringify(config)}`);
      } catch (error) {
        this.logger.warn(`Failed to get Pod config, falling back to env: ${error}`);
        config = undefined;
      }
    }

    // Priority: Pod Config > Environment Variable > Default (Ollama)
    let baseURL = config?.baseUrl || process.env.XPOD_AI_BASE_URL;
    let apiKey = config?.apiKey || process.env.XPOD_AI_API_KEY;
    const proxy = config?.proxyUrl;

    // Special handling for Google/Gemini
    if (!baseURL && !apiKey && process.env.GOOGLE_API_KEY) {
      baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai';
      apiKey = process.env.GOOGLE_API_KEY;
    }

    // Default to local Ollama
    baseURL = baseURL || 'http://localhost:11434/v1';
    apiKey = apiKey || 'ollama';

    return { baseURL, apiKey, proxy, credentialId: config?.credentialId };
  }

  private createProvider(config: { baseURL: string; apiKey: string; proxy?: string }) {
    const { baseURL, apiKey, proxy } = config;

    this.logger.debug(`Using AI Provider: ${baseURL} (proxy: ${proxy || 'none'})`);

    const options: any = { baseURL, apiKey };
    if (proxy) {
      options.fetch = createProxyFetch(proxy);
    }

    return createOpenAI(options);
  }
}
