import type { HttpHandlerInput } from '@solid/community-server';

/**
 * Context passed through the middleware chain.
 * Middlewares can store data here for use in after() or by subsequent handlers.
 */
export interface MiddlewareContext {
  [key: string]: unknown;
}

/**
 * Interface for pass-through middleware handlers.
 * Unlike intercept-style handlers that stop the chain when they handle a request,
 * middleware handlers execute before() on the way in, let the chain continue,
 * then execute after() on the way out (onion model).
 * 
 * Handlers implementing this interface should also extend HttpHandler.
 */
export interface MiddlewareHttpHandler {
  /**
   * Called before the request is passed to the next handler in the chain.
   * Use this to set up context, modify request, etc.
   * @param input - The HTTP handler input
   * @param context - Shared context for passing data between before/after
   */
  before?(input: HttpHandlerInput, context: MiddlewareContext): Promise<void>;

  /**
   * Called after the request has been handled (or errored) by downstream handlers.
   * Use this for cleanup, logging, modifying response, etc.
   * @param input - The HTTP handler input
   * @param context - Shared context for passing data between before/after
   * @param error - If an error occurred downstream, it will be passed here
   */
  after?(input: HttpHandlerInput, context: MiddlewareContext, error?: Error): Promise<void>;
}

/**
 * Type guard to check if a handler implements MiddlewareHttpHandler interface.
 */
export function isMiddlewareHttpHandler(handler: unknown): handler is MiddlewareHttpHandler {
  return handler !== null && 
         typeof handler === 'object' && 
         ('before' in handler || 'after' in handler);
}
