import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OwnerPodAccess,
  POD_INTERFACE_KEY_MISSING,
  POD_INTERFACE_KEY_REJECTED,
  podAccessError,
} from '../../../src/api/ai-gateway/pod/OwnerPodAccess';
import type {
  PodInterfaceCredential,
  PodInterfaceKeyAccess,
  PodInterfaceKeyGrant,
} from '../../../src/api/ai-gateway/pod/PodInterfaceKeyStore';
import type { SolidAuthContext } from '../../../src/api/auth/AuthContext';
import { createTestSolidSessions } from '../../helpers/solidSessions';
import type { TaskCredentialSource } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';

const OWNER = 'https://pod.example/alice/profile/card#me';
const OTHER_OWNER = 'https://pod.example/bob/profile/card#me';
const TOKEN_ENDPOINT = 'https://pod.example/.oidc/token';
const POD_RESOURCE = 'https://pod.example/alice/settings/providers/';
const CALLER_KEY: PodInterfaceCredential = { clientId: 'caller-client', clientSecret: 'caller-secret' };
const STORED_KEY: PodInterfaceCredential = { clientId: 'stored-client', clientSecret: 'stored-secret' };

interface TokenRequest {
  url: string;
  authorization: string | null;
  dpop: string | null;
  headers: Headers;
  body: string;
}

interface PodRequest {
  url: string;
  authorization: string | null;
  dpop: string | null;
  headers: Headers;
}

function dpopPayload(proof: string): { htu: string; htm: string } {
  const encoded = proof.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { htu: string; htm: string };
}

class FakeKeyStore implements PodInterfaceKeyAccess {
  public readonly saved: { owner: string; credential: PodInterfaceCredential }[] = [];
  public readonly forgotten: string[] = [];

  public constructor(public stored: PodInterfaceCredential | undefined) {}

  public async read(): Promise<PodInterfaceCredential | undefined> {
    return this.stored;
  }

  public async saveKey(owner: string, credential: PodInterfaceCredential): Promise<void> {
    this.saved.push({ owner, credential });
    this.stored = credential;
  }

  public async forgetKey(owner: string): Promise<void> {
    this.forgotten.push(owner);
    this.stored = undefined;
  }

  public async hasKey(): Promise<boolean> {
    return this.stored !== undefined;
  }
}

/** A real fetch reports the URL it ended up at; DPoP replay logic depends on it. */
function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

function createHarness(options: {
  stored?: PodInterfaceCredential;
  tokenResponse?: () => Response;
  podResponse?: () => Response;
  route?: { canonicalBaseUrl: string; localBaseUrl: string };
  taskCredentials?: TaskCredentialSource;
} = {}) {
  const tokenRequests: TokenRequest[] = [];
  const podRequests: PodRequest[] = [];
  const tokenResponse = options.tokenResponse ?? (() => Response.json({
    access_token: 'access-token-1',
    token_type: 'DPoP',
    expires_in: 300,
  }));
  const podResponse = options.podResponse ?? (() => new Response('ok', { status: 200 }));
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url === TOKEN_ENDPOINT) {
      tokenRequests.push({
        url,
        authorization: headers.get('authorization'),
        dpop: headers.get('dpop'),
        headers,
        body: String(init?.body ?? ''),
      });
      return withUrl(tokenResponse(), url);
    }
    podRequests.push({
      url,
      authorization: headers.get('authorization'),
      dpop: headers.get('dpop'),
      headers,
    });
    return withUrl(podResponse(), url);
  }) as unknown as typeof fetch;

  const keys = new FakeKeyStore(options.stored);
  const access = new OwnerPodAccess({
    keys,
    ...(options.taskCredentials ? { taskCredentials: options.taskCredentials } : {}),
    sessions: createTestSolidSessions({
      tokenEndpoint: TOKEN_ENDPOINT,
      publicBaseUrl: 'https://pod.example',
      fetch: fetchImpl,
    }),
    ...(options.route ? { route: options.route } : {}),
    fetch: fetchImpl,
  });
  return { access, keys, fetchImpl, tokenRequests, podRequests };
}

function callerAuth(overrides: Partial<SolidAuthContext> = {}): SolidAuthContext {
  return {
    type: 'solid',
    webId: OWNER,
    viaApiKey: true,
    clientId: CALLER_KEY.clientId,
    clientSecret: CALLER_KEY.clientSecret,
    ...overrides,
  };
}

