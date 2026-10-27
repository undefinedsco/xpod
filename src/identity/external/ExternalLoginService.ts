import { createHash, randomBytes } from 'node:crypto';
import { ACCOUNT_TYPE, BadRequestHttpError, ForbiddenHttpError, NotFoundHttpError,
  type AccountStore, type LoginStorage } from '@solid/community-server';
import type { ExternalLoginProvider } from './ExternalLoginProvider';
import type { ExternalLoginConnectorFactory, ExternalLoginEntry } from './ExternalLoginProviderFactory';
import { configuredExternalLoginEntries, createExternalLoginProviderFactory, type ExternalLoginDeploymentConfig } from './externalLoginProviders';
import { ExternalLoginRepository, type ExternalLoginTransaction } from './ExternalLoginRepository';
import type { ExternalIdentityAccountStorage } from './ExternalIdentityAccountStorage';
import { EXTERNAL_LOGIN_DESCRIPTION, EXTERNAL_LOGIN_TYPE, type ExternalIdentityRow } from './ExternalIdentityStorage';
export { EXTERNAL_LOGIN_TYPE } from './ExternalIdentityStorage';

export const externalLoginDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface ExternalLoginServiceOptions extends ExternalLoginDeploymentConfig {
  accountStorage: LoginStorage<any>;
  accountStore: AccountStore;
  identityDbUrl: string;
  baseUrl: string;
  oidcIssuer?: string;
}

export class ExternalLoginService {
  private readonly providerFactory = createExternalLoginProviderFactory();
  private readonly providerRegistry = new Map<string, ExternalLoginProvider>();
  private readonly repository: ExternalLoginRepository;
  private readonly ready: Promise<void>;
  private readonly accountUrl: URL;
  private readonly isAuthority: boolean;
  private readonly accounts: ExternalIdentityAccountStorage;

  public get providers(): ReadonlyMap<string, ExternalLoginProvider> { return this.providerRegistry; }
  public get accountRoot(): URL { return this.accountUrl; }

  public constructor(private readonly options: ExternalLoginServiceOptions) {
    this.accounts = options.accountStorage as ExternalIdentityAccountStorage;
    if (typeof this.accounts.withTransaction !== 'function' || typeof this.accounts.withAccountTransaction !== 'function') {
      throw new Error('External login requires transactional identity account storage');
    }
    this.accountUrl = new URL('.account/', options.baseUrl);
    this.isAuthority = !options.oidcIssuer || new URL(options.oidcIssuer).href.replace(/\/$/u, '') === new URL(options.baseUrl).href.replace(/\/$/u, '');
    const entries = configuredExternalLoginEntries(options);
    if (this.isAuthority) for (const entry of entries) this.registerProvider(entry);
    this.repository = new ExternalLoginRepository(options.identityDbUrl);
    this.ready = options.accountStorage.defineType(EXTERNAL_LOGIN_TYPE, EXTERNAL_LOGIN_DESCRIPTION, true);
  }

  public registerConnector(connector: ExternalLoginConnectorFactory): void { this.providerFactory.register(connector); }

  public registerProvider(entry: ExternalLoginEntry): void {
    if (!this.isAuthority) throw new Error('External login entries require the account authority');
    if (this.providerRegistry.has(entry.id)) throw new Error(`Duplicate external login entry: ${entry.id}`);
    const provider = this.providerFactory.create(entry);
    this.providerRegistry.set(provider.id, provider);
  }

