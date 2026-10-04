import { describe, expect, it, vi } from 'vitest';

import {
  TaskAuthBindingService,
  TaskAuthBindingStatus,
} from '../../../src/api/tasks/TaskAuthBinding';
import type { StoreContext } from '../../../src/api/chatkit/store';
import { OwnerPodAccess, POD_INTERFACE_KEY_REJECTED } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';
import { createTestSolidSessions } from '../../helpers/solidSessions';
import type { TaskCredentialSource } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';

const OWNER = 'https://pod.example/alice/profile/card#me';
const OTHER_OWNER = 'https://pod.example/bob/profile/card#me';
const GRANT_ID = 'taskcred_bound_1';
const LEGACY_BINDING_ID = 'task-auth_legacy_1';

type Context = StoreContext & { userId: string };

function source(overrides: Partial<TaskCredentialSource> = {}): TaskCredentialSource {
  return {
    activeFor: vi.fn(async () => undefined),
    forRef: vi.fn(async () => ({
      credentialRef: GRANT_ID,
      version: 3,
      clientId: 'task-client',
      clientSecret: 'task-secret',
    })),
    ...overrides,
  };
}

/** A repository whose Pod-stored credential would be a different, legacy credential. */
function repository(credential: Record<string, unknown> | undefined) {
  return {
    saveTaskAuthCredential: vi.fn(),
    loadTaskAuthCredential: vi.fn(async () => credential),
  } as never;
}

/** The context an unattended run restores: it names the owner, and may carry no caller auth. */
function restoredContext(webId: string = OWNER): Context {
  return {
    userId: webId,
    auth: { type: 'solid', webId },
  } as Context;
}

const legacyCredential = {
  id: LEGACY_BINDING_ID,
  service: 'task-auth',
  status: 'active',
  apiKey: `sk-${Buffer.from('legacy-client:legacy-secret').toString('base64')}`,
};

describe('TaskAuthBindingService.resolveRunContext', () => {
  it('resolves a binding id that names a task-layer grant without reading the Pod', async () => {
    const taskCredentials = source();
    const store = repository(legacyCredential);
    const service = new TaskAuthBindingService({ repository: store, taskCredentials });

    const resolved = await service.resolveRunContext(GRANT_ID, { userId: OWNER } as Context);

    expect(resolved).toMatchObject({
      userId: OWNER,
      auth: {
        type: 'solid',
        webId: OWNER,
        clientId: 'task-client',
        clientSecret: 'task-secret',
        viaApiKey: true,
      },
    });
    expect(taskCredentials.forRef).toHaveBeenCalledWith({ credentialRef: GRANT_ID, ownerWebId: OWNER });
    expect((store as unknown as { loadTaskAuthCredential: ReturnType<typeof vi.fn> }).loadTaskAuthCredential)
      .not.toHaveBeenCalled();
  });

  it('asks for the grant of the binding owner, not of whoever triggered the run', async () => {
    const taskCredentials = source();
    const service = new TaskAuthBindingService({ repository: repository(undefined), taskCredentials });

    await service.resolveRunContext(GRANT_ID, { userId: OTHER_OWNER } as Context);

    expect(taskCredentials.forRef).toHaveBeenCalledWith({ credentialRef: GRANT_ID, ownerWebId: OTHER_OWNER });
  });

  it('falls back to the stored credential while bindings still name no grant', async () => {
    const taskCredentials = source({ forRef: vi.fn(async () => undefined) });
    const service = new TaskAuthBindingService({ repository: repository(legacyCredential), taskCredentials });

    const resolved = await service.resolveRunContext(LEGACY_BINDING_ID, restoredContext());

    expect(resolved).toMatchObject({ auth: { clientId: 'legacy-client', clientSecret: 'legacy-secret' } });
  });

  it('fails closed when a grant-shaped reference no longer resolves', async () => {
    // The grant exists for this owner but is revoked or expired, so the source refuses it.
    const taskCredentials = source({ forRef: vi.fn(async () => undefined) });
    const load = vi.fn(async () => legacyCredential);
    const service = new TaskAuthBindingService({
      repository: { saveTaskAuthCredential: vi.fn(), loadTaskAuthCredential: load } as never,
      taskCredentials,
    });

    // Falling back to the Pod-stored secret here would resurrect access the user revoked.
    await expect(service.resolveRunContext('taskcred_revoked', restoredContext())).resolves.toBeUndefined();
    expect(taskCredentials.forRef).toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps working with no task layer wired at all', async () => {
    const load = vi.fn(async () => legacyCredential);
    const service = new TaskAuthBindingService({
      repository: { saveTaskAuthCredential: vi.fn(), loadTaskAuthCredential: load } as never,
    });

    const resolved = await service.resolveRunContext(LEGACY_BINDING_ID, restoredContext());

    expect(resolved).toMatchObject({ auth: { clientId: 'legacy-client' } });
    expect(load).toHaveBeenCalledWith(LEGACY_BINDING_ID, restoredContext());
  });

  it('reports an unknown binding rather than inventing access', async () => {
    const service = new TaskAuthBindingService({
      repository: repository(undefined),
      taskCredentials: source({ forRef: vi.fn(async () => undefined) }),
    });

    await expect(service.resolveRunContext('taskcred_missing', { userId: OWNER } as Context))
      .resolves.toBeUndefined();
  });

  it('does not resolve a revoked stored credential', async () => {
    const service = new TaskAuthBindingService({
      repository: repository({ ...legacyCredential, status: 'revoked' }),
    });

    await expect(service.resolveRunContext(LEGACY_BINDING_ID, restoredContext())).resolves.toBeUndefined();
    expect(TaskAuthBindingStatus.REVOKED).toBe('revoked');
  });
});


