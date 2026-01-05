import { HttpHandler, type HttpHandlerInput } from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import { logContext } from '../logging/LogContext';
import crypto from 'node:crypto';

/**
 * Middleware that manages Request IDs for tracing.
 * 1. Checks for existing X-Request-ID in request headers.
 * 2. If missing, generates a new UUID.
 * 3. Sets the X-Request-ID in the response header.
 * 4. Stores the ID in AsyncLocalStorage for logging context.
 */
export class RequestIdHttpHandler extends HttpHandler {
  private readonly source: HttpHandler;

  public constructor(source: HttpHandler) {
    super();
    this.source = source;
  }

  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    await this.source.canHandle(input);
  }

  public override async handle(input: HttpHandlerInput): Promise<void> {
    const headerId = input.request.headers['x-request-id'];
    const requestId = Array.isArray(headerId) ? headerId[0] : headerId || crypto.randomUUID();
    
    input.response.setHeader('X-Request-ID', requestId);
    const logger = this.loggerForRequest(input);

    await logContext.run({ requestId }, async () => {
      const started = Date.now();
      let status = 500;
      try {
        await this.source.handle(input);
        status = input.response.statusCode || 200;
      } catch (error) {
        status = error instanceof Error ? (error as any).statusCode ?? status : status;
        logger.error(`${input.request.method} ${input.request.url} -> error ${status}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        const ms = Date.now() - started;
        if (status < 400) {
          logger.info(`${input.request.method} ${input.request.url} -> ${status} (${ms}ms)`);
        } else {
          logger.warn(`${input.request.method} ${input.request.url} -> ${status} (${ms}ms)`);
        }
      }
    });
  }

  private loggerForRequest(input: HttpHandlerInput) {
    return getLoggerFor(this);
  }
}
