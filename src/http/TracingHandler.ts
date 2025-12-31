import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler, type HttpHandlerInput } from '@solid/community-server';
import { logContext } from '../logging/LogContext';
import { lockContext } from '../util/LockContext';
import crypto from 'node:crypto';

/**
 * HTTP Handler that provides request tracing capabilities.
 * 
 * This handler:
 * 1. Reads or generates a Request ID (from X-Request-ID header or new UUID)
 * 2. Sets the X-Request-ID in the response header
 * 3. Enters the logging context with the request ID
 * 4. Logs request completion with status code and duration via response 'finish' event
 * 
 * Designed to be used as the first handler in a SequenceHandler chain.
 * It sets up the tracing context and returns immediately, allowing
 * the SequenceHandler to continue to subsequent handlers.
 */
export class TracingHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);

  public override async canHandle(_input: HttpHandlerInput): Promise<void> {
    // Always can handle - we just set up tracing context and pass through
  }

  public override async handle(input: HttpHandlerInput): Promise<void> {
    const headerId = input.request.headers['x-request-id'];
    const requestId = Array.isArray(headerId) ? headerId[0] : headerId || crypto.randomUUID();
    const startTime = Date.now();
    
    // Set response header
    input.response.setHeader('X-Request-ID', requestId);
    
    // Enter logging context for this request
    logContext.enterWith({ requestId });
    lockContext.enterWith(new Map());

    // Register finish listener to log completion
    input.response.on('finish', () => {
      const ms = Date.now() - startTime;
      const status = input.response.statusCode || 200;
      
      // Re-enter log context for the finish callback
      logContext.run({ requestId }, () => {
        if (status < 400) {
          this.logger.info(`${input.request.method} ${input.request.url} -> ${status} (${ms}ms)`);
        } else {
          this.logger.warn(`${input.request.method} ${input.request.url} -> ${status} (${ms}ms)`);
        }
      });
    });

    // Return immediately - SequenceHandler will continue to next handler
  }
}
