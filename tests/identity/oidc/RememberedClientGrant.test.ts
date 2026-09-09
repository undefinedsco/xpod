import { beforeEach, describe, expect, it, vi } from 'vitest';
import Provider, { interactionPolicy } from 'oidc-provider';
import {
  AccountPromptFactory, ConsentHandler, FoundHttpError, MemoryMapStorage, WrappedExpiringStorage,
} from '@solid/community-server';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';
import { RememberedConsentHandler } from '../../../src/identity/oidc/RememberedConsentHandler';
import { RememberedClientPromptFactory } from '../../../src/identity/oidc/RememberedClientPromptFactory';

describe('remembered client consent with CSS and oidc-provider', () => {
  const accountId = 'https://pod.example/alice/profile/card#me';
  const clientId = XPOD_DESKTOP_CLIENT_ID;
  let provider: Provider;
  let store: RememberedClientGrantStore;
  let storage: WrappedExpiringStorage<string, any>;
  let handler: RememberedConsentHandler;

  beforeEach(() => {
    provider = new Provider('https://id.example/', {
      clients: [], cookies: { keys: ['test-only'] },
      features: { devInteractions: { enabled: false } },
    });
    storage = new WrappedExpiringStorage(new MemoryMapStorage());
    store = new RememberedClientGrantStore(storage);
    const factory = { getProvider: async () => provider } as any;
    handler = new RememberedConsentHandler(factory, new ConsentHandler(factory), store);
  });

  function input(remember: boolean, grantId?: string): any {
    return {
      json: { remember },
      // This is the CSS account, deliberately different from the authenticated WebID.
      accountId: 'css-account-123',
      oidcInteraction: {
        session: { accountId }, params: { client_id: clientId }, grantId,
        prompt: { details: { missingOIDCScope: ['openid', 'webid', 'offline_access'] } },
        persist: vi.fn().mockResolvedValue(undefined), returnTo: 'https://id.example/resume',
      },
    };
  }

  async function consent(remember = true, grantId?: string): Promise<string> {
    const request = input(remember, grantId);
    await expect(handler.handle(request)).rejects.toBeInstanceOf(FoundHttpError);
    return request.oidcInteraction.result.consent.grantId ?? grantId;
  }

  async function policy() {
    const value = interactionPolicy.base();
    const source = new AccountPromptFactory(
      { isLinked: vi.fn().mockResolvedValue(true) } as any,
      { get: vi.fn().mockResolvedValue('css-account-123') } as any,
      'account-cookie',
    );
    await new RememberedClientPromptFactory(source, store).handle(value);
    return value;
  }

  function context(owner = accountId, client = clientId): any {
    const session = new provider.Session({ accountId: owner });
    const oidc: any = {
      provider, session, client: { clientId: client, applicationType: 'native' },
      params: { response_type: 'code' }, result: undefined,
      grant: new provider.Grant({ accountId: owner, clientId: client }),
      requestParamOIDCScopes: new Set(['openid', 'webid']), requestParamClaims: new Set(),
      resourceServers: {}, prompts: new Set(), promptPending: () => true,
      entity: (key: string, value: unknown) => { if (key === 'Grant') oidc.grant = value; },
    };
    return { oidc, cookies: { get: () => 'cookie' } };
  }

  async function restore(value: interactionPolicy.DefaultPolicy, ctx: any) {
    expect(await value.get('restore_remembered_client')!.checks[0].check(ctx)).toBe(false);
  }

  it('persists one record using the authenticated WebID and actual grant expiry', async () => {
    const id = await consent();
    const grant = await store.find(provider, accountId, clientId);
    expect(grant?.jti).toBe(id);
    expect(await store.find(provider, 'css-account-123', clientId)).toBeUndefined();
    const entries = [];
    for await (const [, value] of storage.entries()) entries.push(value);
    expect(entries).toHaveLength(1);
    expect(entries.every((entry) => entry.expires === grant!.exp * 1000)).toBe(true);
    // A new service instance using the same backing storage can recover it.
    expect((await new RememberedClientGrantStore(storage).find(provider, accountId, clientId))?.jti).toBe(id);
  });

  it('requires native consent on first login and restores remembered grant after the session disappears', async () => {
    const value = await policy();
    expect(value.map((prompt) => prompt.name)).toEqual(['account', 'login', 'restore_remembered_client', 'consent']);
    expect(value.get('login')!.checks.get('no_webid_ownserhip')).toBeDefined();
    const first = context();
    await restore(value, first);
    expect(await value.get('consent')!.checks.get('native_client_prompt')!.check(first)).toBe(true);
    const id = await consent();
    const next = context();
    await restore(value, next);
    expect(next.oidc.grant.jti).toBe(id);
    expect(next.oidc.session.grantIdFor(clientId)).toBe(id);
    expect(await value.get('consent')!.checks.get('native_client_prompt')!.check(next)).toBe(false);
    expect(await value.get('consent')!.checks.get('op_scopes_missing')!.check(next)).toBe(false);
  });

  it('never remembers unchecked consent and removes all previous memory when unchecked later', async () => {
    const initial = await consent(false);
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    await consent(true, initial);
    expect(await store.find(provider, accountId, clientId)).toBeDefined();
    await consent(false, initial);
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    const entries = [];
    for await (const entry of storage.entries()) entries.push(entry);
    expect(entries).toEqual([]);
    expect((await provider.Grant.find(initial))!.getRejectedOIDCScope()).toContain('offline_access');
  });

  it.each(['revoked', 'expired', 'other-account', 'wrong-client', 'forgotten'])(
    'does not reuse %s grants', async (scenario) => {
      const id = await consent();
      if (scenario === 'revoked') await (await provider.Grant.find(id))!.destroy();
      if (scenario === 'expired') {
        const grant = (await provider.Grant.find(id))!;
        grant.exp = Math.floor(Date.now() / 1000) - 60;
        await grant.save();
      }
      if (scenario === 'forgotten') await store.forget(accountId, clientId);
      const value = await policy();
      const ctx = context(scenario === 'other-account' ? 'https://pod.example/bob#me' : accountId,
        scenario === 'wrong-client' ? 'https://other.example/client' : clientId);
      await restore(value, ctx);
      expect(ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId)).toBeUndefined();
      expect(await value.get('consent')!.checks.get('native_client_prompt')!.check(ctx)).toBe(true);
    },
  );

  it('retains added scope and claim checks and explicit consent prompts', async () => {
    await consent();
    const value = await policy();
    const ctx = context();
    await restore(value, ctx);
    ctx.oidc.requestParamOIDCScopes.add('email');
    ctx.oidc.requestParamClaims.add('email_verified');
    ctx.oidc.prompts.add('consent');
    expect(await value.get('consent')!.checks.get('op_scopes_missing')!.check(ctx)).toBe(true);
    expect(await value.get('consent')!.checks.get('op_claims_missing')!.check(ctx)).toBe(true);
    expect(await value.get('consent')!.checks.get('consent_prompt')!.check(ctx)).toBe(true);
  });

  it('does not overwrite a grant submitted by the current consent interaction', async () => {
    await consent();
    const value = await policy();
    const ctx = context();
    const current = ctx.oidc.grant;
    ctx.oidc.result = { consent: {} };
    await restore(value, ctx);
    expect(ctx.oidc.grant).toBe(current);
  });

  it('does not remember failed consent persistence or mismatched grant ownership', async () => {
    const request = input(true);
    request.oidcInteraction.persist.mockRejectedValue(new Error('failed persistence'));
    await expect(handler.handle(request)).rejects.toThrow('failed persistence');
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    const wrong = new provider.Grant({ accountId: 'https://other.example/me', clientId });
    const id = await wrong.save();
    await consent(true, id);
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
  });

  it('preserves other clients without accessing remembered storage', async () => {
    const remember = vi.spyOn(store, 'remember');
    const forget = vi.spyOn(store, 'forget');
    const request = input(true);
    request.oidcInteraction.params.client_id = 'https://other.example/client';
    await expect(handler.handle(request)).rejects.toBeInstanceOf(FoundHttpError);
    expect(remember).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it('keeps a later deletion when an earlier remember write returns late', async () => {
    const id = await consent(false);
    const grant = (await provider.Grant.find(id))!;
    let release!: () => void;
    let written!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const mutated = new Promise<void>((resolve) => { written = resolve; });
    const originalSet = storage.set.bind(storage);
    const set = vi.spyOn(storage, 'set').mockImplementationOnce(async (key, entry, expiry) => {
      await originalSet(key, entry, expiry as Date);
      written();
      await pending;
      return storage;
    });
    const remembering = store.remember(grant);
    await mutated;
    await store.forget(accountId, clientId);
    release();
    await remembering;
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('keeps a later remember write when an earlier deletion returns late', async () => {
    const id = await consent();
    const grant = (await provider.Grant.find(id))!;
    let release!: () => void;
    let deleted!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const mutated = new Promise<void>((resolve) => { deleted = resolve; });
    const originalDelete = storage.delete.bind(storage);
    const remove = vi.spyOn(storage, 'delete').mockImplementationOnce(async (key) => {
      const result = await originalDelete(key);
      deleted();
      await pending;
      return result;
    });
    const forgetting = store.forget(accountId, clientId);
    await mutated;
    await store.remember(grant);
    release();
    await forgetting;
    expect((await store.find(provider, accountId, clientId))?.jti).toBe(id);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('rejects a grant whose persisted owner or client no longer matches its record', async () => {
    const id = await consent();
    const grant = (await provider.Grant.find(id))!;
    grant.accountId = 'https://other.example/me';
    await grant.save();
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    grant.accountId = accountId;
    grant.clientId = 'https://other.example/client';
    await grant.save();
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
  });

  it('rejects expired records and never records an expired grant', async () => {
    const id = await consent();
    for await (const [key, entry] of storage.entries()) {
      await storage.set(key, { ...entry, expires: Date.now() - 1 });
    }
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    await store.forget(accountId, clientId);
    const grant = (await provider.Grant.find(id))!;
    grant.exp = Math.floor(Date.now() / 1000) - 1;
    await store.remember(grant);
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
  });
});
