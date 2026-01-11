/**
 * ChatKit Handler
 * 
 * HTTP handler for the ChatKit protocol endpoint.
 * Provides a single `/chatkit` POST endpoint that handles all ChatKit requests.
 * 
 * Based on https://github.com/openai/chatkit-python
 */

import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ChatKitService, StreamingResult, NonStreamingResult } from '../chatkit/service';
import type { StoreContext } from '../chatkit/store';
import { getWebId, getAccountId } from '../auth/AuthContext';

export interface ChatKitHandlerOptions {
  chatKitService: ChatKitService<StoreContext>;
}

/**
 * Register ChatKit routes on the API server
 */
export function registerChatKitRoutes(server: ApiServer, options: ChatKitHandlerOptions): void {
  const logger = getLoggerFor('ChatKitHandler');
  const { chatKitService } = options;

  /**
   * POST /chatkit - Main ChatKit endpoint
   * 
   * Handles all ChatKit protocol requests:
   * - Streaming requests (threads.create, threads.add_user_message, etc.)
   * - Non-streaming requests (threads.get_by_id, threads.list, etc.)
   */
  server.post('/chatkit', async (request, response, _params) => {
    const auth = request.auth;
    
    // Get userId from auth context (may be undefined for unauthenticated requests)
    let userId = 'anonymous';
    if (auth) {
      userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    }

    // Build context for store operations
    const context: StoreContext = {
      userId,
      auth,
    };

    try {
      // Read request body
      const body = await readRequestBody(request);
      
      if (!body) {
        sendJsonError(response, 400, 'invalid_request', 'Request body is required');
        return;
      }

      logger.debug(`ChatKit request from ${userId}: ${body.slice(0, 200)}...`);

      // Process the request
      const result = await chatKitService.process(body, context);

      if (result.type === 'streaming') {
        // Stream SSE response
        await streamResponse(response, result);
      } else {
        // Send JSON response
        sendJsonResponse(response, result);
      }
    } catch (error: any) {
      logger.error(`ChatKit request failed: ${error}`);
      
      if (!response.headersSent) {
        sendJsonError(response, 500, 'internal_error', error.message || 'Internal server error');
      }
    }
  });

  /**
   * GET /chatkit/health - Health check endpoint
   */
  server.get('/chatkit/health', async (_request, response, _params) => {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', service: 'chatkit' }));
  }, { public: true });

  logger.info('ChatKit routes registered: POST /chatkit, GET /chatkit/health');
}

/**
 * Read the entire request body as a string
 */
async function readRequestBody(request: AuthenticatedRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      resolve(body);
    });
    
    request.on('error', reject);
  });
}

/**
 * Stream SSE response
 */
async function streamResponse(response: ServerResponse, result: StreamingResult): Promise<void> {
  // Set SSE headers
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  
  // Flush headers immediately
  response.flushHeaders?.();

  try {
    for await (const chunk of result.stream()) {
      if (response.writableEnded) {
        break;
      }
      response.write(chunk);
    }
  } catch (error: any) {
    // Try to send error event if response is still writable
    if (!response.writableEnded) {
      const errorEvent = {
        type: 'error',
        error: {
          code: 'stream_error',
          message: error.message || 'Stream error occurred',
        },
      };
      response.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    }
  } finally {
    if (!response.writableEnded) {
      response.end();
    }
  }
}

/**
 * Send JSON response
 */
function sendJsonResponse(response: ServerResponse, result: NonStreamingResult): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.end(result.json);
}

/**
 * Send JSON error response
 */
function sendJsonError(response: ServerResponse, status: number, code: string, message: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({
    error: {
      code,
      message,
    },
  }));
}
