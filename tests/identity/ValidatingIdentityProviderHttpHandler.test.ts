import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BasicRepresentation,
  RepresentationMetadata,
  SOLID_HTTP,
  guardStream,
  type Operation,
} from '@solid/community-server';
import { ValidatingIdentityProviderHttpHandler } from '../../src/identity/ValidatingIdentityProviderHttpHandler';

const createOperation = (...cookies: string[]): Operation => {
  const bodyMetadata = new RepresentationMetadata({ path: 'http://example.test/.account/' });
  for (const cookie of cookies) {
    bodyMetadata.add(SOLID_HTTP.terms.accountCookie, cookie);
  }

  return {
    method: 'GET',
    target: { path: 'http://example.test/.account/' },
    preferences: {},
    body: {
      metadata: bodyMetadata,
      data: guardStream(Readable.from([])),
      binary: true,
      isEmpty: true,
    },
  };
};

const createBasicRepresentationOperation = (...cookies: string[]): Operation => {
  const operation = createOperation(...cookies);
  operation.body = new BasicRepresentation([], operation.body.metadata);
  return operation;
};

const createHandler = ({
  cookieAccountId,
  cookieAccountIds,
  accountExists = false,
  existingAccounts,
}: {
  cookieAccountId?: string;
  cookieAccountIds?: Record<string, string | undefined>;
  accountExists?: boolean;
  existingAccounts?: Set<string>;
} = {}) => {
  const providerFactory = {
    getProvider: vi.fn(async () => ({
      interactionDetails: vi.fn(async () => {
        throw new Error('No active interaction');
      }),
    })),
  };
  const cookieStore = {
    generate: vi.fn(),
    get: vi.fn(async (cookie: string) => cookieAccountIds?.[cookie] ?? cookieAccountId),
    refresh: vi.fn(),
    delete: vi.fn(async () => true),
  };
  const accountStorage = {
    has: vi.fn(async (_type: string, id: string) => existingAccounts?.has(id) ?? accountExists),
  };
  const interactionHandler = {
    handleSafe: vi.fn(async () => new BasicRepresentation('', new RepresentationMetadata({ path: 'http://example.test/.account/' }))),
  };

  const handler = new ValidatingIdentityProviderHttpHandler({
    providerFactory: providerFactory as any,
    cookieStore: cookieStore as any,
    handler: interactionHandler as any,
    accountStorage: accountStorage as any,
  });

  return {
    handler,
    providerFactory,
    cookieStore,
    accountStorage,
    interactionHandler,
  };
};

