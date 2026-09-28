import { getLoggerFor } from 'global-logger-factory';
import {
  OkResponseDescription,
  BadRequestHttpError,
  OperationHttpHandler,
  RepresentationMetadata,
  SOLID_HTTP,
  WEBID_STORAGE_TYPE,
  createErrorMessage,
  type InteractionHandler,
  type OperationHttpHandlerInput,
  type ProviderFactory,
  type ResponseDescription,
} from '@solid/community-server';
import type { CookieStore, Credentials, CredentialsExtractor } from '@solid/community-server';
import { XPOD_DESKTOP_CLIENT_ID } from './oidc/RememberedClientGrantStore';

const ACCOUNT_TYPE = 'account';
const ACCOUNT_COOKIE_NAME = 'css-account';
const ACCOUNT_TOKEN_AUTHORIZATION_SCHEME = 'CSS-Account-Token ';

interface AccountExistenceStorage {
  has: (type: string, id: string) => Promise<boolean>;
  find: (type: string, query: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
}

export interface ValidatingIdentityProviderHttpHandlerArgs {
  /**
   * Used to generate the OIDC provider.
   */
  providerFactory: ProviderFactory;
  /**
   * Used to determine the account of the requesting agent.
   */
  cookieStore: CookieStore;
  /**
   * Handles the requests.
   */
  handler: InteractionHandler;
  /**
   * Storage backing CSS account state.
   */
  accountStorage: AccountExistenceStorage;
  /**
   * External account authority (Cloud+Local mode). When set, account cookies
   * are issued and validated by the remote authority, so cookies unknown to
   * the local cookie store must be left untouched instead of expired.
   */
  externalAccountIssuer?: string;
  /**
   * Reads the caller's own already-verified credentials.
   *
   * The Account cookie is issued on the account authority's own origin, so a page the Xpod
   * Gateway serves cannot present it. What that page does hold is the WebID session Xpod signed
   * it in with, which names the same Account whenever the WebID is one the Account already linked.
   *
   * This is CSS's own request-scoped extractor, so that session's DPoP proof is verified once for
   * the whole request. Verifying the same proof again would be a replay and always fail, which is
   * exactly what the `jti` guard is for - including when this handler asks.
   */
  sessionExtractor?: CredentialsExtractor;
  /**
   * OIDC clients whose Solid session may name its own Account. Defaults to the
   * client the Xpod host itself logs in with, so a third-party Solid app holding a
   * token for the same WebID can never turn it into Account authority.
   */
  hostClientIds?: string[];
}

/**
 * CSS-compatible IdP operation handler that drops stale account cookies.
 *
 * CSS trusts the account id stored in the cookie. In a clustered deployment where
 * account storage can be reset independently from browser cookies, that can leave
 * users stuck in a phantom logged-in state during registration or login.
 */
export class ValidatingIdentityProviderHttpHandler extends OperationHttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly providerFactory: ProviderFactory;
  private readonly cookieStore: CookieStore;
  private readonly handler: InteractionHandler;
  private readonly accountStorage: AccountExistenceStorage;
  private readonly externalAccountIssuer?: string;
  private readonly sessionExtractor?: CredentialsExtractor;
  private readonly hostClientIds: readonly string[];

  public constructor(args: ValidatingIdentityProviderHttpHandlerArgs) {
    super();
    this.providerFactory = args.providerFactory;
    this.cookieStore = args.cookieStore;
    this.handler = args.handler;
    this.accountStorage = args.accountStorage;
    this.externalAccountIssuer = args.externalAccountIssuer;
    this.sessionExtractor = args.sessionExtractor;
    this.hostClientIds = args.hostClientIds ?? [XPOD_DESKTOP_CLIENT_ID];
  }

  public override async handle({ operation, request, response }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    // The browser sends the native, path-scoped signed cookie for this URL.
    // Never look up an interaction by the untrusted path identifier alone.
    const scoped = /^(.*\/\.account\/)interaction\/([A-Za-z0-9_-]+)\/(.*)$/u.exec(operation.target.path);
    if (!scoped && operation.target.path.includes('/.account/interaction/')) {
      throw new BadRequestHttpError('Invalid OIDC interaction');
    }
    let oidcInteraction;
    try {
      const provider = await this.providerFactory.getProvider();
      oidcInteraction = await provider.interactionDetails(request, response);
      this.logger.debug('Found an active OIDC interaction.');
    } catch (error: unknown) {
      if (scoped) {
        throw new BadRequestHttpError('Invalid OIDC interaction');
      }
      this.logger.debug(`No active OIDC interaction found: ${createErrorMessage(error)}`);
    }

    if (scoped) {
      if (oidcInteraction?.uid !== scoped[2]) {
        throw new BadRequestHttpError('Invalid OIDC interaction');
      }
      // Reuse CSS Account routing after the provider has checked the cookie,
      // interaction lifetime and session principal. Keep the raw request URL.
      operation = { ...operation, target: { ...operation.target, path: `${scoped[1]}${scoped[3]}` } };
    }

    const browserCookie = this.findBrowserAccountCookie(request);
    const authorizationCookie = this.findAuthorizationAccountCookie(request);
    const cookies = this.findAccountCookies(operation, authorizationCookie, browserCookie);
    const { accountId, selectedCookie, expiredCookie } = await this.findValidAccount(cookies, browserCookie);
    // An Account cookie stays authoritative; the host's own Solid session is the
    // second source, for pages that hold a WebID but never saw the account origin.
    const sessionAccountId = accountId ?? await this.findSessionAccount(request);
    const normalizedOperation = this.normalizeAccountCookie(operation, selectedCookie);
    const representation = await this.handler.handleSafe({
      operation: normalizedOperation,
      oidcInteraction,
      accountId: sessionAccountId,
    });

    if (expiredCookie && !representation.metadata?.has(SOLID_HTTP.terms.accountCookie)) {
      const metadata = new RepresentationMetadata(representation.metadata);
      metadata.set(SOLID_HTTP.terms.accountCookie, expiredCookie);
      metadata.set(SOLID_HTTP.terms.accountCookieExpiration, new Date(0).toISOString());
      representation.metadata = metadata;
    }

    return new OkResponseDescription(representation.metadata, representation.data);
  }