describe('OwnerPodAccess', () => {
  const savedEnv = { CSS_BASE_URL: process.env.CSS_BASE_URL, XPOD_MAIN_PORT: process.env.XPOD_MAIN_PORT };

  beforeEach(() => {
    // The local route only applies when a canonical URL and gateway port are configured; these
    // tests address the Pod directly and must not pick up an ambient route.
    delete process.env.CSS_BASE_URL;
    delete process.env.XPOD_MAIN_PORT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('exchanges the caller\'s own interface key and sends a DPoP-bound request to the Pod', async () => {
    const { access, tokenRequests, podRequests } = createHarness();

    const podFetch = await access.getPodFetch(OWNER, { auth: callerAuth() });
    expect(podFetch).toBeTypeOf('function');
    const response = await podFetch!(POD_RESOURCE);

    expect(response.status).toBe(200);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].url).toBe(TOKEN_ENDPOINT);
    expect(tokenRequests[0].authorization).toBe(
      `Basic ${Buffer.from('caller-client:caller-secret', 'utf8').toString('base64')}`,
    );
    expect(tokenRequests[0].body).toContain('grant_type=client_credentials');
    expect(dpopPayload(tokenRequests[0].dpop!).htu).toBe(TOKEN_ENDPOINT);
    expect(dpopPayload(tokenRequests[0].dpop!).htm).toBe('POST');

    expect(podRequests).toHaveLength(1);
    expect(podRequests[0].url).toBe(POD_RESOURCE);
    expect(podRequests[0].authorization).toBe('DPoP access-token-1');
    const proof = dpopPayload(podRequests[0].dpop!);
    // The proof stays bound to the URL the caller named, not to whatever transport carried it.
    expect(proof.htu).toBe(POD_RESOURCE);
    expect(proof.htm).toBe('GET');
  });

  it('reuses the exchanged token instead of asking for a new one per request', async () => {
    const { access, tokenRequests } = createHarness();

    const podFetch = await access.getPodFetch(OWNER, { auth: callerAuth() });
    await podFetch!(POD_RESOURCE);
    await podFetch!(`${POD_RESOURCE}?query=SELECT`);
    await access.getPodFetch(OWNER, { auth: callerAuth() });

    expect(tokenRequests).toHaveLength(1);
  });

  it('uses the key the owner granted when the caller brought none', async () => {
    const { access, tokenRequests, podRequests } = createHarness({ stored: STORED_KEY });

    const podFetch = await access.getPodFetch(OWNER);
    expect(podFetch).toBeTypeOf('function');
    await podFetch!(POD_RESOURCE);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].authorization).toBe(
      `Basic ${Buffer.from('stored-client:stored-secret', 'utf8').toString('base64')}`,
    );
    expect(podRequests[0].authorization).toBe('DPoP access-token-1');
  });

  it('reports a missing key instead of inventing access when nothing is on file', async () => {
    const { access, fetchImpl } = createHarness();

    await expect(access.getPodFetch(OWNER)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    // A browser session explains why its own proof was not enough; a bearer session simply has
    // no Pod credential. Both are fixed by granting the interface key.
    expect(podAccessError(OWNER, callerAuth({ viaApiKey: false, tokenType: 'DPoP', dpopProof: 'proof' })))
      .toBe('caller_dpop_replay_unsupported');
    expect(podAccessError(OWNER, callerAuth({ viaApiKey: false, tokenType: 'Bearer', accessToken: 't' })))
      .toBe(POD_INTERFACE_KEY_MISSING);
  });

  it('never borrows another owner\'s key for a mismatched caller', async () => {
    const { access, tokenRequests } = createHarness({ stored: STORED_KEY });

    await expect(access.getPodFetch(OWNER, { auth: callerAuth({ webId: OTHER_OWNER }) }))
      .resolves.toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
    expect(podAccessError(OWNER, callerAuth({ webId: OTHER_OWNER }))).toBe('caller_owner_mismatch');
    expect(podAccessError(OWNER, undefined)).toBe('caller_pod_access_unavailable');
  });

  it('fails loudly when the Pod refuses the key', async () => {
    const { access } = createHarness({
      stored: STORED_KEY,
      tokenResponse: () => new Response('invalid_client', { status: 401 }),
    });

    await expect(access.getPodFetch(OWNER)).rejects.toThrow(`${POD_INTERFACE_KEY_REJECTED}:401`);
  });

  it('does not make a DPoP proof for a credential the Pod answers with a Bearer token', async () => {
    const { access, podRequests } = createHarness({
      stored: STORED_KEY,
      tokenResponse: () => Response.json({ access_token: 'bearer-token', token_type: 'Bearer', expires_in: 300 }),
    });

    const podFetch = await access.getPodFetch(OWNER);
    await podFetch!(POD_RESOURCE);

    expect(podRequests[0].authorization).toBe('Bearer bearer-token');
    expect(podRequests[0].dpop).toBeNull();
  });

  it('re-exchanges the key after the Pod stops accepting the token', async () => {
    let tokenCount = 0;
    const { access, tokenRequests } = createHarness({
      stored: STORED_KEY,
      tokenResponse: () => {
        tokenCount += 1;
        return Response.json({ access_token: `access-token-${tokenCount}`, token_type: 'DPoP', expires_in: 300 });
      },
      podResponse: () => new Response('expired', { status: 401 }),
    });

    const podFetch = await access.getPodFetch(OWNER);
    expect((await podFetch!(POD_RESOURCE)).status).toBe(401);
    const nextFetch = await access.getPodFetch(OWNER);
    expect((await nextFetch!(POD_RESOURCE)).status).toBe(401);

    expect(tokenRequests).toHaveLength(2);
  });

  it('forwards a caller credential that is already reusable as a bearer token', async () => {
    const { access, tokenRequests, podRequests } = createHarness();

    const podFetch = await access.getPodFetch(OWNER, {
      auth: callerAuth({
        clientId: undefined,
        clientSecret: undefined,
        accessToken: 'session-token',
        tokenType: 'Bearer',
      }),
    });
    expect(podFetch).toBeTypeOf('function');
    await podFetch!(POD_RESOURCE);

    expect(tokenRequests).toHaveLength(0);
    expect(podRequests[0].authorization).toBe('Bearer session-token');
  });

  it('drops cached access when a new key is granted or withdrawn', async () => {
    const { access, keys, tokenRequests } = createHarness({ stored: STORED_KEY });
    await access.getPodFetch(OWNER);
    expect(tokenRequests).toHaveLength(1);

    await access.saveKey(OWNER, CALLER_KEY);
    expect(keys.saved).toEqual([{ owner: OWNER, credential: CALLER_KEY }]);
    await access.getPodFetch(OWNER);
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[1].authorization).toBe(
      `Basic ${Buffer.from('caller-client:caller-secret', 'utf8').toString('base64')}`,
    );

    await access.hasKey(OWNER);
    expect(await access.hasKey(OWNER)).toBe(true);
    await access.forgetKey(OWNER);
    expect(keys.forgotten).toEqual([OWNER]);
    await expect(access.getPodFetch(OWNER)).resolves.toBeUndefined();
  });
});

