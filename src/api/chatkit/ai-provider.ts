import { createOpenAI } from '@ai-sdk/openai';
import { streamText, APICallError } from 'ai';
import { getLoggerFor } from 'global-logger-factory';
import { ProxyAgent } from 'undici';
import type { AiProvider } from './service';
import type { StoreContext } from './store';
import type { PodChatKitStore } from './pod-store';
import {
  type AuthContext,
  hasSolidClientCredentialsAuthority,
} from '../auth/AuthContext';
import { CredentialStatus } from '../../credential/schema/types';
import {
  getAiGatewayApiKey,
  getAiGatewayBaseUrl,
  getPlatformDefaultModel,
  isSharedPlatformModel,
} from '../service/platform-ai-config';
import { resolveChatExecutionRoute } from '../service/chat-routing';
import { getDefaultBaseUrl, resolveServerProviderTransport } from '../service/provider-registry';

interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  proxy?: string;
  defaultModel?: string;
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

export interface VercelAiProviderOptions {
  store: PodChatKitStore;
}

/**
 * Direct ChatKit AI fallback adapter.
 *
 * Product ChatKit traffic normally uses Agent Runtime. When direct fallback is
 * explicitly enabled for tests/dev harnesses, platform models are sent to the
 * external platform AI gateway using server-only config. User-provider models
 * can read Pod AI settings only through caller-owned Solid client credentials.
 */
export class VercelAiProvider implements AiProvider {
  private readonly logger = getLoggerFor(this);
  private readonly store: PodChatKitStore;

  public constructor(options: VercelAiProviderOptions) {
    this.store = options.store;
  }

  public async *streamResponse(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      context?: unknown;
    },
  ): AsyncIterable<string> {
    const context = options?.context as StoreContext | undefined;
    const auth = context?.auth as AuthContext | undefined;
    const requestedModel = options?.model ?? getPlatformDefaultModel();
    const route = await resolveChatExecutionRoute({
      model: requestedModel,
      shouldUseAiGateway: async(model) => isSharedPlatformModel(model ?? getPlatformDefaultModel()),
    });
    const config = route === 'ai-gateway'
      ? this.getPlatformConfig()
      : await this.getUserProviderConfig(context, auth);
    const model = requestedModel ?? config.defaultModel ?? getPlatformDefaultModel();

    this.logger.debug(`Streaming direct ChatKit fallback, route: ${route}, model: ${model}`);

    const provider = this.createProvider(config);

    try {
      const result = streamText({
        model: provider.chat(model),
        messages: messages as any,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        system: `You are a helpful AI assistant running on Xpod (a Solid Pod-based platform).`,
      } as any);

      for await (const chunk of result.textStream) {
        yield chunk;
      }
    } catch (error) {
      if (route === 'provider' && this.isRateLimitError(error)) {
        await this.handleRateLimitError(error, context, config.credentialId);
      }
      throw error;
    }
  }

  private getPlatformConfig(): ProviderConfig {
    const baseURL = getAiGatewayBaseUrl();
    const apiKey = getAiGatewayApiKey();
    if (!baseURL || !apiKey) {
      throw new Error('DEFAULT_API_BASE and DEFAULT_API_KEY are required for platform AI models');
    }

    return { baseURL, apiKey };
  }

  private async getUserProviderConfig(
    context: StoreContext | undefined,
    auth: AuthContext | undefined,
  ): Promise<ProviderConfig> {
    const userId = context?.userId ?? auth?.type ?? 'anonymous';
    if (!context || !hasSolidClientCredentialsAuthority(auth)) {
      this.logger.warn(`Xpod API cannot read Pod AI config for ${userId} without caller-owned Solid client credentials`);
      const err = new Error('No user AI provider configured for this request.');
      (err as any).code = 'model_not_configured';
      throw err;
    }

    const storeContext: StoreContext = {
      ...context,
      userId: context.userId ?? auth.webId,
      auth,
    };
    const config = await this.store.getAiConfig(storeContext);
    if (config?.apiKey) {
      const transport = resolveServerProviderTransport({
        providerId: config.providerId || '',
        baseUrl: config.baseUrl || getDefaultBaseUrl(config.providerId),
        proxyUrl: config.proxyUrl,
      });
      return {
        baseURL: transport.baseUrl,
        apiKey: config.apiKey,
        proxy: transport.proxyUrl,
        defaultModel: config.defaultModel,
        credentialId: config.credentialId,
      };
    }

    const err = new Error('No user AI provider configured for this request.');
    (err as any).code = 'model_not_configured';
    throw err;
  }

  private createProvider(config: ProviderConfig) {
    const options: any = {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    };
    options.fetch = createProviderFetch(config.proxy);

    return createOpenAI(options);
  }

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
        if (!Number.isNaN(seconds)) {
          rateLimitResetAt = new Date(Date.now() + seconds * 1000);
        } else {
          const date = new Date(retryAfter);
          if (!Number.isNaN(date.getTime())) {
            rateLimitResetAt = date;
          }
        }
      }
    }

    if (!rateLimitResetAt) {
      rateLimitResetAt = new Date(Date.now() + 60_000);
    }

    try {
      await this.store.updateCredentialStatus(context, credentialId, CredentialStatus.RATE_LIMITED, {
        rateLimitResetAt,
        incrementFailCount: true,
      });
    } catch (updateError) {
      this.logger.error(`Failed to update credential status: ${updateError}`);
    }
  }
}