  private findAccountCookies(
    operation: OperationHttpHandlerInput['operation'],
    authorizationCookie: string | undefined,
    browserCookie: string | undefined,
  ): string[] {
    const metadataCookies = operation.body.metadata
      .getAll(SOLID_HTTP.terms.accountCookie)
      .map((term) => term.value)
      .filter((value): value is string => Boolean(value));

    return Array.from(new Set(
      [
        authorizationCookie,
        ...metadataCookies,
        browserCookie,
      ].filter((value): value is string => Boolean(value)),
    ));
  }

  private findAuthorizationAccountCookie(request: OperationHttpHandlerInput['request']): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization?.toLowerCase().startsWith(ACCOUNT_TOKEN_AUTHORIZATION_SCHEME.toLowerCase())) {
      return;
    }

    const value = authorization.slice(ACCOUNT_TOKEN_AUTHORIZATION_SCHEME.length).trim();
    return value || undefined;
  }

  private findBrowserAccountCookie(request: OperationHttpHandlerInput['request']): string | undefined {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) {
      return;
    }

    for (const cookie of cookieHeader.split(';')) {
      const separator = cookie.indexOf('=');
      if (separator === -1) {
        continue;
      }

      const name = cookie.slice(0, separator).trim();
      if (name !== ACCOUNT_COOKIE_NAME) {
        continue;
      }

      const value = cookie.slice(separator + 1).trim();
      return value || undefined;
    }
  }

  private normalizeAccountCookie(
    operation: OperationHttpHandlerInput['operation'],
    selectedCookie: string | undefined,
  ): OperationHttpHandlerInput['operation'] {
    const metadata = new RepresentationMetadata(operation.body.metadata);
    metadata.removeAll(SOLID_HTTP.terms.accountCookie);
    if (selectedCookie) {
      metadata.add(SOLID_HTTP.terms.accountCookie, selectedCookie);
    }

    const body = Object.assign(
      Object.create(Object.getPrototypeOf(operation.body)),
      operation.body,
      { metadata },
    );

    return {
      ...operation,
      body,
    };
  }

  private async findValidAccount(cookies: string[], browserCookie: string | undefined): Promise<{
    accountId?: string;
    selectedCookie?: string;
    expiredCookie?: string;
  }> {
    if (cookies.length === 0) {
      return {};
    }

    let expiredCookie: string | undefined;
    let selectedCookie: string | undefined;
    let selectedAccountId: string | undefined;
    for (const cookie of cookies) {
      const accountId = await this.cookieStore.get(cookie);
      if (!accountId) {
        // In Cloud+Local mode the cookie is owned by the external account
        // authority; the local cookie store cannot vouch for it, but must not
        // expire it either.
        if (!this.externalAccountIssuer && cookie === browserCookie) {
          expiredCookie ??= cookie;
        }
        continue;
      }

      const accountExists = await this.accountStorage.has(ACCOUNT_TYPE, accountId);
      if (accountExists) {
        selectedCookie ??= cookie;
        selectedAccountId ??= accountId;
        continue;
      }

      await this.cookieStore.delete(cookie);
      if (cookie === browserCookie) {
        expiredCookie ??= cookie;
      }
      this.logger.warn(`Deleted stale account cookie for missing account ${accountId}.`);
    }

    return { accountId: selectedAccountId, selectedCookie, expiredCookie };
  }

  /**
   * Names the Account that owns the WebID of the caller's own Solid session.
   *
   * The session is only accepted when its DPoP proof verifies and its client is one
   * the Xpod host itself logs in with, so holding somebody's token is not enough and
   * a third-party app cannot spend its own token here. The Account is then read from
   * CSS's own WebID links: a session can only ever reach the Account it already
   * belongs to, never another one.
   */
  private async findSessionAccount(request: OperationHttpHandlerInput['request']): Promise<string | undefined> {
    if (!this.sessionExtractor) {
      return undefined;
    }

    // Only a DPoP-bound session may name an Account. A Bearer token is replayable, so accepting
    // one here would let anybody who copied it mint Account authority from a Pod credential.
    if (!/^DPoP /iu.test(request.headers.authorization ?? '')) {
      return undefined;
    }

    let credentials: Credentials;
    try {
      credentials = await this.sessionExtractor.handleSafe(request);
    } catch (error: unknown) {
      // No session at all, or one this deployment does not accept: stay anonymous.
      this.logger.debug(`No host session credentials: ${createErrorMessage(error)}`);
      return undefined;
    }

    const webId = credentials.agent?.webId;
    const clientId = credentials.client?.clientId;
    if (!webId || !clientId || !this.hostClientIds.includes(clientId)) {
      return undefined;
    }

    const links = await this.accountStorage.find(WEBID_STORAGE_TYPE, { webId });
    const accountId = links
      .map((link) => link.accountId)
      .find((value): value is string => typeof value === 'string' && value !== '');
    if (!accountId) {
      this.logger.debug(`WebID ${webId} is not linked to an Account.`);
      return undefined;
    }

    return accountId;
  }
}
