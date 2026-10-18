import { createHash, randomBytes } from 'node:crypto';
import { ACCOUNT_TYPE, BadRequestHttpError, ForbiddenHttpError, NotFoundHttpError,
  type AccountStore, type LoginStorage, type ExpiringReadWriteLocker } from '@solid/community-server';
import { createWechatLoginProvider, type ExternalLoginProvider } from './ExternalLoginProvider';
import { ExternalLoginRepository, type ExternalLoginTransaction } from './ExternalLoginRepository';

export const EXTERNAL_LOGIN_TYPE = 'external-login';
export const externalLoginDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface ExternalLoginServiceOptions {
  accountStorage: LoginStorage<any>;
  accountStore: AccountStore;
  locker: ExpiringReadWriteLocker;
  identityDbUrl: string;
  baseUrl: string;
  oidcIssuer?: string;
  wechatAppId?: string;
  wechatAppSecret?: string;
}

interface LoginRow { id: string; accountId: string; provider: string; namespace: string; subject: string; unionId?: string }

export class ExternalLoginService {
  private readonly providerRegistry = new Map<string, ExternalLoginProvider>();
  private readonly repository: ExternalLoginRepository;
  private readonly ready: Promise<void>;
  private readonly accountUrl: URL;

  public get providers(): Map<string, ExternalLoginProvider> { return this.providerRegistry; }
  public get accountRoot(): URL { return this.accountUrl; }

  public constructor(private readonly options: ExternalLoginServiceOptions) {
    this.accountUrl = new URL('.account/', options.baseUrl);
    const isAuthority = !options.oidcIssuer || new URL(options.oidcIssuer).href.replace(/\/$/u, '') === new URL(options.baseUrl).href.replace(/\/$/u, '');
    if (Boolean(options.wechatAppId) !== Boolean(options.wechatAppSecret)) throw new Error('WeChat requires both AppID and AppSecret');
    if (isAuthority && options.wechatAppId && options.wechatAppSecret) {
      const provider = createWechatLoginProvider(options.wechatAppId, options.wechatAppSecret);
      this.providers.set(provider.id, provider);
    }
    this.repository = new ExternalLoginRepository(options.identityDbUrl);
    this.ready = options.accountStorage.defineType(EXTERNAL_LOGIN_TYPE, {
      accountId: `id:${ACCOUNT_TYPE}`, provider: 'string', namespace: 'string', subject: 'string', unionId: 'string?',
    }, true);
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
    const key = this.subjectKey(provider, identity.subject);
    await this.ready;
    return this.withSubjectLock(key, async () => {
      const reservation = await this.repository.reserve(key);
      const previousId = reservation.loginId;
      try {
        const previous = previousId ? await this.options.accountStorage.get(EXTERNAL_LOGIN_TYPE, previousId) as LoginRow | undefined : undefined;
        let accountId: string;
        if (previousId) {
          // A stale index must not silently grant an identity to another/new account.
          if (!previous || previous.provider !== provider.id || previous.namespace !== provider.namespace || previous.subject !== identity.subject
            || !await this.options.accountStorage.has(ACCOUNT_TYPE, previous.accountId)) throw new ForbiddenHttpError('EXTERNAL_IDENTITY_INVALID');
          if (transaction.intent === 'link' && previous.accountId !== transaction.accountId) throw new BadRequestHttpError('EXTERNAL_IDENTITY_ALREADY_BOUND');
          accountId = previous.accountId;
        } else {
          if (transaction.intent === 'login') throw new BadRequestHttpError('EXTERNAL_ACCOUNT_NOT_LINKED');
          accountId = transaction.intent === 'link' ? transaction.accountId! : await this.options.accountStore.create();
          if (!await this.options.accountStorage.has(ACCOUNT_TYPE, accountId)) throw new ForbiddenHttpError('ACCOUNT_LOGIN_REQUIRED');
          const row = await this.options.accountStorage.create(EXTERNAL_LOGIN_TYPE, {
            accountId, provider: provider.id, namespace: provider.namespace, subject: identity.subject, ...(identity.unionId ? { unionId: identity.unionId } : {}),
          });
          await this.repository.claim(key, reservation.owner!, row.id);
        }
        return { accountId, remember: transaction.intent === 'link' ? undefined : transaction.remember, location: transaction.returnTo };
      } catch (error) {
        if (reservation.owner) await this.repository.remove(key, reservation.owner);
        throw error;
      }
    });
  }

  public async unlink(providerId: string, accountId: string): Promise<void> {
    const provider = this.provider(providerId);
    await this.ready;
    const rows = await this.options.accountStorage.find(EXTERNAL_LOGIN_TYPE, { accountId, provider: provider.id, namespace: provider.namespace }) as unknown as LoginRow[];
    for (const row of rows) {
      const key = this.subjectKey(provider, row.subject);
      await this.withSubjectLock(key, async () => {
        await this.options.accountStorage.delete(EXTERNAL_LOGIN_TYPE, row.id);
        await this.repository.remove(key, row.id);
      });
    }
  }

  public async isLinked(providerId: string, accountId?: string): Promise<boolean> {
    if (!accountId) return false;
    const provider = this.provider(providerId);
    await this.ready;
    return (await this.options.accountStorage.find(EXTERNAL_LOGIN_TYPE, { accountId, provider: provider.id, namespace: provider.namespace })).length > 0;
  }

  private subjectKey(provider: ExternalLoginProvider, subject: string): string {
    return externalLoginDigest(JSON.stringify([provider.id, provider.namespace, subject]));
  }

  private withSubjectLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.options.locker.withWriteLock({ path: new URL(`locks/external-login/${key}`, this.accountRoot).href }, action);
  }
}
