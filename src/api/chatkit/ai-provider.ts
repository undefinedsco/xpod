import { getLoggerFor } from 'global-logger-factory';
import type { AiProvider } from './service';
import type { StoreContext } from './store';
import type { PodChatKitStore } from './pod-store';
import type { AuthContext } from '../auth/AuthContext';
import type { AiGatewayService } from '../ai-gateway/AiGatewayService';

export interface VercelAiProviderOptions {
  store: PodChatKitStore;
  aiGatewayService?: Pick<AiGatewayService, 'execute'>;
}

/**
 * @deprecated Direct ChatKit AI fallback adapter.
 *
 * Product ChatKit traffic normally uses Agent Runtime. When direct fallback is
 * explicitly enabled for tests/dev harnesses, this adapter still executes via
 * AI Connection instead of reopening Pod provider credentials or platform env
 * API-key fallbacks.
 */
export class VercelAiProvider implements AiProvider {
  private readonly logger = getLoggerFor(this);
  private readonly aiGatewayService?: Pick<AiGatewayService, 'execute'>;

  public constructor(options: VercelAiProviderOptions) {
    void options.store;
    this.aiGatewayService = options.aiGatewayService;
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
    const gateway = this.requireAiGatewayService();
    const context = options?.context as StoreContext | undefined;
    const auth = context?.auth as AuthContext | undefined;
    if (!auth) {
      throw new Error('AuthContext is required for AI Connection inference');
    }

    this.logger.debug(`Streaming direct ChatKit fallback via AI Connection, model: ${options?.model ?? ''}`);
    const execution = await gateway.execute({
      auth,
      protocol: 'chatCompletions',
      body: {
        model: options?.model ?? '',
        messages,
        stream: true,
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      },
    });

    for await (const event of execution.events) {
      if (event.type === 'text.delta') {
        yield event.text;
      }
    }
  }

  private requireAiGatewayService(): Pick<AiGatewayService, 'execute'> {
    if (!this.aiGatewayService) {
      throw new Error('AiGatewayService is required for ChatKit direct AI fallback');
    }
    return this.aiGatewayService;
  }
}
