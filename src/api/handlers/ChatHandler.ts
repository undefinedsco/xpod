import type { ApiServer } from '../ApiServer';
import type { AuthContext } from '../auth/AuthContext';
import type { AiGatewayService } from '../ai-gateway/AiGatewayService';
import { registerAiGatewayRoutes } from './AiGatewayHandler';

/**
 * Chat completion request (OpenAI-compatible)
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<Record<string, unknown> & {
    role: string;
    content?: unknown;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/**
 * Chat completion response (OpenAI-compatible)
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: unknown[];
    };
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatHandlerOptions {
  aiGatewayService?: AiGatewayService;
  aiGatewayJsonBodyLimitBytes?: number;
  acceptanceEndpointsEnabled?: boolean;
  /**
   * Legacy service type retained only so Task11 can migrate existing internal
   * callers without forcing unrelated imports to change in this task.
   */
  chatService?: {
    complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse>;
    stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any>;
    responses?(body: any, auth: AuthContext): Promise<any>;
    messages?(body: any, auth: AuthContext): Promise<any>;
    listModels(auth?: AuthContext): Promise<any[]>;
  };
  podBaseUrl?: string;
}

/**
 * Register public AI-compatible routes.
 *
 * The four `/v1/*` client-facing routes are owned by AiGatewayHandler. Legacy
 * provider branching remains in VercelChatService until Task11, but it is no
 * longer installed as a public route implementation here.
 */
export function registerChatRoutes(server: ApiServer, options: ChatHandlerOptions): void {
  if (!options.aiGatewayService) {
    throw new Error('AiGatewayService is required to register public v1 AI routes');
  }
  registerAiGatewayRoutes(server, {
    service: options.aiGatewayService,
    jsonBodyLimitBytes: options.aiGatewayJsonBodyLimitBytes,
    acceptanceEndpointsEnabled: options.acceptanceEndpointsEnabled,
  });
}
