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
import { isDefaultAgentAvailable, streamDefaultAgent, type DefaultAgentContext } from './default-agent';

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

    // 从 Pod 获取配置
    const config = await this.getProviderConfig(context);

    // 无有效配置，降级到 Default Agent
    if (!config) {
      this.logger.info(`No valid AI config for ${userId}, falling back to Default Agent`);
      yield* this.streamWithDefaultAgent(messages, context);
      return;
    }

    const model = options?.model ?? config.defaultModel ?? process.env.DEFAULT_MODEL ?? 'stepfun/step-3.5-flash:free';

    this.logger.debug(`Streaming response for ${userId}, model: ${model}`);

    const provider = this.createProvider(config);

    try {
      const result = streamText({
        model: provider.chat(model),
        messages: messages as any,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        system: `You are a helpful AI assistant running on Xpod (a Solid Pod-based platform).

Your capabilities:
1. Help users with various tasks
2. Use user's configured provider/model to respond consistently

Current AI Provider: ${config.baseURL.includes('openrouter') ? 'OpenRouter (Free)' : 'Custom'}
Model: ${model}
`,
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

    let rateLimitResetAt: Date | undefined;
    if (error instanceof APICallError && error.responseHeaders) {
      const retryAfter = error.responseHeaders['retry-after'];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
          rateLimitResetAt = new Date(Date.now() + seconds * 1000);
        } else {
          const date = new Date(retryAfter);
          if (!isNaN(date.getTime())) {
            rateLimitResetAt = date;
          }
        }
      }
    }

    if (!rateLimitResetAt) {
      rateLimitResetAt = new Date(Date.now() + 60 * 1000);
    }

    this.logger.warn(`Rate limited for credential ${credentialId}, reset at ${rateLimitResetAt.toISOString()}`);

    try {
      await this.store.updateCredentialStatus(context, credentialId, CredentialStatus.RATE_LIMITED, {
        rateLimitResetAt,
        incrementFailCount: true,
      });
    } catch (updateError) {
      this.logger.error(`Failed to update credential status: ${updateError}`);
    }
  }

  private async getProviderConfig(
    context: StoreContext | undefined,
  ): Promise<{
    baseURL: string;
    apiKey: string;
    proxy?: string;
    defaultModel?: string;
    credentialId?: string;
  } | null> {
    let config: Awaited<ReturnType<PodChatKitStore['getAiConfig']>> | undefined;

    if (context) {
      try {
        config = await this.store.getAiConfig(context);
        this.logger.debug(`Pod config: ${JSON.stringify(config)}`);
      } catch (error) {
        this.logger.debug(`Failed to get Pod config: ${error}`);
        config = undefined;
      }
    }

    // 用户 Pod 有配置，优先使用
    if (config?.apiKey) {
      return {
        baseURL: config.baseUrl || this.getDefaultBaseUrl('openrouter'),
        apiKey: config.apiKey,
        proxy: config.proxyUrl,
        credentialId: config.credentialId,
      };
    }

    // 环境变量配置（开发/测试用）
    if (process.env.XPOD_AI_API_KEY) {
      return {
        baseURL: process.env.XPOD_AI_BASE_URL || 'https://openrouter.ai/api/v1',
        apiKey: process.env.XPOD_AI_API_KEY,
      };
    }

    // Google API Key 特殊处理
    if (process.env.GOOGLE_API_KEY) {
      return {
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: process.env.GOOGLE_API_KEY,
      };
    }

    // OpenRouter API Key
    if (process.env.OPENROUTER_API_KEY) {
      return {
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
      };
    }

    // 无有效配置，返回 null 表示需要降级到 Default Agent
    this.logger.debug('No valid AI config found, will use Default Agent');
    return null;
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

  private getPodBaseUrlFromWebId(webId: string): string {
    try {
      const url = new URL(webId);
      url.hash = '';  // 清除 fragment
      const pathParts = url.pathname.split('/');
      if (pathParts.includes('profile')) {
        const profileIndex = pathParts.indexOf('profile');
        url.pathname = pathParts.slice(0, profileIndex).join('/');
      }
      return url.toString().replace(/\/$/, '') + '/';
    } catch {
      return '';
    }
  }

  private getDefaultBaseUrl(provider: string): string {
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
    return urls[provider.toLowerCase()] || urls.openrouter;
  }

  /**
   * 使用 Default Agent 流式响应
   */
  private async *streamWithDefaultAgent(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    context: StoreContext | undefined,
  ): AsyncIterable<string> {
    // 检查 Default Agent 是否可用
    if (!isDefaultAgentAvailable()) {
      yield '抱歉，您还没有配置 AI 服务，且系统默认 AI 也未配置。请先配置您的 AI API Key。';
      return;
    }

    // 构建 Default Agent 上下文
    const auth = context?.auth as AuthContext | undefined;
    const webId = auth ? getWebId(auth) : undefined;

    if (!webId) {
      yield '抱歉，无法获取您的身份信息，请先登录。';
      return;
    }

    const podBaseUrl = this.getPodBaseUrlFromWebId(webId);
    const solidToken = this.getSolidToken(context);

    if (!solidToken) {
      yield '抱歉，无法获取访问令牌，请重新登录。';
      return;
    }

    const agentContext: DefaultAgentContext = {
      solidToken,
      podBaseUrl,
      webId,
    };

    // 获取最后一条用户消息
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()?.content || '';

    try {
      yield* streamDefaultAgent(lastUserMessage, agentContext);
    } catch (error) {
      this.logger.error(`Default Agent error: ${error}`);
      yield `抱歉，Default Agent 出现错误：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * 从上下文获取 Solid Token
   */
  private getSolidToken(context: StoreContext | undefined): string | undefined {
    // 尝试从 context 中获取 token
    // 这里需要根据实际的 auth 实现来获取
    const auth = context?.auth as AuthContext | undefined;
    if (!auth) return undefined;

    // 如果 auth 中有 token，直接返回
    if ('token' in auth && typeof auth.token === 'string') {
      return auth.token;
    }

    // 如果有 accessToken
    if ('accessToken' in auth && typeof auth.accessToken === 'string') {
      return auth.accessToken;
    }

    // 尝试从 credentials 获取
    if ('credentials' in auth && auth.credentials) {
      const creds = auth.credentials as any;
      if (creds.accessToken) return creds.accessToken;
      if (creds.token) return creds.token;
    }

    return undefined;
  }
}
