import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput } from '@solid/community-server';
import { RouterHttpRoute } from './RouterHttpRoute';

interface RouterHttpHandlerOptions {
  routes: RouterHttpRoute[];
  fallback: HttpHandler;
}

/**
 * Routes requests by path prefix and forwards to the first matching handler.
 * This stays in single-baseUrl mode and does not inspect the Host header.
 */
export class RouterHttpHandler extends HttpHandler {
  private readonly routes: { basePath: string; basePathWithSlash: string; handler: HttpHandler }[];
  private readonly fallback: HttpHandler;

  public constructor(options: RouterHttpHandlerOptions) {
    super();
    this.routes = options.routes.map((route): { basePath: string; basePathWithSlash: string; handler: HttpHandler } => {
      const basePath = route.basePath.endsWith('/') ? route.basePath.slice(0, -1) : route.basePath;
      return {
        basePath,
        basePathWithSlash: `${basePath}/`,
        handler: route.handler,
      };
    });
    this.fallback = options.fallback;
  }

  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    const handler = this.resolveHandler(input);
    await handler.canHandle(input);
  }

  public override async handle(input: HttpHandlerInput): Promise<void> {
    const handler = this.resolveHandler(input);
    await handler.handle(input);
  }

  private resolveHandler(input: HttpHandlerInput): HttpHandler {
    const pathname = this.parsePathname(input);
    for (const route of this.routes) {
      if (pathname === route.basePath || pathname.startsWith(route.basePathWithSlash)) {
        return route.handler;
      }
    }
    return this.fallback;
  }

  private parsePathname({ request }: HttpHandlerInput): string {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`).pathname;
  }
}
