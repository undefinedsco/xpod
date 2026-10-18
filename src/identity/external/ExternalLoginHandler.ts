import { BadRequestHttpError, ForbiddenHttpError, JsonInteractionHandler, MethodNotAllowedHttpError, NotFoundHttpError,
  RelativePathInteractionRoute, ResolveLoginHandler, RepresentationMetadata, type AccountStore, type CookieStore, type InteractionRoute,
  type JsonInteractionHandlerInput, type JsonRepresentation } from '@solid/community-server';
import { ExternalLoginService } from './ExternalLoginService';
import { protectExternalLoginMetadata } from './ExternalLoginMetadata';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestHttpError('INVALID_EXTERNAL_LOGIN');
  return value as Record<string, unknown>;
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

export class ExternalLoginHandler extends ResolveLoginHandler {
  private readonly callbackRoute: RelativePathInteractionRoute<string>;

  public constructor(
    private readonly service: ExternalLoginService,
    private readonly route: InteractionRoute<string>,
    accountStore: AccountStore,
    cookieStore: CookieStore,
  ) {
    super(accountStore, cookieStore);
    this.callbackRoute = new RelativePathInteractionRoute(route, 'callback/');
  }

  private match(input: JsonInteractionHandlerInput) {
    const callback = this.callbackRoute.matchPath(input.target.path);
    const parameters = callback ?? this.route.matchPath(input.target.path);
    if (!parameters || !this.service.providers.has(parameters.providerId)) throw new NotFoundHttpError();
    return { provider: parameters.providerId, callback: Boolean(callback) };
  }

  public override async canHandle(input: JsonInteractionHandlerInput): Promise<void> {
    this.match(input);
    if (!['GET', 'POST', 'DELETE'].includes(input.method)) throw new MethodNotAllowedHttpError(['GET', 'POST', 'DELETE']);
  }

  public override async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    const result = await this.handleRequest(input);
    return { ...result, metadata: protectExternalLoginMetadata(result.metadata ?? new RepresentationMetadata(input.target)) };
  }

  private async handleRequest(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    const { provider, callback } = this.match(input);
    if (input.method === 'GET') return { json: { name: this.service.provider(provider).name } };
    if (callback) {
      if (input.method !== 'POST') throw new MethodNotAllowedHttpError(['GET', 'POST']);
      return super.handle(input);
    }
    if (input.method === 'DELETE') {
      if (!input.accountId) throw new ForbiddenHttpError('ACCOUNT_LOGIN_REQUIRED');
      await this.service.unlink(provider, input.accountId);
      return { json: { success: true } };
    }
    const body = object(input.json);
    const intent = body.intent ?? 'login';
    if (!['login', 'register', 'link'].includes(String(intent))) throw new BadRequestHttpError('INVALID_LOGIN_INTENT');
    if (body.remember !== undefined && typeof body.remember !== 'boolean') throw new BadRequestHttpError('INVALID_REMEMBER');
    if (input.accountId && intent !== 'link') throw new BadRequestHttpError('LOG_OUT_BEFORE_EXTERNAL_LOGIN');
    const returnTo = body.returnTo === undefined ? this.service.accountRoot.href : new URL(text(body.returnTo), this.service.accountRoot).href;
    const target = new URL(returnTo);
    if (target.origin !== this.service.accountRoot.origin || target.username || target.password || target.hash) throw new BadRequestHttpError('INVALID_RETURN_TO');
    const callbackPath = this.callbackRoute.getPath({ providerId: provider });
    const result = await this.service.begin(provider, text(body.proof), {
      intent: intent as 'login' | 'register' | 'link',
      accountId: intent === 'link' ? input.accountId : undefined,
      interaction: input.oidcInteraction?.uid,
      callback: callbackPath,
      returnTo,
      remember: body.remember === true,
    });
    // The public WeChat redirect URI stays stable. The browser completes on its
    // original interaction route, where CSS validates the signed interaction cookie.
    if (input.oidcInteraction) {
      result.callback = callbackPath.replace(this.service.accountRoot.href, `${this.service.accountRoot.href}interaction/${input.oidcInteraction.uid}/`);
    }
    return { json: result };
  }

  public async login(input: JsonInteractionHandlerInput) {
    const { provider } = this.match(input);
    const body = object(input.json);
    return { json: await this.service.finish(provider, {
      state: text(body.state), proof: text(body.proof), code: text(body.code),
      callback: input.target.path, accountId: input.accountId, interaction: input.oidcInteraction?.uid,
    }) };
  }
}

/** Capability discovery shares the same provider registry and CSS route objects. */
export class ExternalLoginControls extends JsonInteractionHandler {
  public constructor(private readonly service: ExternalLoginService, private readonly route: InteractionRoute<string>) { super(); }
  public async handle(input: JsonInteractionHandlerInput): Promise<JsonRepresentation> {
    const json: Record<string, { name: string; login: string; linked: boolean }> = {};
    for (const provider of this.service.providers.values()) json[provider.id] = {
      name: provider.name, login: this.route.getPath({ providerId: provider.id }), linked: await this.service.isLinked(provider.id, input.accountId),
    };
    return { json };
  }
}
