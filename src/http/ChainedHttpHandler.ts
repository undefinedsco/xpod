import { HttpHandler, type HttpHandlerInput, getLoggerFor } from '@solid/community-server';
import { isMiddlewareHttpHandler, type MiddlewareHttpHandler, type MiddlewareContext } from './MiddlewareHttpHandler';

/**
 * A handler that chains multiple handlers together using the onion model.
 * 
 * Supports two types of handlers:
 * 1. Middleware handlers (pass-through): Execute before() on the way in, 
 *    let the chain continue, then execute after() on the way out.
 * 2. Intercept handlers: Try to handle the request. If canHandle() succeeds,
 *    handle the request and stop the chain.
 * 
 * Example chain: [RequestIdMiddleware, AuthMiddleware, SignalHandler, HttpHandler]
 * 
 * Execution flow:
 * 1. RequestIdMiddleware.before()
 * 2. AuthMiddleware.before()
 * 3. SignalHandler.canHandle() -> fails, skip
 * 4. HttpHandler.canHandle() -> succeeds, HttpHandler.handle()
 * 5. AuthMiddleware.after()
 * 6. RequestIdMiddleware.after()
 */
export class ChainedHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly handlers: HttpHandler[];

  public constructor(handlers: HttpHandler[]) {
    super();
    this.handlers = handlers;
  }

  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    // Check if at least one non-middleware handler can handle the request
    for (const handler of this.handlers) {
      if (!isMiddlewareHttpHandler(handler)) {
        try {
          await handler.canHandle(input);
          return; // Found a handler that can handle
        } catch {
          // This handler can't handle, try next
        }
      }
    }
    throw new Error('No handler in chain can handle this request');
  }

  public override async handle(input: HttpHandlerInput): Promise<void> {
    const middlewareStack: { handler: MiddlewareHttpHandler; context: MiddlewareContext }[] = [];
    const sharedContext: MiddlewareContext = {};
    let error: Error | undefined;

    try {
      for (const handler of this.handlers) {
        if (isMiddlewareHttpHandler(handler)) {
          // Middleware: execute before() and push to stack for later after()
          if (handler.before) {
            await handler.before(input, sharedContext);
          }
          middlewareStack.push({ handler, context: sharedContext });
        } else {
          // Intercept handler: try to handle
          try {
            await handler.canHandle(input);
            await handler.handle(input);
            break; // Successfully handled, stop the chain
          } catch (e) {
            // Can't handle, try next handler
            this.logger.debug(`Handler ${handler.constructor.name} cannot handle, trying next`);
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    // Execute after() in reverse order (onion model)
    for (const { handler, context } of middlewareStack.reverse()) {
      if (handler.after) {
        try {
          await handler.after(input, context, error);
        } catch (afterError) {
          this.logger.error(`Error in middleware after(): ${afterError}`);
          // If no previous error, this becomes the error
          if (!error) {
            error = afterError instanceof Error ? afterError : new Error(String(afterError));
          }
        }
      }
    }

    // Re-throw if there was an error
    if (error) {
      throw error;
    }
  }
}
