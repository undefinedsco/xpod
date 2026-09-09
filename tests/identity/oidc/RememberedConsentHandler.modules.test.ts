import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Provider from 'oidc-provider';
import {
  ConsentHandler, FoundHttpError, MemoryMapStorage, WrappedExpiringStorage,
} from '@solid/community-server';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';
import { RememberedConsentHandler } from '../../../src/identity/oidc/RememberedConsentHandler';

describe('RememberedConsentHandler across CSS module instances', () => {
  const accountId = 'https://pod.example/alice/profile/card#me';
  const clientId = XPOD_DESKTOP_CLIENT_ID;
  let temporaryRoot: string;
  let ForeignConsent: typeof ConsentHandler;
  let ForeignFound: typeof FoundHttpError;
  let provider: Provider;
  let store: RememberedClientGrantStore;
  let handler: RememberedConsentHandler;

  beforeAll(async () => {
    const directory = path.resolve('.test-data/remembered-consent-modules');
    await mkdir(directory, { recursive: true });
    temporaryRoot = await mkdtemp(path.join(directory, 'css-'));
    const require = createRequire(import.meta.url);
    const cssDist = path.dirname(require.resolve('@solid/community-server'));
    // The actual second CSS ConsentHandler throws its own actual FoundHttpError;
    // copying the module graph preserves the failing instanceof boundary.
    await cp(cssDist, path.join(temporaryRoot, 'dist'), { recursive: true });
    await writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    ForeignConsent = require(path.join(temporaryRoot, 'dist/identity/interaction/oidc/ConsentHandler.js')).ConsentHandler;
    ForeignFound = require(path.join(temporaryRoot, 'dist/util/errors/FoundHttpError.js')).FoundHttpError;
  });

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    provider = new Provider('https://id.example/', {
      clients: [], cookies: { keys: ['test-only'] },
      features: { devInteractions: { enabled: false } },
    });
    store = new RememberedClientGrantStore(new WrappedExpiringStorage(new MemoryMapStorage()));
    const factory = { getProvider: async () => provider } as any;
    handler = new RememberedConsentHandler(factory, new ForeignConsent(factory), store);
  });

  async function input(remember = true, grantId?: string): Promise<any> {
    const interaction = new provider.Interaction();
    Object.assign(interaction, {
      session: { accountId }, params: { client_id: clientId }, grantId,
      prompt: { name: 'consent', reasons: ['native_client_prompt'],
        details: { missingOIDCScope: ['openid', 'webid', 'offline_access'] } },
      returnTo: 'https://id.example/resume',
    });
    await interaction.save(3600);
    return { accountId: 'css-account-123', json: { remember }, oidcInteraction: interaction };
  }

  async function complete(request: any): Promise<string> {
    const previousResult = request.oidcInteraction.result;
    let redirect: unknown;
    try { await handler.handle(request); } catch (error) { redirect = error; }
    expect(redirect).toBeInstanceOf(ForeignFound);
    expect(redirect).not.toBeInstanceOf(FoundHttpError);
    expect(FoundHttpError.isInstance(redirect)).toBe(true);
    expect(request.oidcInteraction.result).not.toBe(previousResult);
    const saved = (await provider.Interaction.find(request.oidcInteraction.jti))!;
    expect(saved.result?.consent).toBeDefined();
    return saved.result!.consent!.grantId ?? request.oidcInteraction.grantId;
  }

  it('records successful persisted consent despite a foreign FoundHttpError constructor', async () => {
    expect(ForeignConsent).not.toBe(ConsentHandler);
    expect(ForeignFound).not.toBe(FoundHttpError);
    const grantId = await complete(await input());
    expect((await provider.Grant.find(grantId))?.accountId).toBe(accountId);
    expect((await store.find(provider, accountId, clientId))?.jti).toBe(grantId);
    expect(await store.find(provider, 'css-account-123', clientId)).toBeUndefined();
  });

  it('removes previous memory when the foreign handler completes unchecked consent', async () => {
    const initial = await complete(await input());
    await store.remember((await provider.Grant.find(initial))!);
    await complete(await input(false, initial));
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
    expect((await provider.Grant.find(initial))!.getRejectedOIDCScope()).toContain('offline_access');
  });

  it('does not remember when actual consent persistence fails', async () => {
    const request = await input();
    vi.spyOn(request.oidcInteraction, 'persist').mockRejectedValue(new Error('consent persistence failed'));
    await expect(handler.handle(request)).rejects.toThrow('consent persistence failed');
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
  });

  it.each(['owner', 'client'])('does not remember a persisted grant with a different %s', async (field) => {
    const grant = new provider.Grant({
      accountId: field === 'owner' ? 'https://other.example/me' : accountId,
      clientId: field === 'client' ? 'https://other.example/client' : clientId,
    });
    const grantId = await grant.save();
    await complete(await input(true, grantId));
    expect(await store.find(provider, accountId, clientId)).toBeUndefined();
  });

  it('does not treat an unchanged previous consent result as newly completed consent', async () => {
    const request = await input();
    request.oidcInteraction.result = { consent: { grantId: 'previous-grant' } };
    const redirect = new ForeignFound('https://id.example/resume');
    const source = { handleSafe: vi.fn().mockRejectedValue(redirect) } as any;
    const factory = { getProvider: vi.fn() } as any;
    const wrapper = new RememberedConsentHandler(factory, source, store);
    await expect(wrapper.handle(request)).rejects.toBe(redirect);
    expect(factory.getProvider).not.toHaveBeenCalled();
  });

  it.each(['other-status', 'missing-location', 'missing-metadata'])('rejects %s errors even with a new consent result', async (scenario) => {
    const request = await input();
    const error = new ForeignFound('https://id.example/resume');
    if (scenario === 'other-status') Object.assign(error, { statusCode: 303 });
    if (scenario === 'missing-location') Reflect.deleteProperty(error, 'location');
    if (scenario === 'missing-metadata') Reflect.deleteProperty(error, 'metadata');
    const source = { handleSafe: vi.fn(async () => {
      request.oidcInteraction.result = { consent: { grantId: 'new-grant' } };
      throw error;
    }) } as any;
    const factory = { getProvider: vi.fn() } as any;
    await expect(new RememberedConsentHandler(factory, source, store).handle(request)).rejects.toBe(error);
    expect(factory.getProvider).not.toHaveBeenCalled();
  });
});