describe('TaskAuthBindingService credential-bound context', () => {
  it('preserves the exact grant and drops the previous caller transport and database caches', async () => {
    const service = new TaskAuthBindingService({ repository: repository(undefined), taskCredentials: source() });
    const previous = { ...restoredContext(), _cachedDb: {}, _cachedDbPromise: Promise.resolve({}),
      _cachedFetch: vi.fn(), _cachedAuth: {}, _cachedWebId: OWNER, _cachedPodBaseUrl: 'https://pod.example/alice/',
      _threadSurfaceIdCache: new Map(), _threadMetadataCache: new Map(), podBaseUrl: 'https://pod.example/alice/' };
    const resolved = await service.resolveRunContext(GRANT_ID, previous);
    expect(resolved?.taskCredential).toEqual({ credentialRef: GRANT_ID, version: 3 });
    for (const key of ['_cachedDb', '_cachedDbPromise', '_cachedFetch', '_cachedAuth', '_cachedWebId',
      '_threadSurfaceIdCache', '_threadMetadataCache']) {
      expect(resolved).not.toHaveProperty(key);
      expect(previous).toHaveProperty(key);
    }
    expect(resolved?.podBaseUrl).toBe(previous.podBaseUrl);
  });
});


describe('Task binding to retained Pod fetch', () => {
  it('renews the frozen grant after clearing caller caches and rejects revocation before dispatch', async () => {
    let now = 1_000_000;
    let revoked = false;
    let tokenCount = 0;
    const wireAuthorizations: string[] = [];
    const credential = { credentialRef: GRANT_ID, version: 3, clientId: 'task-client', clientSecret: 'task-secret' };
    const taskCredentials = source({ forRef: vi.fn(async () => revoked ? undefined : credential) });
    const wire: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/.oidc/token')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('task-client:task-secret').toString('base64')}`);
        return Response.json({ access_token: `task-token-${++tokenCount}`, token_type: 'DPoP', expires_in: 60, webid: OWNER });
      }
      wireAuthorizations.push(new Headers(init?.headers).get('authorization')!);
      return new Response('private task payload');
    };
    const binding = new TaskAuthBindingService({ repository: repository(legacyCredential), taskCredentials });
    const previous = { ...restoredContext(), _cachedFetch: vi.fn(), _cachedDb: {}, _cachedAuth: {} };
    const context = await binding.resolveRunContext(GRANT_ID, previous);
    expect(context).not.toHaveProperty('_cachedFetch');
    expect(context).not.toHaveProperty('_cachedDb');
    const access = new OwnerPodAccess({ taskCredentials, fetch: wire,
      sessions: createTestSolidSessions({ tokenEndpoint: 'https://pod.example/.oidc/token', fetch: wire, now: () => now }),
    });
    const held = (await access.getPodFetch(OWNER, context))!;
    expect(await (await held('https://pod.example/alice/private')).text()).toBe('private task payload');
    now += 45_000;
    expect(await (await held('https://pod.example/alice/private')).text()).toBe('private task payload');
    expect(tokenCount).toBe(2);
    expect(wireAuthorizations).toEqual(['DPoP task-token-1', 'DPoP task-token-2']);
    revoked = true;
    await expect(held('https://pod.example/alice/private', { method: 'POST', body: 'must not dispatch' })).rejects.toThrow(POD_INTERFACE_KEY_REJECTED);
    expect(tokenCount).toBe(2);
    expect(wireAuthorizations).toHaveLength(2);
    expect(previous._cachedFetch).not.toHaveBeenCalled();
    expect(taskCredentials.forRef).toHaveBeenCalledWith({ credentialRef: GRANT_ID, ownerWebId: OWNER, version: 3 });
  });
});
