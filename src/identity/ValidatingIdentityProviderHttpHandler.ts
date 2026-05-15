import { getLoggerFor } from 'global-logger-factory';
import {
  OkResponseDescription,
  OperationHttpHandler,
  RepresentationMetadata,
  SOLID_HTTP,
  createErrorMessage,
  type InteractionHandler,
  type OperationHttpHandlerInput,
  type ProviderFactory,
  type ResponseDescription,
} from '@solid/community-server';
import type { CookieStore } from '@solid/community-server';

const ACCOUNT_TYPE = 'account';
const ACCOUNT_COOKIE_NAME = 'css-account';
const ACCOUNT_TOKEN_AUTHORIZATION_SCHEME = 'CSS-Account-Token ';

interface AccountExistenceStorage {
  has: (type: string, id: string) => Promise<boolean>;
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

  public constructor(args: ValidatingIdentityProviderHttpHandlerArgs) {
    super();
    this.providerFactory = args.providerFactory;
    this.cookieStore = args.cookieStore;
    this.handler = args.handler;
    this.accountStorage = args.accountStorage;
  }

  public override async handle({ operation, request, response }: OperationHttpHandlerInput): Promise<ResponseDescription> {
    let oidcInteraction;
    try {
      const provider = await this.providerFactory.getProvider();
      oidcInteraction = await provider.interactionDetails(request, response);
      this.logger.debug('Found an active OIDC interaction.');
    } catch (error: unknown) {
      this.logger.debug(`No active OIDC interaction found: ${createErrorMessage(error)}`);
    }

    const browserCookie = this.findBrowserAccountCookie(request);
    const authorizationCookie = this.findAuthorizationAccountCookie(request);
    const cookies = this.findAccountCookies(operation, authorizationCookie, browserCookie);
    const { accountId, selectedCookie, expiredCookie } = await this.findValidAccount(cookies, browserCookie);
    const normalizedOperation = this.normalizeAccountCookie(operation, selectedCookie);
    const representation = await this.handler.handleSafe({ operation: normalizedOperation, oidcInteraction, accountId });

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
        if (cookie === browserCookie) {
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
}
