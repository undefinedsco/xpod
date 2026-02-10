import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';

/**
 * Chat completion request (OpenAI-compatible)
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
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
      content: string;
    };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatHandlerOptions {
  /**
   * Backend chat service to delegate to (e.g., OpenAI, local model)
   */
  chatService?: {
    complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse>;
    stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any>;
    responses?(body: any, auth: AuthContext): Promise<any>;
    messages?(body: any, auth: AuthContext): Promise<any>;
    listModels(auth?: AuthContext): Promise<any[]>;
  };
  /**
   * Pod base URL for storage
   */
  podBaseUrl?: string;
}

/**
 * Handler for chat completions API (OpenAI-compatible)
 * 
 * POST /v1/chat/completions - Create a chat completion
 * POST /v1/responses - Create a response (OpenAI Responses API)
 * POST /v1/messages - Create a message (Anthropic/OpenAI Threads compatible)
 * GET  /v1/models - List available models
 * 
 * Supports both Solid Token (frontend) and API Key (third-party)
 */
export function registerChatRoutes(server: ApiServer, options: ChatHandlerOptions): void {
  const logger = getLoggerFor('ChatHandler');
  const chatService = options.chatService;

  // POST /api/chat/completions
  server.post('/v1/chat/completions', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, {
        error: {
          message: 'Request body must be a JSON object',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      });
      return;
    }

    const payload = body as Record<string, unknown>;

    // Validate required fields
    if (!payload.model || typeof payload.model !== 'string') {
      sendJson(response, 400, {
        error: {
          message: 'model is required',
          type: 'invalid_request_error',
          code: 'missing_model',
        },
      });
      return;
    }

    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      sendJson(response, 400, {
        error: {
          message: 'messages array is required and must not be empty',
          type: 'invalid_request_error',
          code: 'missing_messages',
        },
      });
      return;
    }

    // Get user identifier for rate limiting / logging
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);


    // Check if service is available
    if (!chatService) {
      sendJson(response, 503, {
        error: {
          message: 'Chat service is not configured',
          type: 'service_unavailable',
          code: 'service_not_configured',
        },
      });
      return;
    }

    try {
      const messages = payload.messages as ChatCompletionRequest['messages'];
      const completionRequest: ChatCompletionRequest = {
        model: payload.model as string,
        messages,
        temperature: typeof payload.temperature === 'number' ? payload.temperature : undefined,
        max_tokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined,
        stream: payload.stream === true,
      };

      // Handle streaming
      if (completionRequest.stream) {
        const streamResult = await chatService.stream(completionRequest, auth);
        // Vercel AI SDK v6 uses toTextStreamResponse (not toDataStreamResponse)
        const webResponse = streamResult.toTextStreamResponse();

        // Copy headers (Content-Type: text/plain; charset=utf-8, X-Vercel-AI-Data-Stream: v1)
        webResponse.headers.forEach((value: string, key: string) => {
          response.setHeader(key, value);
        });
        response.statusCode = webResponse.status;

        // Pipe Web Stream to Node Response
        if (webResponse.body) {
          const reader = webResponse.body.getReader();
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                response.write(value);
              }
            } catch (e) {
              logger.error(`Stream write error: ${e}`);
            } finally {
              response.end();
            }
          };
          pump();
        } else {
          response.end();
        }
        return;
      }

      logger.info(`Chat completion request from ${displayName} (acc: ${accountId}), model: ${completionRequest.model}`);

      const result = await chatService.complete(completionRequest, auth);
      sendJson(response, 200, result);
    } catch (error: any) {
      if (error?.code === 'model_not_configured') {
        sendJson(response, 400, {
          error: {
            message: error.message || 'Model is not configured',
            type: 'invalid_request_error',
            code: 'model_not_configured',
          },
        });
        return;
      }
      logger.error(`Chat completion error: ${error}`);
      sendJson(response, 500, {
        error: {
          message: error.message || 'Internal server error',
          stack: error.stack,
          type: 'internal_error',
          code: 'internal_error',
        },
      });
    }
  });

  // POST /v1/responses - Create a response
  server.post('/v1/responses', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    if (!chatService || !chatService.responses) {
      sendJson(response, 501, { error: 'Responses API not implemented or configured' });
      return;
    }

    try {
      logger.info(`Responses API request from ${displayName} (acc: ${accountId})`);
      const result = await chatService.responses(body, auth);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Responses API error: ${error}`);
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  // POST /v1/messages - Create a message
  server.post('/v1/messages', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    if (!chatService || !chatService.messages) {
      sendJson(response, 501, { error: 'Messages API not implemented or configured' });
      return;
    }

    try {
      logger.info(`Messages API request from ${displayName} (acc: ${accountId})`);
      const result = await chatService.messages(body, auth);
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Messages API error: ${error}`);
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  // GET /v1/models - List available models (OpenAI-compatible)
  server.get('/v1/models', async (request, response, _params) => {
    if (!chatService) {
      sendJson(response, 503, { error: 'Chat service not configured' });
      return;
    }

    try {
      const auth = request.auth;
      const models = await chatService.listModels(auth);
      sendJson(response, 200, {
        object: 'list',
        data: models,
      });
    } catch (error) {
      logger.error(`Failed to list models: ${error}`);
      sendJson(response, 500, { error: 'Failed to list models' });
    }
  });
}

async function readJsonBody(request: AuthenticatedRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', reject);
  });
}


function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
