import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Provider, { interactionPolicy } from 'oidc-provider';
import {
  AccountPromptFactory, BadRequestHttpError, FoundHttpError, MemoryMapStorage, WrappedExpiringStorage,
} from '@solid/community-server';
import { ScopedPickWebIdHandler } from '../../../src/identity/oidc/ScopedPickWebIdHandler';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';
import { RememberedClientPromptFactory } from '../../../src/identity/oidc/RememberedClientPromptFactory';

// Exercise the installed provider's grant-loading boundary after the CSS interaction is persisted.
const providerEntry = pathToFileURL(createRequire(import.meta.url).resolve('oidc-provider'));
const { default: loadGrant } = await import(new URL('./actions/authorization/load_grant.js', providerEntry).href);

describe('ScopedPickWebIdHandler remembered grants with real provider models', () => {
  const alice = 'https://pod.example/alice/profile/card#me';
  const bob = 'https://pod.example/bob/profile/card#me';
  const clientId = XPOD_DESKTOP_CLIENT_ID;
  let provider: Provider;
  let store: RememberedClientGrantStore;
  let handler: ScopedPickWebIdHandler;

  beforeEach(() => {
    provider = new Provider('https://id.example/', {
      clients: [], cookies: { keys: ['test-only'] },
      features: { devInteractions: { enabled: false } },
    });
    store = new RememberedClientGrantStore(new WrappedExpiringStorage(new MemoryMapStorage()));
    handler = new ScopedPickWebIdHandler({
      providerFactory: { getProvider: async () => provider } as any,
      rememberedClientGrantStore: store,
      ownershipResolver: {
        listAccountWebIds: async () => [alice, bob],
        resolveOwnedWebIds: async () => [alice, bob].map((webId) => ({
          webId, storageUrl: 'https://pod.example/', storageMode: 'cloud' as const,
        })),
      },
    });
  });

  async function fixture(client = clientId, remembered = true) {
    const grant = new provider.Grant({ accountId: alice, clientId: client });
    grant.addOIDCScope('openid webid offline_access');
    const grantId = await grant.save();
    if (remembered) {
      await store.remember((await provider.Grant.find(grantId))!);
      expect((await store.find(provider, alice, client))?.jti).toBe(grantId);
    }
    const session = new provider.Session();
    session.accountId = alice;
    session.grantIdFor(client, grantId);
    session.grantIdFor('https://unrelated.example/client', 'unrelated-grant');
    await session.save(3600);
    const interaction = Object.assign(new provider.Interaction(), {
      session: { accountId: alice, uid: session.uid, cookie: session.jti },
      params: { client_id: client }, grantId, prompt: { name: 'login', details: {} },
      returnTo: 'https://id.example/resume',
      lastSubmission: { account: { accountId: 'css-account' }, consent: { grantId } },
      result: { consent: { grantId } },
    });
    await interaction.save(3600);
    return { grant, grantId, session, interaction };
  }

  function input(interaction: unknown, webId = alice): any {
    return { accountId: 'css-account', oidcInteraction: interaction, json: { webId, remember: false } };
  }

  it.each([alice, bob])('keeps remembered consent while safely selecting %s', async (webId) => {
    const { interaction, session, grantId } = await fixture();
    await expect(handler.handle(input(interaction, webId))).rejects.toBeInstanceOf(FoundHttpError);

    expect((await provider.Grant.find(grantId))?.accountId).toBe(alice);
    expect((await store.find(provider, alice, clientId))?.jti).toBe(grantId);
    const savedSession = (await provider.Session.find(session.jti))!;
    expect(savedSession.accountId).toBeUndefined();
    expect(savedSession.grantIdFor(clientId)).toBeUndefined();
    expect(savedSession.grantIdFor('https://unrelated.example/client')).toBe('unrelated-grant');
    const savedInteraction = (await provider.Interaction.find(interaction.jti))!;
    expect(savedInteraction.grantId).toBeUndefined();
    expect(savedInteraction.lastSubmission?.consent).toBeUndefined();
    expect(savedInteraction.result).toEqual({
      account: { accountId: 'css-account' }, login: { accountId: webId, remember: false },
    });

    // Resume applies loginAccount before loadGrant, which must not retrieve Alice's
    // preserved grant for Bob from either the result or the session authorization.
    savedSession.loginAccount({ accountId: webId });
    const oidc: any = {
      provider, session: savedSession, account: { accountId: webId },
      client: { clientId, applicationType: 'native' }, params: { client_id: clientId, response_type: 'code' },
      result: savedInteraction.result,
      entity: (key: string, value: unknown) => { if (key === 'Grant') oidc.grant = value; },
    };
    const ctx = { oidc };
    await loadGrant(ctx, async () => undefined);
    expect(oidc.grant.accountId).toBe(webId);
    const policy = interactionPolicy.base();
    const source = new AccountPromptFactory({ isLinked: async () => true } as any,
      { get: async () => 'css-account' } as any, 'account-cookie');
    await new RememberedClientPromptFactory(source, store).handle(policy);
    await policy.get('restore_remembered_client')!.checks[0].check(ctx as any);
    expect(oidc.grant.accountId).toBe(webId);
    expect(savedSession.grantIdFor(clientId)).toBe(webId === alice ? grantId : undefined);
    expect(await policy.get('consent')!.checks.get('native_client_prompt')!.check(ctx as any)).toBe(webId !== alice);
  });

  it.each(['unknown', 'unchecked', 'revoked', 'other-client', 'other-grant'])(
    'retains CSS grant removal for %s consent', async (scenario) => {
      const { interaction, grant, grantId, session } = await fixture(
        scenario === 'other-client' ? 'https://other.example/client' : clientId, scenario !== 'unknown',
      );
      if (scenario === 'unchecked') await store.forget(alice, clientId);
      if (scenario === 'revoked') await grant.destroy();
      if (scenario === 'other-grant') {
        const other = new provider.Grant({ accountId: alice, clientId });
        await other.save();
        await store.remember((await provider.Grant.find(other.jti))!);
      }
      await expect(handler.handle(input(interaction))).rejects.toBeInstanceOf(FoundHttpError);
      expect(await provider.Grant.find(grantId)).toBeUndefined();
      expect((await provider.Session.find(session.jti))?.accountId).toBeUndefined();
    },
  );

  it('checks ownership before touching remembered grants or the active session', async () => {
    const { interaction, grantId, session } = await fixture();
    const find = vi.spyOn(store, 'find');
    await expect(handler.handle(input(interaction, 'https://unowned.example/me'))).rejects.toBeInstanceOf(BadRequestHttpError);
    expect(find).not.toHaveBeenCalled();
    expect((await provider.Session.find(session.jti))?.accountId).toBe(alice);
    expect(await provider.Grant.find(grantId)).toBeDefined();
  });
});
