import { getLoggerFor } from 'global-logger-factory';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../handlers/ChatHandler';
import type { PodChatKitStore } from '../chatkit/pod-store';
import { type AuthContext, getAccountId, getWebId } from '../auth/AuthContext';
import type { AiGatewayService } from '../ai-gateway/AiGatewayService';
import type { GatewayEvent, GatewayProtocol } from '../ai-gateway/types';
import type { UsageRepository } from '../../storage/quota/UsageRepository';
import type { QuotaService } from '../../quota/QuotaService';

export interface VercelChatServiceOptions {
  aiGatewayService?: Pick<AiGatewayService, 'complete' | 'execute' | 'listModels'>;
}

/**
 * @deprecated Compatibility facade for legacy internal ChatService callers.
 *
 * Public `/v1/*` routes are owned by AiGatewayHandler. This class only keeps
 * older ChatKit/internal call sites working while routing every inference and
 * model-list request through the unified AI Connection gateway runtime.
 */
export class VercelChatService {
  private readonly logger = getLoggerFor(this);
  private usageRepo?: UsageRepository;
  private quotaService?: QuotaService;
  private readonly aiGatewayService?: Pick<AiGatewayService, 'complete' | 'execute' | 'listModels'>;

  public constructor(
    private readonly _store: PodChatKitStore,
    options: VercelChatServiceOptions = {},
  ) {
    this.logger.info('Initializing legacy VercelChatService facade with AI Connection gateway runtime');
    this.aiGatewayService = options.aiGatewayService;
  }

  /**
   * Set optional usage tracking dependencies (injected after construction).
   */
  public setUsageTracking(usageRepo: UsageRepository, quotaService: QuotaService): void {
    this.usageRepo = usageRepo;
    this.quotaService = quotaService;
  }

  public async complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse> {
    const accountId = getAccountId(auth);
    if (accountId) {
      await this.checkTokenQuota(accountId);
    }

    const result = await this.completeViaGateway('chatCompletions', request, auth) as unknown as ChatCompletionResponse;
    this.recordForwardedUsage(accountId, this.podUsageScope(auth), result);
    return result;
  }

  public async stream(request: ChatCompletionRequest, auth: AuthContext): Promise<{
    toTextStreamResponse: () => Response;
  }> {
    const gateway = this.requireAiGatewayService();
    return {
      toTextStreamResponse: () => gatewayExecutionToTextStreamResponse(gateway, {
        auth,
        protocol: 'chatCompletions',
        body: request,
      }),
    };
  }

  public async responses(body: unknown, auth: AuthContext): Promise<Record<string, unknown>> {
    const result = await this.completeViaGateway('responses', body, auth);
    this.recordForwardedUsage(getAccountId(auth), this.podUsageScope(auth), result);
    return result;
  }

  public async messages(body: unknown, auth: AuthContext): Promise<Record<string, unknown>> {
    const result = await this.completeViaGateway('anthropic', body, auth);
    this.recordForwardedUsage(getAccountId(auth), this.podUsageScope(auth), result);
    return result;
  }

  public async listModels(auth?: AuthContext): Promise<any[]> {
    if (!auth) {
      return [];
    }
    return await this.requireAiGatewayService().listModels(auth);
  }

  private async completeViaGateway(
    protocol: GatewayProtocol,
    body: unknown,
    auth: AuthContext,
  ): Promise<Record<string, unknown>> {
    return await this.requireAiGatewayService().complete({
      auth,
      protocol,
      body,
    });
  }

  private requireAiGatewayService(): Pick<AiGatewayService, 'complete' | 'execute' | 'listModels'> {
    if (!this.aiGatewayService) {
      throw new Error('AiGatewayService is required for legacy ChatKit AI inference');
    }
    return this.aiGatewayService;
  }

  private podUsageScope(auth: AuthContext): string {
    return getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
  }

  private extractTotalTokens(usage: unknown): number {
    if (!usage || typeof usage !== 'object') {
      return 0;
    }

    const record = usage as Record<string, unknown>;
    if (typeof record.total_tokens === 'number') {
      return record.total_tokens;
    }
    if (typeof record.totalTokens === 'number') {
      return record.totalTokens;
    }
    if (typeof record.input_tokens === 'number' || typeof record.output_tokens === 'number') {
      return (Number(record.input_tokens) || 0) + (Number(record.output_tokens) || 0);
    }
    if (typeof record.prompt_tokens === 'number' || typeof record.completion_tokens === 'number') {
      return (Number(record.prompt_tokens) || 0) + (Number(record.completion_tokens) || 0);
    }

    return 0;
  }

  private recordForwardedUsage(accountId: string | undefined, podId: string, payload: unknown): void {
    const usage = payload && typeof payload === 'object'
      ? (payload as { usage?: unknown }).usage
      : undefined;
    const totalTokens = this.extractTotalTokens(usage);
    if (accountId && totalTokens > 0) {
      this.recordTokenUsage(accountId, podId, totalTokens);
    }
  }

  /**
   * Check if account has remaining token quota.
   */
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

  /**
   * Record token usage (fire-and-forget).
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

function gatewayExecutionToTextStreamResponse(
  gateway: Pick<AiGatewayService, 'execute'>,
  input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
  },
): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let iterator: AsyncIterator<GatewayEvent> | undefined;
  let returned = false;

  const returnIterator = async (): Promise<void> => {
    if (returned) {
      return;
    }
    returned = true;
    await iterator?.return?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const execution = await gateway.execute({
          ...input,
          signal: abortController.signal,
        });
        const serializer = execution.frontend.createEventSerializer();
        iterator = execution.events[Symbol.asyncIterator]();
        while (true) {
          const result = await iterator.next();
          if (result.done) {
            break;
          }
          const event = result.value;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(serializer.serializeEvent(event))}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        if (abortController.signal.aborted) {
          try {
            controller.close();
          } catch {
            // Stream may already be closed by cancel().
          }
        } else {
          controller.error(error);
        }
      } finally {
        await returnIterator();
      }
    },
    async cancel() {
      abortController.abort();
      await returnIterator();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
