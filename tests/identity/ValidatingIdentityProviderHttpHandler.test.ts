import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_JSON,
  BasicRepresentation,
  RedirectingErrorHandler,
  RepresentationMetadata,
  SOLID_HTTP,
  TEXT_HTML,
  guardStream,
  type Operation,
} from '@solid/community-server';
import { ValidatingIdentityProviderHttpHandler } from '../../src/identity/ValidatingIdentityProviderHttpHandler';
import { XPOD_DESKTOP_CLIENT_ID } from '../../src/identity/oidc/RememberedClientGrantStore';

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

const htmlOnly = { type: { [TEXT_HTML]: 1 } };
const jsonOnly = { type: { [APPLICATION_JSON]: 1 } };

const createScopedOperation = (uid: string, subpath = 'oidc/consent/'): Operation => {
  const operation = createOperation();
  operation.target.path = `http://example.test/.account/interaction/${uid}/${subpath}`;
  return operation;
};

/** Capture a rejection so its HTTP semantics can be inspected without a server. */
const captureRejection = async (promise: Promise<unknown>): Promise<{
  statusCode?: number;
  location?: string;
  message?: string;
}> => {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { statusCode?: number; location?: string; message?: string };
  }
  throw new Error('Expected the handler to reject');
};

const createHandler = ({
  cookieAccountId,
  cookieAccountIds,
  accountExists = false,
  existingAccounts,
  externalAccountIssuer,
  sessionCredentials,
  sessionError,
  webIdLinks,
  hostClientIds,
  issuer = 'https://id.example.test/',
}: {
  cookieAccountId?: string;
  cookieAccountIds?: Record<string, string | undefined>;
  accountExists?: boolean;
  existingAccounts?: Set<string>;
  externalAccountIssuer?: string;
  /** What the host's own Solid session verifies to, when one is presented. */
  sessionCredentials?: { agent?: { webId: string }; client?: { clientId: string } };
  /** Makes the session extractor refuse the request instead of returning credentials. */
  sessionError?: string;
  /** WebID to Account links the account storage knows. */
  webIdLinks?: Record<string, string>;
  hostClientIds?: string[];
  /** Provider issuer used as the trusted Account authority. */
  issuer?: string;
} = {}) => {
  const providerFactory = {
    getProvider: vi.fn(async () => ({
      issuer,
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
    find: vi.fn(async (_type: string, query: Record<string, unknown>) => {
      const accountId = webIdLinks?.[String(query.webId)];
      return accountId ? [{ id: 'link-1', webId: String(query.webId), accountId }] : [];
    }),
  };
  const interactionHandler = {
    handleSafe: vi.fn(async (_input: { operation: Operation }) =>
      new BasicRepresentation('', new RepresentationMetadata({ path: 'http://example.test/.account/' }))),
  };
  const sessionExtractor = sessionCredentials || sessionError
    ? {
      handleSafe: vi.fn(async () => {
        if (sessionError) {
          throw new Error(sessionError);
        }
        return sessionCredentials;
      }),
    }
    : undefined;

  const handler = new ValidatingIdentityProviderHttpHandler({
    providerFactory: providerFactory as any,
    cookieStore: cookieStore as any,
    handler: interactionHandler as any,
    accountStorage: accountStorage as any,
    externalAccountIssuer,
    ...(sessionExtractor ? { sessionExtractor: sessionExtractor as any } : {}),
    ...(hostClientIds ? { hostClientIds } : {}),
  });

  return {
    handler,
    providerFactory,
    cookieStore,
    accountStorage,
    interactionHandler,
    sessionExtractor,
  };
};

describe('ValidatingIdentityProviderHttpHandler', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('routes a scoped interaction only after native validation matches its path', async () => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    const interactionDetails = vi.fn().mockResolvedValue({ uid: 'transaction-a' });
    providerFactory.getProvider.mockResolvedValue({ interactionDetails } as any);
    const operation = createOperation();
    operation.target.path = 'http://example.test/.account/interaction/transaction-a/login/password/';
    const request = { headers: { cookie: '_interaction=transaction-a' } } as any;
    const response = {} as any;
    await handler.handle({ operation, request, response });
    expect(interactionDetails).toHaveBeenCalledWith(request, response);
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ target: { path: 'http://example.test/.account/login/password/' } }),
      oidcInteraction: { uid: 'transaction-a' },
    }));
    expect(operation.target.path).toContain('/interaction/transaction-a/');
  });

  it.each(['missing or invalid signature', 'expired interaction', 'session principal changed'])(
    'rejects scoped account operations when native verification fails: %s', async (reason) => {
      const { handler, providerFactory, interactionHandler, cookieStore } = createHandler();
      providerFactory.getProvider.mockResolvedValue({ interactionDetails: vi.fn().mockRejectedValue(new Error(reason)) } as any);
      const operation = createOperation();
      operation.method = 'POST';
      operation.target.path = 'http://example.test/.account/interaction/transaction-a/login/password/';
      await expect(handler.handle({ operation, request: { headers: {} } as any, response: {} as any }))
        .rejects.toThrow('Invalid OIDC interaction');
      expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
      expect(cookieStore.get).not.toHaveBeenCalled();
    },
  );

  it('rejects another interaction cookie instead of authorizing the path transaction', async () => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    providerFactory.getProvider.mockResolvedValue({ interactionDetails: vi.fn().mockResolvedValue({ uid: 'transaction-b' }) } as any);
    const operation = createOperation();
    operation.target.path = 'http://example.test/.account/interaction/transaction-a/oidc/consent/';
    await expect(handler.handle({ operation, request: { headers: {} } as any, response: {} as any }))
      .rejects.toThrow('Invalid OIDC interaction');
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it('sends an expired scoped HTML document to the provider Account index without inner processing', async () => {
    const { handler, providerFactory, interactionHandler, cookieStore, accountStorage } = createHandler({
      issuer: 'https://id.example.test/',
    });
    providerFactory.getProvider.mockResolvedValue({
      issuer: 'https://id.example.test/',
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('expired-transaction');
    operation.preferences = htmlOnly;
    operation.target.path += '?returnTo=https://attacker.example/callback&uid=forged';
    const request = {
      headers: { cookie: 'css-account=stale-cookie', host: 'attacker.example' },
    } as any;

    const error = await captureRejection(handler.handle({ operation, request, response: {} as any }));

    expect(error).toMatchObject({
      statusCode: 303,
      location: 'https://id.example.test/.account/',
      name: 'SeeOtherHttpError',
    });
    expect(error.message).not.toContain('attacker');
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
    expect(cookieStore.get).not.toHaveBeenCalled();
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(accountStorage.has).not.toHaveBeenCalled();
    expect(accountStorage.find).not.toHaveBeenCalled();
  });

  it('never trusts the request Host, expired UID, callback or query as the recovery destination', async () => {
    const { handler, providerFactory } = createHandler({ issuer: 'https://id.example.test/' });
    providerFactory.getProvider.mockResolvedValue({
      issuer: 'https://id.example.test/',
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('forged-uid');
    operation.preferences = htmlOnly;
    operation.target.path = 'https://attacker.example/.account/interaction/forged-uid/oidc/consent/'
      + '?returnTo=https://attacker.example/steal&redirect_uri=https://attacker.example/callback';
    const request = { headers: { host: 'attacker.example' } } as any;

    const error = await captureRejection(handler.handle({ operation, request, response: {} as any }));

    expect(error.statusCode).toBe(303);
    expect(error.location).toBe('https://id.example.test/.account/');
  });

  it.each([
    ['mismatched uid', async (providerFactory: any): Promise<void> => {
      providerFactory.getProvider.mockResolvedValue({
        issuer: 'https://id.example.test/',
        interactionDetails: vi.fn().mockResolvedValue({ uid: 'another-transaction' }),
      });
    }],
    ['native verification failure', async (providerFactory: any): Promise<void> => {
      providerFactory.getProvider.mockResolvedValue({
        issuer: 'https://id.example.test/',
        interactionDetails: vi.fn().mockRejectedValue(new Error('bad signature')),
      });
    }],
  ])('recovers only HTML document GETs when the scoped interaction is invalid: %s', async (_label, setup) => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    await setup(providerFactory);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = htmlOnly;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error).toMatchObject({ statusCode: 303, location: 'https://id.example.test/.account/' });
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'keeps unsafe scoped HTML %s requests failing closed with 400', async (method) => {
      const { handler, providerFactory, interactionHandler } = createHandler();
      providerFactory.getProvider.mockResolvedValue({
        issuer: 'https://id.example.test/',
        interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
      } as any);
      const operation = createScopedOperation('transaction-a');
      operation.method = method;
      operation.preferences = htmlOnly;

      const error = await captureRejection(handler.handle({
        operation,
        request: { headers: {} } as any,
        response: {} as any,
      }));

      expect(error).toMatchObject({ statusCode: 400, message: 'Invalid OIDC interaction' });
      expect(error.location).toBeUndefined();
      expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['JSON Accept', jsonOnly],
    ['wildcard Accept', { type: { '*/*': 1 } }],
    ['HTML/JSON tie', { type: { [TEXT_HTML]: 1, [APPLICATION_JSON]: 1 } }],
    ['absent Accept', {}],
  ])('keeps API scoped GETs failing closed with 400 for %s', async (_label, preferences) => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    providerFactory.getProvider.mockResolvedValue({
      issuer: 'https://id.example.test/',
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = preferences;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error).toMatchObject({ statusCode: 400, message: 'Invalid OIDC interaction' });
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it.each([
    ['HTML weighted above JSON', { type: { [TEXT_HTML]: 1, [APPLICATION_JSON]: 0.5 } }, 303],
    ['JSON weighted above HTML', { type: { [APPLICATION_JSON]: 1, [TEXT_HTML]: 0.5 } }, 400],
  ])('honours the negotiated preference order for scoped invalid GETs: %s', async (_label, preferences, status) => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    providerFactory.getProvider.mockResolvedValue({
      issuer: 'https://id.example.test/',
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = preferences as Operation['preferences'];

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error.statusCode).toBe(status);
    if (status === 303) {
      expect(error.location).toBe('https://id.example.test/.account/');
    } else {
      expect(error.message).toBe('Invalid OIDC interaction');
    }
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it('keeps malformed scoped paths failing closed even when HTML is requested', async () => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    providerFactory.getProvider.mockResolvedValue({
      issuer: 'https://id.example.test/',
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createOperation();
    operation.target.path = 'http://example.test/.account/interaction/not-scoped';
    operation.preferences = htmlOnly;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error).toMatchObject({ statusCode: 400, message: 'Invalid OIDC interaction' });
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it.each([
    ['issuer with a path prefix', 'https://id.example.test/tenant-a/', 'https://id.example.test/tenant-a/.account/'],
    ['issuer with a port', 'https://id.example.test:8443/', 'https://id.example.test:8443/.account/'],
  ])('derives the Account index from the configured issuer: %s', async (_label, issuer, expected) => {
    const { handler, providerFactory } = createHandler({ issuer });
    providerFactory.getProvider.mockResolvedValue({
      issuer,
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = htmlOnly;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error.statusCode).toBe(303);
    expect(error.location).toBe(expected);
  });

  it.each([
    ['HTTP issuer', 'http://id.example.test/', 303],
    ['non-HTTP issuer', 'mailto:accounts@example.test', 400],
  ])('only redirects to a usable HTTP Account authority: %s', async (_label, issuer, status) => {
    const { handler, providerFactory } = createHandler({ issuer });
    providerFactory.getProvider.mockResolvedValue({
      issuer,
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = htmlOnly;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error.statusCode).toBe(status);
    if (status === 400) {
      expect(error.message).toBe('Invalid OIDC interaction');
    }
  });

  it('keeps failing closed when the provider cannot supply an issuer at all', async () => {
    const { handler, providerFactory, interactionHandler } = createHandler();
    providerFactory.getProvider.mockResolvedValue({
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = htmlOnly;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    expect(error).toMatchObject({ statusCode: 400, message: 'Invalid OIDC interaction' });
    expect(interactionHandler.handleSafe).not.toHaveBeenCalled();
  });

  it('still lets a valid native interaction render its HTML document', async () => {
    const { handler, providerFactory, interactionHandler } = createHandler({ issuer: 'https://id.example.test/' });
    const interactionDetails = vi.fn().mockResolvedValue({ uid: 'transaction-a' });
    providerFactory.getProvider.mockResolvedValue({ issuer: 'https://id.example.test/', interactionDetails } as any);
    const operation = createScopedOperation('transaction-a');
    operation.preferences = htmlOnly;

    const response = await handler.handle({
      operation,
      request: { headers: { cookie: '_interaction=transaction-a' } } as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(interactionDetails).toHaveBeenCalled();
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ target: { path: 'http://example.test/.account/oidc/consent/' } }),
      oidcInteraction: { uid: 'transaction-a' },
    }));
  });

  it('throws a CSS redirect error that the real RedirectingErrorHandler converts to 303 with Location', async () => {
    const { handler, providerFactory } = createHandler({ issuer: 'https://id.example.test/' });
    providerFactory.getProvider.mockResolvedValue({
      issuer: 'https://id.example.test/',
      interactionDetails: vi.fn().mockRejectedValue(new Error('expired interaction')),
    } as any);
    const operation = createScopedOperation('expired-transaction');
    operation.preferences = htmlOnly;

    const error = await captureRejection(handler.handle({
      operation,
      request: { headers: {} } as any,
      response: {} as any,
    }));

    const conversion = await new RedirectingErrorHandler().handleSafe({
      error: error as any,
      request: {} as any,
    });
    expect(conversion.statusCode).toBe(303);
    expect(conversion.metadata?.get(SOLID_HTTP.terms.location)?.value)
      .toBe('https://id.example.test/.account/');
  });

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

    const forwardCall = interactionHandler.handleSafe.mock.calls[0];
    if (!forwardCall) {
      throw new Error('Expected interaction handler to receive request');
    }
    const forwardedBody = forwardCall[0].operation.body;
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

    const forwardCall = interactionHandler.handleSafe.mock.calls[0];
    if (!forwardCall) {
      throw new Error('Expected interaction handler to receive request');
    }
    const input = forwardCall[0];
    const forwardedCookies = input.operation.body.metadata
      .getAll(SOLID_HTTP.terms.accountCookie)
      .map((term: { value: string }) => term.value);
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

  it('keeps externally issued cookies the local cookie store cannot validate', async () => {
    const { handler, cookieStore, interactionHandler } = createHandler({
      externalAccountIssuer: 'https://id.undefineds.co/',
    });

    const response = await handler.handle({
      operation: createOperation(),
      request: { headers: { cookie: 'css-account=cloud-issued-token' }} as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(cookieStore.get).toHaveBeenCalledWith('cloud-issued-token');
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    expect(response.metadata?.has(SOLID_HTTP.terms.accountCookieExpiration)).toBe(false);
  });

  it('still expires locally known cookies whose account vanished in external-authority mode', async () => {
    const { handler, cookieStore, accountStorage } = createHandler({
      cookieAccountId: 'missing-account',
      accountExists: false,
      externalAccountIssuer: 'https://id.undefineds.co/',
    });

    const response = await handler.handle({
      operation: createOperation('stale-cookie'),
      request: { headers: { cookie: 'css-account=stale-cookie' }} as any,
      response: {} as any,
    });

    expect(response.statusCode).toBe(200);
    expect(accountStorage.has).toHaveBeenCalledWith('account', 'missing-account');
    expect(cookieStore.delete).toHaveBeenCalledWith('stale-cookie');
    expect(response.metadata?.get(SOLID_HTTP.terms.accountCookieExpiration)?.value).toBe(new Date(0).toISOString());
  });

  describe('host session', () => {
    const WEB_ID = 'https://id.example/ada/profile/card#me';
    const sessionRequest = { headers: { authorization: 'DPoP token', dpop: 'proof' } } as any;

    it.each([
      ['extractor_missing', {}],
      ['verification_failed', { sessionError: 'private token proof cookie details' }],
      ['webid_missing', { sessionCredentials: { client: { clientId: XPOD_DESKTOP_CLIENT_ID } } }],
      ['client_missing', { sessionCredentials: { agent: { webId: WEB_ID } } }],
      ['client_not_host', { sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: 'https://third-party.example/' } } }],
      ['webid_not_linked', { sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } } }],
    ] as const)('reports only the stable %s reason while remaining anonymous', async (reason, options) => {
      const { handler, interactionHandler } = createHandler(options);
      const warning = vi.spyOn(handler['logger'], 'warn').mockImplementation(() => handler['logger']);
      const debug = vi.spyOn(handler['logger'], 'debug').mockImplementation(() => handler['logger']);

      const response = await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });

      expect(response.statusCode).toBe(200);
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
      expect(warning.mock.calls).toEqual([[`Host session Account authorization rejected: ${reason}`]]);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private token proof cookie details');
      expect(JSON.stringify(debug.mock.calls)).not.toContain(WEB_ID);
    });

    it.each([{}, { authorization: 'Bearer token' }])('does not log a rejection for non-DPoP requests', async (headers) => {
      const { handler } = createHandler();
      const warning = vi.spyOn(handler['logger'], 'warn').mockImplementation(() => handler['logger']);

      await handler.handle({ operation: createOperation(), request: { headers } as any, response: {} as any });

      expect(warning).not.toHaveBeenCalled();
    });

    it('names the Account that owns the session WebID without an Account cookie', async () => {
      const { handler, accountStorage, interactionHandler, sessionExtractor } = createHandler({
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
        webIdLinks: { [WEB_ID]: 'account-7' },
        accountExists: true,
      });
      const warning = vi.spyOn(handler['logger'], 'warn').mockImplementation(() => handler['logger']);

      const response = await handler.handle({
        operation: createOperation(),
        request: sessionRequest,
        response: {} as any,
      });

      expect(response.statusCode).toBe(200);
      expect(warning).not.toHaveBeenCalled();
      expect(sessionExtractor?.handleSafe).toHaveBeenCalledWith(sessionRequest);
      expect(accountStorage.find).toHaveBeenCalledWith('webIdLink', { webId: WEB_ID });
      expect(accountStorage.has).toHaveBeenCalledWith('account', 'account-7');
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-7' }));
    });

    it('keeps a client the host does not ship from naming an Account', async () => {
      const { handler, accountStorage, interactionHandler } = createHandler({
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: 'https://app.example/client.json' } },
        webIdLinks: { [WEB_ID]: 'account-7' },
      });

      await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });

      expect(accountStorage.find).not.toHaveBeenCalled();
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('keeps a WebID no Account linked anonymous instead of failing the request', async () => {
      const { handler, interactionHandler } = createHandler({
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
      });

      const response = await handler.handle({
        operation: createOperation(),
        request: sessionRequest,
        response: {} as any,
      });

      expect(response.statusCode).toBe(200);
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('stays anonymous when the session itself does not verify', async () => {
      const { handler, accountStorage, interactionHandler } = createHandler({
        sessionError: 'Error verifying WebID via DPoP-bound access token: invalid proof',
        webIdLinks: { [WEB_ID]: 'account-7' },
      });

      const response = await handler.handle({
        operation: createOperation(),
        request: sessionRequest,
        response: {} as any,
      });

      expect(response.statusCode).toBe(200);
      expect(accountStorage.find).not.toHaveBeenCalled();
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('never turns a replayable bearer credential into Account authority', async () => {
      const { handler, accountStorage, sessionExtractor, interactionHandler } = createHandler({
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
        webIdLinks: { [WEB_ID]: 'account-7' },
      });

      await handler.handle({
        operation: createOperation(),
        request: { headers: { authorization: 'Bearer token' } } as any,
        response: {} as any,
      });

      expect(sessionExtractor?.handleSafe).not.toHaveBeenCalled();
      expect(accountStorage.find).not.toHaveBeenCalled();
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('prefers the Account cookie over the session', async () => {
      const { handler, accountStorage, interactionHandler } = createHandler({
        cookieAccountId: 'account-cookie',
        accountExists: true,
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
        webIdLinks: { [WEB_ID]: 'account-7' },
      });

      await handler.handle({
        operation: createOperation('cookie-1'),
        request: { headers: { cookie: 'css-account=cookie-1' } } as any,
        response: {} as any,
      });

      expect(accountStorage.find).not.toHaveBeenCalled();
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-cookie' }));
    });

    it('accepts an extra configured host client', async () => {
      const { handler, interactionHandler } = createHandler({
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: 'https://host.example/client.json' } },
        webIdLinks: { [WEB_ID]: 'account-7' },
        hostClientIds: ['https://host.example/client.json'],
        accountExists: true,
      });

      await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });

      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-7' }));
    });

    it('keeps a link to a deleted Account anonymous', async () => {
      const { handler, interactionHandler, accountStorage } = createHandler({
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
        webIdLinks: { [WEB_ID]: 'deleted-account' },
      });
      await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });
      expect(accountStorage.has).toHaveBeenCalledWith('account', 'deleted-account');
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('rejects a WebID linked to several Accounts instead of selecting the first', async () => {
      const { handler, interactionHandler, accountStorage } = createHandler({
        accountExists: true,
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
      });
      accountStorage.find.mockResolvedValue([
        { id: 'link-a', webId: WEB_ID, accountId: 'account-a' },
        { id: 'link-b', webId: WEB_ID, accountId: 'account-b' },
      ]);
      await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });
      expect(accountStorage.has).not.toHaveBeenCalled();
      expect(interactionHandler.handleSafe).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
    });

    it('checks the current link and Account existence again on the next request', async () => {
      const { handler, interactionHandler, accountStorage } = createHandler({
        accountExists: true,
        sessionCredentials: { agent: { webId: WEB_ID }, client: { clientId: XPOD_DESKTOP_CLIENT_ID } },
        webIdLinks: { [WEB_ID]: 'account-7' },
      });
      await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });
      accountStorage.find.mockResolvedValue([]);
      await handler.handle({ operation: createOperation(), request: sessionRequest, response: {} as any });
      expect(accountStorage.find).toHaveBeenCalledTimes(2);
      expect(interactionHandler.handleSafe.mock.calls[0]?.[0]).toMatchObject({ accountId: 'account-7' });
      expect(interactionHandler.handleSafe.mock.calls[1]?.[0]).toMatchObject({ accountId: undefined });
    });
  });
});
