import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput } from '@solid/community-server';

interface SignalInterceptHttpHandlerOptions {
  signalHandler: HttpHandler;
  fallback: HttpHandler;
  basePath?: string;
}

/**
 * Wraps the default CSS HttpHandler so we can short-circuit `/api/signal`
 * requests to our token-based handler. All other paths continue through
 * the normal pipeline (including authorization) untouched.
 */
export class SignalInterceptHttpHandler extends HttpHandler {
  private readonly signalHandler: HttpHandler;
  private readonly fallback: HttpHandler;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;

  public constructor(options: SignalInterceptHttpHandlerOptions) {
    super();
    this.signalHandler = options.signalHandler;
    this.fallback = options.fallback;
    const basePath = options.basePath ?? '/api/signal';
    this.basePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    this.basePathWithSlash = `${this.basePath}/`;
  }

  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    if (this.matches(input)) {
      await this.signalHandler.canHandle(input);
      return;
    }
    await this.fallback.canHandle(input);
  }

  public override async handle(input: HttpHandlerInput): Promise<void> {
    if (this.matches(input)) {
      await this.signalHandler.handle(input);
      return;
    }
    await this.fallback.handle(input);
  }

  private matches({ request }: HttpHandlerInput): boolean {
    const pathname = this.parsePathname(request);
    return pathname === this.basePath || pathname.startsWith(this.basePathWithSlash);
  }

  private parsePathname(request: HttpHandlerInput['request']): string {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`).pathname;
  }
}
