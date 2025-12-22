import { HttpHandler, type HttpHandlerInput, getLoggerFor } from '@solid/community-server';
import { logContext } from '../logging/LogContext';
import type { MiddlewareHttpHandler, MiddlewareContext } from './MiddlewareHttpHandler';
import crypto from 'node:crypto';

// Context keys for RequestIdHttpHandler
const REQUEST_ID_KEY = 'requestId';
const START_TIME_KEY = 'startTime';
const LOG_CONTEXT_CLEANUP_KEY = 'logContextCleanup';

/**
 * Middleware that manages Request IDs for tracing.
 * 1. Checks for existing X-Request-ID in request headers.
 * 2. If missing, generates a new UUID.
 * 3. Sets the X-Request-ID in the response header.
 * 4. Stores the ID in AsyncLocalStorage for logging context.
 */
export class RequestIdHttpHandler extends HttpHandler implements MiddlewareHttpHandler {
  protected readonly logger = getLoggerFor(this);

  public constructor() {
    super();
  }

  public override async canHandle(_input: HttpHandlerInput): Promise<void> {
    // Middleware always can handle - it's pass-through
  }

  public override async handle(_input: HttpHandlerInput): Promise<void> {
    // Not used in middleware mode - before/after are used instead
    throw new Error('RequestIdHttpHandler should be used as middleware in ChainedHttpHandler');
  }

  public async before(input: HttpHandlerInput, context: MiddlewareContext): Promise<void> {
    const headerId = input.request.headers['x-request-id'];
    const requestId = Array.isArray(headerId) ? headerId[0] : headerId || crypto.randomUUID();
    
    input.response.setHeader('X-Request-ID', requestId);
    
    // Store in context for after()
    context[REQUEST_ID_KEY] = requestId;
    context[START_TIME_KEY] = Date.now();

    // Enter log context - we need to wrap the rest of execution in this context
    // Store a reference so we can use it in logging
    logContext.enterWith({ requestId });
  }

  public async after(input: HttpHandlerInput, context: MiddlewareContext, error?: Error): Promise<void> {
    const requestId = context[REQUEST_ID_KEY] as string;
    const startTime = context[START_TIME_KEY] as number;
    const ms = Date.now() - startTime;
    
    let status = input.response.statusCode || 200;
    if (error) {
      status = (error as any).statusCode ?? 500;
      this.logger.error(`${input.request.method} ${input.request.url} -> error ${status}: ${error.message}`);
    }
    
    if (status < 400) {
      this.logger.info(`${input.request.method} ${input.request.url} -> ${status} (${ms}ms)`);
    } else {
      this.logger.warn(`${input.request.method} ${input.request.url} -> ${status} (${ms}ms)`);
    }
  }
}