  public provider(id: string): ExternalLoginProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new NotFoundHttpError('EXTERNAL_LOGIN_NOT_CONFIGURED');
    return provider;
  }

  public async begin(providerId: string, proof: string, transaction: Omit<ExternalLoginTransaction, 'provider'>) {
    const provider = this.provider(providerId);
    if (!/^[\w-]{43,128}$/u.test(proof)) throw new BadRequestHttpError('INVALID_BROWSER_PROOF');
    if (transaction.intent === 'link' && !transaction.accountId) throw new ForbiddenHttpError('ACCOUNT_LOGIN_REQUIRED');
    const state = randomBytes(32).toString('base64url');
    const redirectUri = new URL(`login/${provider.id}/callback/`, this.accountRoot).href;
    const authorizationUrl = await provider.authorizationUrl(state, redirectUri);
    await this.repository.begin(externalLoginDigest(state), externalLoginDigest(proof), { ...transaction, provider: provider.id });
    return { state, authorizationUrl, callback: transaction.callback };
  }

  public async finish(providerId: string, input: { state: string; proof: string; code: string; callback: string; accountId?: string; interaction?: string }) {
    const provider = this.provider(providerId);
    if (!/^[\w-]{43}$/u.test(input.state) || !/^[\w-]{43,128}$/u.test(input.proof) || !input.code || input.code.length > 1024) {
      throw new BadRequestHttpError('INVALID_EXTERNAL_CALLBACK');
    }
    const transaction = await this.repository.consume(externalLoginDigest(input.state), externalLoginDigest(input.proof));
    if (transaction.provider !== provider.id || transaction.callback !== input.callback || transaction.interaction !== input.interaction
      || transaction.accountId !== input.accountId) {
      throw new ForbiddenHttpError('EXTERNAL_LOGIN_CONTEXT_CHANGED');
    }
    const identity = await provider.identity(input.code);
    await this.ready;
    const accounts = this.accounts;
    return accounts.withTransaction(async () => {
      const previous = (await accounts.find(EXTERNAL_LOGIN_TYPE, {
        provider: provider.provider, namespace: provider.namespace, subject: identity.subject,
      }) as ExternalIdentityRow[])[0];
      let accountId: string;
      if (previous) {
        accountId = await accounts.withAccountTransaction(previous.accountId, async () => {
          if (!await accounts.has(EXTERNAL_LOGIN_TYPE, previous.id)) throw new ForbiddenHttpError('EXTERNAL_IDENTITY_INVALID');
          if (transaction.intent === 'link' && previous.accountId !== transaction.accountId) throw new BadRequestHttpError('EXTERNAL_IDENTITY_ALREADY_BOUND');
          return previous.accountId;
        });
      } else {
        if (transaction.intent === 'login') throw new BadRequestHttpError('EXTERNAL_ACCOUNT_NOT_LINKED');
        accountId = transaction.intent === 'link' ? transaction.accountId! : await this.options.accountStore.create();
        if (!await accounts.has(ACCOUNT_TYPE, accountId)) throw new ForbiddenHttpError('ACCOUNT_LOGIN_REQUIRED');
        await accounts.create(EXTERNAL_LOGIN_TYPE, {
          accountId, provider: provider.provider, namespace: provider.namespace, subject: identity.subject,
          ...(identity.unionId ? { unionId: identity.unionId } : {}),
        });
      }
      return { accountId, remember: transaction.intent === 'link' ? undefined : transaction.remember, location: transaction.returnTo };
    }, `external:${externalLoginDigest(JSON.stringify([provider.provider, provider.namespace, identity.subject]))}`);
  }

  public async unlink(providerId: string, accountId: string): Promise<void> {
    const provider = this.provider(providerId);
    await this.ready;
    const accounts = this.accounts;
    await accounts.withTransaction(async () => {
      const rows = await accounts.find(EXTERNAL_LOGIN_TYPE, { accountId, provider: provider.provider, namespace: provider.namespace }) as ExternalIdentityRow[];
      for (const row of rows) await accounts.delete(EXTERNAL_LOGIN_TYPE, row.id);
    });
  }

  public async isLinked(providerId: string, accountId?: string): Promise<boolean> {
    if (!accountId) return false;
    const provider = this.provider(providerId);
    await this.ready;
    return (await this.options.accountStorage.find(EXTERNAL_LOGIN_TYPE, { accountId, provider: provider.provider, namespace: provider.namespace })).length > 0;
  }

}
