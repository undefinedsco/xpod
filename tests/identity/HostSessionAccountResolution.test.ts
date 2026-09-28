import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BaseAccountStore,
  BaseWebIdStore,
  BasicRepresentation,
  RepresentationMetadata,
  SOLID_HTTP,
  guardStream,
  type AccountLoginStorage,
  type Operation,
} from '@solid/community-server';
import { DrizzleIndexedStorage } from '../../src/identity/drizzle/DrizzleIndexedStorage';
import { LoginMethodGuardStorage } from '../../src/identity/LoginMethodGuardStorage';
import { ValidatingIdentityProviderHttpHandler } from '../../src/identity/ValidatingIdentityProviderHttpHandler';
import { XPOD_DESKTOP_CLIENT_ID } from '../../src/identity/oidc/RememberedClientGrantStore';

const WEB_ID = 'https://id.example/ada/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';

/**
 * The session path reads the Account from CSS's own WebID links, so the lookup has
 * to work on the storage Xpod actually deploys: the guarded login storage on top of
 * the Drizzle indexed storage, with the link type CSS itself defines.
 */
async function createAccountStorage() {
  const raw = new DrizzleIndexedStorage(`sqlite::memory:webid-link-${randomUUID()}`);
  const storage = new LoginMethodGuardStorage(raw);
  const cssStorage = storage as unknown as AccountLoginStorage<Record<string, never>>;
  const accounts = new BaseAccountStore(cssStorage);
  const links = new BaseWebIdStore(cssStorage);
  await accounts.handle();
  await links.handle();
  return { accounts, links, accountStorage: storage };
}

function createOperation(): Operation {
  return {
    method: 'GET',
    target: { path: 'http://example.test/.account/' },
    preferences: {},
    body: {
      metadata: new RepresentationMetadata({ path: 'http://example.test/.account/' }),
      data: guardStream(Readable.from([])),
      binary: true,
      isEmpty: true,
    },
  };
}

async function runHandler(input: {
  accountStorage: LoginMethodGuardStorage;
  webId?: string;
  clientId?: string;
  authorization?: string;
}) {
  const interactionHandler = {
    handleSafe: vi.fn(async () => new BasicRepresentation('', new RepresentationMetadata({ path: 'http://example.test/.account/' }))),
  };
  const handler = new ValidatingIdentityProviderHttpHandler({
    providerFactory: { getProvider: vi.fn(async () => ({ interactionDetails: vi.fn(async () => { throw new Error('none'); }) })) } as any,
    cookieStore: { get: vi.fn(async () => undefined), generate: vi.fn(), refresh: vi.fn(), delete: vi.fn(async () => true) } as any,
    handler: interactionHandler as any,
    accountStorage: input.accountStorage as any,
    sessionExtractor: {
      handleSafe: vi.fn(async () => ({
        agent: { webId: input.webId },
        client: { clientId: input.clientId },
      })),
    } as any,
  });

  await handler.handle({
    operation: createOperation(),
    request: { headers: { authorization: input.authorization ?? 'DPoP token', dpop: 'proof' } } as any,
    response: {} as any,
  });

  const call = interactionHandler.handleSafe.mock.calls[0]?.[0] as { accountId?: string } | undefined;
  return call?.accountId;
}

describe('Account resolution from a host session', () => {
  it('finds the Account that owns the session WebID in the deployed storage', async () => {
    const { accounts, links, accountStorage } = await createAccountStorage();
    const accountId = await accounts.create();
    await links.create(WEB_ID, accountId);

    await expect(runHandler({
      accountStorage,
      webId: WEB_ID,
      clientId: XPOD_DESKTOP_CLIENT_ID,
    })).resolves.toBe(accountId);
  });

  it('never crosses to another Account that linked a different WebID', async () => {
    const { accounts, links, accountStorage } = await createAccountStorage();
    const mine = await accounts.create();
    const theirs = await accounts.create();
    await links.create(WEB_ID, mine);
    await links.create(OTHER_WEB_ID, theirs);

    await expect(runHandler({
      accountStorage,
      webId: OTHER_WEB_ID,
      clientId: XPOD_DESKTOP_CLIENT_ID,
    })).resolves.toBe(theirs);
  });

  it('stays anonymous for a WebID the Account store never linked', async () => {
    const { accounts, accountStorage } = await createAccountStorage();
    await accounts.create();

    await expect(runHandler({
      accountStorage,
      webId: WEB_ID,
      clientId: XPOD_DESKTOP_CLIENT_ID,
    })).resolves.toBeUndefined();
  });

  it('stays anonymous for a client the host does not ship', async () => {
    const { accounts, links, accountStorage } = await createAccountStorage();
    const accountId = await accounts.create();
    await links.create(WEB_ID, accountId);

    await expect(runHandler({
      accountStorage,
      webId: WEB_ID,
      clientId: 'https://app.example/client.json',
    })).resolves.toBeUndefined();
  });

  it('stays anonymous for a replayable bearer credential', async () => {
    const { accounts, links, accountStorage } = await createAccountStorage();
    const accountId = await accounts.create();
    await links.create(WEB_ID, accountId);

    await expect(runHandler({
      accountStorage,
      webId: WEB_ID,
      clientId: XPOD_DESKTOP_CLIENT_ID,
      authorization: 'Bearer token',
    })).resolves.toBeUndefined();
  });
});
