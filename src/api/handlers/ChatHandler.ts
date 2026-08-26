import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthContext } from '../auth/AuthContext';
import { getAccountId, getDisplayName, getWebId } from '../auth/AuthContext';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';

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
  chatService?: {
    complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse>;
    stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any>;
    responses?(body: any, auth: AuthContext): Promise<any>;
    messages?(body: any, auth: AuthContext): Promise<any>;
    listModels(auth?: AuthContext): Promise<any[]>;
  };
}

export function registerChatRoutes(server: ApiServer, options: ChatHandlerOptions): void {
  const logger = getLoggerFor('ChatHandler');
  const chatService = options.chatService;

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

    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    try {
      const completionRequest: ChatCompletionRequest = {
        ...payload,
        model: payload.model as string,
        messages: payload.messages as ChatCompletionRequest['messages'],
        temperature: typeof payload.temperature === 'number' ? payload.temperature : undefined,
        max_tokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined,
        stream: payload.stream === true,
      };

      if (completionRequest.stream) {
        const streamResult = await chatService.stream(completionRequest, auth);
        const webResponse = streamResult.toTextStreamResponse();

        webResponse.headers.forEach((value: string, key: string) => {
          response.setHeader(key, value);
        });
        response.statusCode = webResponse.status;

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
            } catch (error) {
              logger.error(`Stream write error: ${error}`);
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
      sendJson(response, 200, await chatService.complete(completionRequest, auth));
    } catch (error: any) {
      if (sendModelNotConfigured(response, error)) {
        return;
      }
      logger.error(`Chat completion error: ${error}`);
      sendJson(response, 500, {
        error: {
          message: error.message || 'Internal server error',
          type: 'internal_error',
          code: 'internal_error',
        },
      });
    }
  });

  server.post('/v1/responses', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!chatService?.responses) {
      sendJson(response, 501, { error: 'Responses API not implemented or configured' });
      return;
    }

    try {
      sendJson(response, 200, await chatService.responses(body, auth));
    } catch (error: any) {
      if (sendModelNotConfigured(response, error)) {
        return;
      }
      logger.error(`Responses API error: ${error}`);
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  server.post('/v1/messages', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!chatService?.messages) {
      sendJson(response, 501, { error: 'Messages API not implemented or configured' });
      return;
    }

    try {
      sendJson(response, 200, await chatService.messages(body, auth));
    } catch (error: any) {
      if (sendModelNotConfigured(response, error)) {
        return;
      }
      logger.error(`Messages API error: ${error}`);
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  server.get('/v1/models', async (request, response, _params) => {
    if (!chatService) {
      sendJson(response, 503, { error: 'Chat service not configured' });
      return;
    }

    try {
      sendJson(response, 200, {
        object: 'list',
        data: await chatService.listModels(request.auth),
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

function sendModelNotConfigured(response: ServerResponse, error: any): boolean {
  if (error?.code !== 'model_not_configured') {
    return false;
  }
  sendJson(response, 400, {
    error: {
      message: error.message || 'Model is not configured',
      type: 'invalid_request_error',
      code: 'model_not_configured',
    },
  });
  return true;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
