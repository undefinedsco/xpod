import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Provider, { interactionPolicy } from 'oidc-provider';
import {
  AccountPromptFactory, BadRequestHttpError, FoundHttpError, MemoryMapStorage, NotFoundHttpError, WrappedExpiringStorage,
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
  let ownedWebIds: string[];

  beforeEach(() => {
    provider = new Provider('https://id.example/', {
      clients: [], cookies: { keys: ['test-only'] },
      features: { devInteractions: { enabled: false } },
    });
    store = new RememberedClientGrantStore(new WrappedExpiringStorage(new MemoryMapStorage()));
    ownedWebIds = [alice, bob];
    handler = new ScopedPickWebIdHandler({
      providerFactory: { getProvider: async () => provider } as any,
      rememberedClientGrantStore: store,
      ownershipResolver: {
        listAccountWebIds: async () => [alice, bob],
        resolveOwnedWebIds: async () => ownedWebIds.map((webId) => ({
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
    const interaction = new provider.Interaction();
    Object.assign(interaction, {
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

  describe('read-only login resumption hint', () => {
    beforeEach(() => { ownedWebIds = [alice]; });

    async function coldLogin(remembered = true) {
      const value = await fixture(clientId, remembered);
      value.interaction.prompt.reasons = ['no_session'];
      delete value.interaction.session;
      delete value.interaction.grantId;
      delete value.interaction.result;
      delete value.interaction.lastSubmission;
      await value.interaction.persist();
      return value;
    }

    it.each([false, true])('offers the unique remembered WebID without writing state (duplicate binding: %s)', async (duplicate) => {
      if (duplicate) ownedWebIds = [alice, alice];
      const { interaction, grantId, session } = await coldLogin();
      const find = vi.spyOn(store, 'find');
      const remember = vi.spyOn(store, 'remember');
      const forget = vi.spyOn(store, 'forget');
      const sessionPersist = vi.spyOn(provider.Session.prototype, 'persist');
      const interactionPersist = vi.spyOn(provider.Interaction.prototype, 'persist');
      const grantSave = vi.spyOn(provider.Grant.prototype, 'save');
      const grantDestroy = vi.spyOn(provider.Grant.prototype, 'destroy');
      const view = await handler.getView(input(interaction));
      expect(view.json.resumeWebId).toBe(alice);
      expect(find).toHaveBeenCalledWith(provider, alice, clientId);
      for (const mutation of [remember, forget, sessionPersist, interactionPersist, grantSave, grantDestroy]) {
        expect(mutation).not.toHaveBeenCalled();
      }
      expect((await provider.Session.find(session.jti))?.grantIdFor(clientId)).toBe(grantId);
      expect((await provider.Interaction.find(interaction.jti))?.result).toBeUndefined();
      expect((await provider.Grant.find(grantId))?.accountId).toBe(alice);
    });

    it.each(['first-login', 'unchecked', 'revoked', 'expired', 'other-client', 'multiple-webids',
      'unowned', 'missing-interaction', 'consent-interaction', 'explicit-login', 'explicit-select-account',
      'combined-explicit-login'])(
      'does not offer a resumption hint for %s', async (scenario) => {
        const { interaction, grantId } = await coldLogin(scenario !== 'first-login');
        if (scenario === 'unchecked') await store.forget(alice, clientId);
        if (scenario === 'revoked') await (await provider.Grant.find(grantId))!.destroy();
        if (scenario === 'expired') {
          const grant = (await provider.Grant.find(grantId))!;
          grant.exp = Math.floor(Date.now() / 1000) - 60;
          await grant.save();
        }
        if (scenario === 'other-client') interaction.params.client_id = 'https://other.example/client';
        if (scenario === 'multiple-webids') ownedWebIds = [alice, bob];
        if (scenario === 'unowned') ownedWebIds = [];
        if (scenario === 'consent-interaction') interaction.prompt.name = 'consent';
        if (scenario === 'explicit-login') interaction.params.prompt = 'login';
        if (scenario === 'explicit-select-account') interaction.params.prompt = 'select_account';
        if (scenario === 'combined-explicit-login') interaction.params.prompt = 'consent login';
        const view = await handler.getView(input(scenario === 'missing-interaction' ? undefined : interaction));
        expect(view.json).not.toHaveProperty('resumeWebId');
      },
    );

    it('requires the authenticated CSS account before looking up remembered grants', async () => {
      const { interaction } = await coldLogin();
      const find = vi.spyOn(store, 'find');
      await expect(handler.getView({ ...input(interaction), accountId: undefined })).rejects.toBeInstanceOf(NotFoundHttpError);
      expect(find).not.toHaveBeenCalled();
    });

    it.each([0, '0', 300, '300'])('does not offer resumption when max_age=%s requires authentication freshness', async (maxAge) => {
      const { interaction } = await coldLogin();
      interaction.params.max_age = maxAge;
      const find = vi.spyOn(store, 'find');
      const view = await handler.getView(input(interaction));
      expect(view.json).not.toHaveProperty('resumeWebId');
      expect(find).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'missing', reasons: undefined },
      { name: 'empty', reasons: [] },
      { name: 'unknown', reasons: ['unknown_login_reason'] },
      { name: 'mixed', reasons: ['no_session', 'id_token_hint'] },
      { name: 'duplicate', reasons: ['no_session', 'no_session'] },
      { name: 'id_token_hint', reasons: ['id_token_hint'] },
      { name: 'requested subject', reasons: ['claims_id_token_sub_value'] },
      { name: 'essential acr', reasons: ['essential_acr'] },
      { name: 'essential acrs', reasons: ['essential_acrs'] },
      { name: 'malformed', reasons: 'no_session' },
    ])('does not offer resumption for $name login reasons', async ({ reasons }) => {
      const { interaction } = await coldLogin();
      if (reasons === undefined) Reflect.deleteProperty(interaction.prompt, 'reasons');
      else Object.assign(interaction.prompt, { reasons });
      const find = vi.spyOn(store, 'find');
      const view = await handler.getView(input(interaction));
      expect(view.json).not.toHaveProperty('resumeWebId');
      expect(find).not.toHaveBeenCalled();
    });

    it.each(['explicit-consent', 'new-scope'])('restores login while preserving the %s consent check', async (scenario) => {
      const { interaction, grantId } = await coldLogin();
      if (scenario === 'explicit-consent') interaction.params.prompt = 'consent';
      interaction.params.scope = scenario === 'new-scope' ? 'openid webid email' : 'openid webid';
      const view = await handler.getView(input(interaction));
      expect(view.json.resumeWebId).toBe(alice);
      await expect(handler.handle(input(interaction))).rejects.toBeInstanceOf(FoundHttpError);
      expect(interaction.result).toEqual({ login: { accountId: alice, remember: false } });

      const session = new provider.Session();
      session.loginAccount({ accountId: alice });
      const oidc: any = {
        provider, session, account: { accountId: alice },
        client: { clientId, applicationType: 'native' },
        params: { client_id: clientId, response_type: 'code' }, result: interaction.result,
        requestParamOIDCScopes: new Set(String(interaction.params.scope).split(' ')),
        prompts: new Set(scenario === 'explicit-consent' ? ['consent'] : []),
        promptPending: () => true,
        entity: (key: string, value: unknown) => { if (key === 'Grant') oidc.grant = value; },
      };
      const ctx = { oidc };
      await loadGrant(ctx, async () => undefined);
      const policy = interactionPolicy.base();
      const source = new AccountPromptFactory({ isLinked: async () => true } as any,
        { get: async () => 'css-account' } as any, 'account-cookie');
      await new RememberedClientPromptFactory(source, store).handle(policy);
      await policy.get('restore_remembered_client')!.checks[0].check(ctx as any);
      expect(oidc.grant.jti).toBe(grantId);
      const check = scenario === 'explicit-consent' ? 'consent_prompt' : 'op_scopes_missing';
      expect(await policy.get('consent')!.checks.get(check)!.check(ctx as any)).toBe(true);
    });
  });

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
