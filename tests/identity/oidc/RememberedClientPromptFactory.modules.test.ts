import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Provider, { interactionPolicy } from 'oidc-provider';
import { MemoryMapStorage, WrappedExpiringStorage } from '@solid/community-server';
import { RememberedClientGrantStore, XPOD_DESKTOP_CLIENT_ID } from '../../../src/identity/oidc/RememberedClientGrantStore';
import { RememberedClientPromptFactory } from '../../../src/identity/oidc/RememberedClientPromptFactory';

describe('RememberedClientPromptFactory across provider module instances', () => {
  let temporaryRoot: string;
  let foreign: typeof interactionPolicy;

  beforeAll(async () => {
    const directory = path.resolve('.test-data/remembered-client-prompt-modules');
    await mkdir(directory, { recursive: true });
    temporaryRoot = await mkdtemp(path.join(directory, 'provider-'));
    const providerLib = path.dirname(createRequire(import.meta.url).resolve('oidc-provider'));
    // A second on-disk module graph reproduces bundled/external constructor
    // identity differences without mocking the provider's instanceof checks.
    await cp(providerLib, path.join(temporaryRoot, 'lib'), { recursive: true });
    await writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    foreign = await import(pathToFileURL(path.join(temporaryRoot, 'lib/helpers/interaction_policy/index.js')).href);
  });

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('uses the incoming policy constructors and preserves login and consent checks', async () => {
    expect(foreign.Prompt).not.toBe(interactionPolicy.Prompt);
    expect(foreign.Check).not.toBe(interactionPolicy.Check);
    const policy = foreign.base();
    const accountCheck = vi.fn(() => false);
    const ownershipCheck = vi.fn(() => false);
    const source = { handleSafe: vi.fn(async () => {
      policy.add(new foreign.Prompt({ name: 'account' },
        new foreign.Check('no_account', 'Account required.', accountCheck)), 0);
      policy.get('login')!.checks.add(new foreign.Check('no_webid_ownserhip', 'Owned WebID required.', ownershipCheck));
    }) };
    const provider = new Provider('https://id.example/', {
      clients: [], cookies: { keys: ['test-only'] },
      features: { devInteractions: { enabled: false } },
    });
    const store = new RememberedClientGrantStore(new WrappedExpiringStorage(new MemoryMapStorage()));
    await new RememberedClientPromptFactory(source as any, store).handle(policy);
    expect(source.handleSafe).toHaveBeenCalledWith(policy);
    expect(policy.map((prompt) => prompt.name)).toEqual(['account', 'login', 'restore_remembered_client', 'consent']);
    const restore = policy.get('restore_remembered_client')!;
    expect(restore).toBeInstanceOf(foreign.Prompt);
    expect(restore.checks[0]).toBeInstanceOf(foreign.Check);
    expect(policy.get('account')!.checks.get('no_account')!.check).toBe(accountCheck);
    expect(policy.get('login')!.checks.get('no_webid_ownserhip')!.check).toBe(ownershipCheck);

    const accountId = 'https://pod.example/alice/profile/card#me';
    const clientId = XPOD_DESKTOP_CLIENT_ID;
    const session = new provider.Session();
    session.accountId = accountId;
    const oidc: any = {
      provider, session, client: { clientId, applicationType: 'native' },
      params: { response_type: 'code' }, result: undefined,
      requestParamOIDCScopes: new Set(['openid', 'webid']), requestParamClaims: new Set(),
      prompts: new Set(), promptPending: () => true,
      entity: (key: string, value: unknown) => { if (key === 'Grant') oidc.grant = value; },
    };
    const ctx = { oidc };
    const native = policy.get('consent')!.checks.get('native_client_prompt')!;
    expect(await restore.checks[0].check(ctx as any)).toBe(false);
    expect(await native.check(ctx as any)).toBe(true);
    const grant = new provider.Grant({ accountId, clientId });
    grant.addOIDCScope('openid webid');
    const grantId = await grant.save();
    await store.remember((await provider.Grant.find(grantId))!);
    expect(await restore.checks[0].check(ctx as any)).toBe(false);
    expect(session.grantIdFor(clientId)).toBe(grantId);
    expect(await native.check(ctx as any)).toBe(false);
    oidc.requestParamOIDCScopes.add('email');
    oidc.prompts.add('consent');
    expect(await policy.get('consent')!.checks.get('op_scopes_missing')!.check(ctx as any)).toBe(true);
    expect(await policy.get('consent')!.checks.get('consent_prompt')!.check(ctx as any)).toBe(true);
  });
});