describe('OwnerPodAccess task credentials', () => {
  const TASK_KEY: PodInterfaceCredential = { clientId: 'task-client', clientSecret: 'task-secret' };

  it('uses the owner\'s task-layer grant for background work', async () => {
    const { access, tokenRequests, podRequests } = createHarness({
      taskCredentials: {
        activeFor: async () => ({ ...TASK_KEY, credentialRef: 'taskcred_1', version: 3 }),
        forRef: async () => undefined,
      },
    });

    const podFetch = await access.getPodFetch(OWNER, { taskCredential: { ownerGrant: true } });
    expect(podFetch).toBeTypeOf('function');
    await podFetch!(POD_RESOURCE);

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].authorization).toBe(
      `Basic ${Buffer.from('task-client:task-secret', 'utf8').toString('base64')}`,
    );
    expect(podRequests[0].authorization).toBe('DPoP access-token-1');
  });

  it('never falls back to the stored key when the task grant is unusable', async () => {
    const { access, tokenRequests, fetchImpl } = createHarness({
      stored: STORED_KEY,
      taskCredentials: { activeFor: async () => undefined, forRef: async () => undefined },
    });

    await expect(access.getPodFetch(OWNER, { taskCredential: { ownerGrant: true } })).resolves.toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a named grant at its frozen version', async () => {
    const seen: Array<{ credentialRef: string; ownerWebId: string; version?: number }> = [];
    const { access, tokenRequests } = createHarness({
      taskCredentials: {
        activeFor: async () => undefined,
        forRef: async (input) => {
          seen.push(input);
          return input.version === 4 ? { ...TASK_KEY, credentialRef: input.credentialRef, version: 4 } : undefined;
        },
      },
    });

    await expect(access.getPodFetch(OWNER, {
      taskCredential: { credentialRef: 'taskcred_9', version: 4 },
    })).resolves.toBeTypeOf('function');
    await expect(access.getPodFetch(OWNER, {
      taskCredential: { credentialRef: 'taskcred_9', version: 2 },
    })).resolves.toBeUndefined();

    expect(seen).toEqual([
      { credentialRef: 'taskcred_9', ownerWebId: OWNER, version: 4 },
      { credentialRef: 'taskcred_9', ownerWebId: OWNER, version: 2 },
    ]);
    expect(tokenRequests).toHaveLength(1);
  });

  it('cannot use a task credential for another owner', async () => {
    const { access, tokenRequests } = createHarness({
      taskCredentials: {
        activeFor: async () => ({ ...TASK_KEY, credentialRef: 'taskcred_1', version: 1 }),
        forRef: async () => ({ ...TASK_KEY, credentialRef: 'taskcred_1', version: 1 }),
      },
    });

    await expect(access.getPodFetch(OWNER, { auth: callerAuth({ webId: OTHER_OWNER }), taskCredential: { ownerGrant: true } }))
      .resolves.toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
  });

  it('reports no task credential when the deployment wired none', async () => {
    const { access, tokenRequests } = createHarness({ stored: STORED_KEY });

    await expect(access.getPodFetch(OWNER, { taskCredential: { ownerGrant: true } })).resolves.toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
  });
});
