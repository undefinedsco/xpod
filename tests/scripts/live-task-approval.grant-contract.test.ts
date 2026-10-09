import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { registerTaskCredentialRoutes } from '../../src/api/handlers/TaskCredentialHandler';
import { getTaskCredentialDatabase, resetTaskCredentialDatabases } from '../../src/api/tasks/TaskCredentialDatabase';
import { TaskCredentialStore } from '../../src/api/tasks/TaskCredentialStore';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../src/security/secret-cell';
import { acceptLiveTaskApproval, summarizeLiveTaskFailure } from '../../scripts/helpers/live-task-approval';

vi.mock('@undefineds.co/drizzle-solid', () => ({ drizzle: () => ({}) }));

// Real handler + encrypted credential database DTO. Only the unrelated workspace write is stopped.
afterEach(() => { vi.useRealTimers(); });

describe('live Task acceptance matches the TaskCredentialHandler wire contract', () => {
  it('records the real pre-case HTTP failure for the desktop public projection', async () => {
    const observed = vi.fn();
    const result = await acceptLiveTaskApproval({ gateway: 'https://gateway.example/',
      podUrl: 'https://pod.example/alice/', webId: 'https://id.example/alice/card#me',
      ownerInterfaceKey: 'synthetic-private-key',
      ownerFetch: async () => new Response(JSON.stringify({ error: 'Authentication required', private: 'private-body' }), { status: 401 }),
      session: { info: { isLoggedIn: true }, fetch } as SolidAuthSession, onEvidence: observed });
    expect(result.ok).toBe(false);
    expect(result.cases).toEqual([]);
    expect(observed).toHaveBeenCalled();
    expect(summarizeLiveTaskFailure(result)).toEqual({ phase: 'grant', category: 'assertion', httpStatus: 401,
      taskError: 'authentication_required', completedCases: 0, cleanupOk: true });
    expect(JSON.stringify(summarizeLiveTaskFailure(result))).not.toMatch(/synthetic-private-key|private-body/u);
  });

  it.each(['normal', 'malformed', 'late-commit', 'unobserved'] as const)('closes the real grant lifecycle after %s outcome', async outcome => {
    const malformed = outcome === 'malformed';
    const late = outcome === 'late-commit';
    const unobserved = outcome === 'unobserved';
    let releaseCommit!: () => void;
    const commitBarrier = new Promise<void>(resolve => { releaseCommit = resolve; });
    let recoveryStarted!: () => void;
    const recovering = new Promise<void>(resolve => { recoveryStarted = resolve; });
    let serverPost: Promise<void> | undefined;
    let postAttempted = false;
    let firstRecoveryWasEmpty = false;
    const parent = path.join(process.cwd(), '.test-data', 'live-task-grant-contract');
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, 'case-'));
    const owner = 'https://pod.example/alice/profile/card#me';
    const store = new TaskCredentialStore({ database: getTaskCredentialDatabase(`sqlite:${path.join(directory, 'grant.sqlite')}`),
      vault: new SecretCellVault({ rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 7) } }) }),
    });
    const routes: Record<string, (request: any, response: any, params: any) => Promise<void>> = {};
    registerTaskCredentialRoutes({
      get: (url: string, handler: any) => { routes[`GET ${url}`] = handler; },
      post: (url: string, handler: any) => { routes[`POST ${url}`] = handler; },
      delete: (url: string, handler: any) => { routes[`DELETE ${url}`] = handler; },
    } as any, { taskCredentials: store, clientCredentialIssuer: 'https://pod.example/',
      validateClientCredential: async () => {
        if (late) await commitBarrier;
        return { success: true, context: { type: 'solid', webId: owner, clientId: 'client', clientSecret: 'secret' } } as any;
      },
    });
    const ownerFetch: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      const ref = pathname.startsWith('/api/ai/task-credentials/') ? decodeURIComponent(pathname.split('/').slice(-1)[0]) : undefined;
      const response = { statusCode: 0, body: '', setHeader() {}, end(body: string) { this.body = body; } };
      const request = { auth: { type: 'solid', webId: owner },
        async *[Symbol.asyncIterator]() { yield Buffer.from(String(init?.body ?? '')); },
      };
      const route = `${method} ${ref ? '/api/ai/task-credentials/:credentialRef' : pathname}`;
      expect(routes[route], route).toBeDefined();
      if (method === 'POST') {
        postAttempted = true;
        if (late) serverPost = routes[route](request, response, {});
        if (late || unobserved) throw new Error('simulated client timeout; server outcome unknown');
      }
      await routes[route](request, response, ref ? { credentialRef: ref } : {});
      if (method === 'GET' && postAttempted && !ref) {
        recoveryStarted();
        if (late && !firstRecoveryWasEmpty) {
          expect(JSON.parse(response.body).data).toEqual([]);
          firstRecoveryWasEmpty = true;
          releaseCommit();
        }
      }
      return new Response(malformed && method === 'POST' ? '{"credential":{}}' : response.body, { status: response.statusCode });
    };
    try {
      if (unobserved) vi.useFakeTimers();
      const pending = acceptLiveTaskApproval({ gateway: 'https://gateway.example/', podUrl: 'https://pod.example/alice/', webId: owner,
        ownerInterfaceKey: `sk-${Buffer.from('client:secret').toString('base64')}`, ownerFetch,
        session: { info: { isLoggedIn: true }, fetch: async () => new Response('', { status: 503 }) } as SolidAuthSession,
        onEvidence: () => undefined,
      });
      if (unobserved) { await recovering; await vi.advanceTimersByTimeAsync(21_000); }
      const result = await pending;
      await serverPost;
      expect(result.ok).toBe(false);
      expect(result.cleanup.grantRevoked).toBe(!unobserved);
      expect(result.cleanup.ok).toBe(!unobserved);
      if (late) expect(firstRecoveryWasEmpty).toBe(true);
      const grants = await store.listForOwner(owner);
      if (unobserved) expect(grants).toEqual([]);
      else expect(grants).toMatchObject([{ credentialRef: expect.stringMatching(/^taskcred_/), status: 'revoked' }]);
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      releaseCommit();
      await serverPost;
      vi.useRealTimers();
      resetTaskCredentialDatabases();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