describe('ValidatingIdentityProviderHttpHandler', () => {
  it('passes through anonymous requests without validating account storage', async () => {
    const { handler, cookieStore, accountStorage, interactionHandler } = createHandler();

    const response = await handler.handle({
      operation: createOperation(),
      request: { headers: {}} as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(cookieStore.get).not.toHaveBeenCalled();
    expect(accountStorage.has).not.toHaveBeenCalled();
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
  });

  it('passes a cookie account id through when the account still exists', async () => {
    const { handler, cookieStore, accountStorage, interactionHandler } = createHandler({
      cookieAccountId: 'account-1',
      accountExists: true,
    });

    const response = await handler.handle({
      operation: createOperation('cookie-1'),
      request: { headers: { cookie: 'css-account=cookie-1' }} as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(cookieStore.get).toHaveBeenCalledWith('cookie-1');
    expect(accountStorage.has).toHaveBeenCalledWith('account', 'account-1');
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-1' }));
    expect(response.metadata?.has(SOLID_HTTP.terms.accountCookieExpiration)).toBe(false);
  });

  it('preserves representation emptiness when replacing account cookie metadata', async () => {
    const { handler, interactionHandler } = createHandler({
      cookieAccountId: 'account-1',
      accountExists: true,
    });
    const operation = createBasicRepresentationOperation('cookie-1');

    await handler.handle({
      operation,
      request: { headers: { cookie: 'css-account=cookie-1' }} as any,
      response: {} as any,
    });

    const forwardedBody = interactionHandler.handleSafe.mock.calls[0]?.[0].operation.body;
    expect(forwardedBody).not.toBe(operation.body);
    expect(forwardedBody.isEmpty).toBe(true);
    expect(forwardedBody.metadata.get(SOLID_HTTP.terms.accountCookie)?.value).toBe('cookie-1');
  });

  it('deletes and expires stale cookies whose account no longer exists', async () => {
    const { handler, cookieStore, accountStorage, interactionHandler } = createHandler({
      cookieAccountId: 'missing-account',
      accountExists: false,
    });

    const response = await handler.handle({
      operation: createOperation('stale-cookie'),
      request: { headers: { cookie: 'css-account=stale-cookie' }} as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(cookieStore.get).toHaveBeenCalledWith('stale-cookie');
    expect(accountStorage.has).toHaveBeenCalledWith('account', 'missing-account');
    expect(cookieStore.delete).toHaveBeenCalledWith('stale-cookie');
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    expect(response.metadata?.get(SOLID_HTTP.terms.accountCookie)?.value).toBe('stale-cookie');
    expect(response.metadata?.get(SOLID_HTTP.terms.accountCookieExpiration)?.value).toBe(new Date(0).toISOString());
  });

  it('uses a valid authorization token even when a stale browser cookie is present', async () => {
    const { handler, cookieStore, accountStorage, interactionHandler } = createHandler({
      cookieAccountIds: {
        'fresh-token': 'account-1',
        'stale-cookie': 'missing-account',
      },
      existingAccounts: new Set([ 'account-1' ]),
    });

    const response = await handler.handle({
      operation: createOperation('fresh-token', 'stale-cookie'),
      request: {
        headers: {
          authorization: 'CSS-Account-Token fresh-token',
          cookie: 'css-account=stale-cookie',
        },
      } as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(cookieStore.get).toHaveBeenCalledWith('fresh-token');
    expect(cookieStore.get).toHaveBeenCalledWith('stale-cookie');
    expect(accountStorage.has).toHaveBeenCalledWith('account', 'account-1');
    expect(accountStorage.has).toHaveBeenCalledWith('account', 'missing-account');
    expect(cookieStore.delete).toHaveBeenCalledWith('stale-cookie');
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-1' }));

    const input = interactionHandler.handleSafe.mock.calls[0]?.[0];
    const forwardedCookies = input.operation.body.metadata.getAll(SOLID_HTTP.terms.accountCookie).map((term) => term.value);
    expect(forwardedCookies).toEqual([ 'fresh-token' ]);
    expect(response.metadata?.get(SOLID_HTTP.terms.accountCookie)?.value).toBe('stale-cookie');
    expect(response.metadata?.get(SOLID_HTTP.terms.accountCookieExpiration)?.value).toBe(new Date(0).toISOString());
  });

  it('preserves a newly issued login cookie instead of replacing it with stale-cookie expiration', async () => {
    const outputMetadata = new RepresentationMetadata({ path: 'http://example.test/.account/login/password/' });
    outputMetadata.add(SOLID_HTTP.terms.accountCookie, 'new-cookie');

    const { handler, cookieStore, interactionHandler } = createHandler({
      cookieAccountIds: {
        'stale-cookie': 'missing-account',
      },
    });
    interactionHandler.handleSafe.mockResolvedValueOnce(
      new BasicRepresentation('', outputMetadata),
    );

    const response = await handler.handle({
      operation: createOperation('stale-cookie'),
      request: { headers: { cookie: 'css-account=stale-cookie' }} as any,
      response: {} as any,
    });

    expect(cookieStore.delete).toHaveBeenCalledWith('stale-cookie');
    expect(response.metadata?.get(SOLID_HTTP.terms.accountCookie)?.value).toBe('new-cookie');
    expect(response.metadata?.has(SOLID_HTTP.terms.accountCookieExpiration)).toBe(false);
  });
});
