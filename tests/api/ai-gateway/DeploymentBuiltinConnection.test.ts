import { describe, expect, it, vi } from 'vitest';

import { AiGatewayService, type GatewayCredentialStore } from '../../../src/api/ai-gateway/AiGatewayService';
import {
  DeploymentBuiltinConnection,
  resolveDeploymentBuiltinConfig,
} from '../../../src/api/ai-gateway/builtin/DeploymentBuiltinConnection';
import type { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import type { ModelRouter } from '../../../src/api/ai-gateway/routing/ModelRouter';
import type { AuthContext } from '../../../src/api/auth/AuthContext';

vi.mock('../../../src/api/ai-gateway/providers/ProviderRegistry', () => ({
  normalizeProviderId: (id: string) => id,
}));

const WEB_ID = 'https://id.example/fresh/profile/card#me';
const DPOP_AUTH: AuthContext = {
  type: 'solid',
  webId: WEB_ID,
  accessToken: 'dpop-token',
  tokenType: 'DPoP',
  dpopProof: 'proof',
};
const KEY = 'sk-deployment-secret';
const builtinId = 'xpod-builtin';

function builtin(fetchImpl: typeof fetch, modelMap: Record<string, string> = {}): DeploymentBuiltinConnection {
  return new DeploymentBuiltinConnection(
    { apiBase: 'http://ai-gateway/v1', apiKey: KEY, modelMap },
    { fetch: fetchImpl },
  );
}

function service(connection: DeploymentBuiltinConnection | undefined, router: Partial<ModelRouter>): AiGatewayService {
  const registry = {} as never;
  return new AiGatewayService({
    deployment: 'cloud',
    registry,
    router: router as ModelRouter,
    credentials: { listCredentials: vi.fn(async () => []) } as GatewayCredentialStore,
    vault: { seal: vi.fn(), rewrap: vi.fn(), open: vi.fn() },
    runtimes: { get: vi.fn() } as unknown as ProviderRuntimeRegistry,
    builtin: connection,
  });
}

const podDenied = {
  listVisibleModels: vi.fn(async () => { throw new Error('caller_dpop_replay_unsupported'); }),
  route: vi.fn(async () => { throw new Error('router must not be used for built-in models'); }),
};

describe('DeploymentBuiltinConnection', () => {
  it('is enabled only on cloud with both DEFAULT_API_BASE and DEFAULT_API_KEY', () => {
    const env = { DEFAULT_API_BASE: 'http://ai-gateway/v1', DEFAULT_API_KEY: KEY } as NodeJS.ProcessEnv;
    expect(resolveDeploymentBuiltinConfig('cloud', env)).toMatchObject({ apiBase: 'http://ai-gateway/v1' });
    expect(resolveDeploymentBuiltinConfig('local', env)).toBeUndefined();
    expect(resolveDeploymentBuiltinConfig('cloud', { DEFAULT_API_BASE: 'x' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveDeploymentBuiltinConfig('cloud', {
      ...env, DEFAULT_API_MODEL_MAP: '{"linx":"platform-linx","other":"x"}',
    } as NodeJS.ProcessEnv)?.modelMap).toEqual({ linx: 'platform-linx' });
  });

  it('lists linx and linx-lite for a DPoP session without Pod access', async () => {
    const models = await service(builtin(vi.fn() as never), podDenied).listModels(DPOP_AUTH);
    expect(models.map((model) => model.id)).toEqual(['linx', 'linx-lite']);
  });

  it('still surfaces Pod failures when no built-in is configured', async () => {
    await expect(service(undefined, podDenied).listModels(DPOP_AUTH)).rejects.toThrow('caller_dpop_replay_unsupported');
  });

  it('serves built-ins when the Pod is unreachable without guessing success', async () => {
    const router = {
      listVisibleModels: vi.fn(async () => { throw new TypeError('fetch failed https://pod.example/alice/?token=secret'); }),
    };
    const models = await service(builtin(vi.fn() as never), router).listModels(DPOP_AUTH);
    expect(models.map((model) => model.id)).toEqual(['linx', 'linx-lite']);
  });

  it('merges Pod-backed models after the built-ins', async () => {
    const router = {
      listVisibleModels: vi.fn(async () => [
        { id: 'deepseek-chat', object: 'model' as const, owned_by: 'deepseek' },
        { id: 'linx', object: 'model' as const, owned_by: 'deepseek' },
      ]),
    };
    const models = await service(builtin(vi.fn() as never), router).listModels(DPOP_AUTH);
    expect(models.map((model) => `${model.id}:${model.owned_by}`)).toEqual([
      'linx:xpod-builtin', 'linx-lite:xpod-builtin', 'deepseek-chat:deepseek',
    ]);
  });

  it('completes linx with the deployment key and WebID attribution, without Pod access', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'platform-linx', user: WEB_ID, stream: false });
      return Response.json({ id: 'c1', object: 'chat.completion', model: 'platform-linx', choices: [] });
    });
    const result = await service(builtin(fetchImpl as never, { linx: 'platform-linx' }), podDenied).complete({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'linx', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(result.id).toBe('c1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://ai-gateway/v1/chat/completions');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(podDenied.route).not.toHaveBeenCalled();
  });

  it('serves the responses protocol through the same deployment-owned route', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'linx', user: WEB_ID, stream: false });
      return Response.json({ id: 'resp_1', object: 'response', output: [] });
    });
    const result = await service(builtin(fetchImpl as never), podDenied).complete({
      auth: DPOP_AUTH,
      protocol: 'responses',
      body: { model: 'linx', input: 'hi' },
    });
    expect(result.id).toBe('resp_1');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://ai-gateway/v1/responses');
    expect(podDenied.route).not.toHaveBeenCalled();
  });

  /**
   * The provider pool advertises this built-in as `xpod-builtin`, so a client
   * that follows the provider/model reference it was given sends the QUALIFIED
   * form. That is the same model, and it must reach the deployment connection
   * instead of falling through to the Pod router (which answers
   * `service_access_missing` when no Pod key exists).
   */
  it('routes the OWN qualified namespace for both models on Chat without consulting the Pod router', async () => {
    for (const [qualified, bare] of [['xpod-builtin/linx', 'linx'], ['xpod-builtin/linx-lite', 'linx-lite']] as const) {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        // The upstream must receive the BARE configured physical model, never
        // the qualified namespace the caller used.
        expect(body).toMatchObject({ model: bare, user: WEB_ID, stream: false });
        expect(String(body.model)).not.toContain('xpod-builtin/');
        return Response.json({ id: 'c1', object: 'chat.completion', model: bare, choices: [] });
      });
      const pod = podDenied;
      const result = await service(builtin(fetchImpl as never), pod).complete({
        auth: DPOP_AUTH,
        protocol: 'chatCompletions',
        body: { model: qualified, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(result.id).toBe('c1');
      expect(String(fetchImpl.mock.calls[0][0])).toBe('http://ai-gateway/v1/chat/completions');
      // The Pod resolver would throw service_access_missing; it must not be asked.
      expect(pod.route).not.toHaveBeenCalled();
    }
  });

  it('applies the deployment model map to the qualified reference on Chat and Responses', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Qualified input -> bare canonical -> configured physical upstream id.
      expect(body.model).toBe('platform-linx');
      expect(JSON.stringify(body)).not.toContain('xpod-builtin/');
      return Response.json({ id: 'c1', object: 'chat.completion', choices: [] });
    });
    const svc = service(builtin(fetchImpl as never, { linx: 'platform-linx' }), podDenied);
    await svc.complete({ auth: DPOP_AUTH, protocol: 'chatCompletions',
      body: { model: 'xpod-builtin/linx', messages: [{ role: 'user', content: 'hi' }] } });
    await svc.complete({ auth: DPOP_AUTH, protocol: 'responses',
      body: { model: 'xpod-builtin/linx', input: 'hi' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toBe('http://ai-gateway/v1/responses');
    expect(podDenied.route).not.toHaveBeenCalled();
  });

  it('keeps the bare ids working and never claims another provider or an unknown model', async () => {
    const conn = builtin(vi.fn() as never);
    expect(conn.canonicalModel('linx')).toBe('linx');
    expect(conn.canonicalModel('linx-lite')).toBe('linx-lite');
    expect(conn.canonicalModel(' xpod-builtin/linx '.trim())).toBe('linx');
    // Its own namespace only, and only its own model ids.
    expect(conn.canonicalModel('xpod-builtin/other')).toBeUndefined();
    expect(conn.canonicalModel('custom/linx')).toBeUndefined();
    expect(conn.canonicalModel('openai/linx')).toBeUndefined();
    expect(conn.canonicalModel('gpt-5.4')).toBeUndefined();
    expect(conn.canonicalModel('')).toBeUndefined();
    expect(conn.canonicalModel(undefined)).toBeUndefined();
    // The predicate agrees with the canonicalizer.
    for (const owned of ['linx', 'linx-lite', 'xpod-builtin/linx']) expect(conn.owns(owned)).toBe(true);
    for (const foreign of ['custom/linx', 'xpod-builtin/nope', 'other', 'linx/linx']) expect(conn.owns(foreign)).toBe(false);
  });

  it('keeps the Pod router default when a chat stream omits the assistant role frames', async () => {
    const sse = 'data: {"id":"s1","choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
    const execution = await service(builtin(fetchImpl as never), podDenied).execute({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'linx-lite', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events).toEqual([
      { type: 'response.started', id: 'deployment' },
      { type: 'text.delta', text: 'hi' },
      { type: 'response.completed', finishReason: 'stop' },
    ]);
  });

  it('does not claim protocols the built-in does not publish', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('deployment built-in must not serve /v1/messages');
    });
    const router = {
      listVisibleModels: vi.fn(async () => []),
      route: vi.fn(async () => { throw new Error('router path used'); }),
    };
    await expect(service(builtin(fetchImpl as never), router).complete({
      auth: DPOP_AUTH,
      protocol: 'anthropic',
      body: { model: 'linx', messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toThrow('router path used');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    // A bare Pod-looking reference and the built-in's OWN qualified reference must
    // both respect the explicit-credential guard: the deployment key is never used.
    ['linx', 'linx'],
    ['xpod-builtin/linx', 'xpod-builtin/linx'],
  ])('keeps an explicit credential id on the Pod router for reference %s', async (model) => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('deployment built-in must not be used for explicit credentials');
    });
    const router = {
      listVisibleModels: vi.fn(async () => []),
      route: vi.fn(async () => {
        throw new Error('credential_unavailable');
      }),
    };
    await expect(service(builtin(fetchImpl as never), router).complete({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: {
        model,
        credential_id: 'pod-credential',
        messages: [{ role: 'user', content: 'hi' }],
      },
    })).rejects.toThrow('credential_unavailable');
    expect(router.route).toHaveBeenCalledWith(expect.objectContaining({ explicitCredentialId: 'pod-credential' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('routes a foreign qualified namespace to the provided router with the original model preserved', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('deployment built-in must not serve a foreign provider namespace');
    });
    const router = {
      listVisibleModels: vi.fn(async () => []),
      route: vi.fn(async (input: { model?: string }) => {
        // The caller's reference must reach the ORDINARY router unmodified: the
        // built-in only strips its own namespace, never another provider's.
        expect(input.model).toBe('custom/linx');
        throw new Error('pod_route_reached');
      }),
    };
    await expect(service(builtin(fetchImpl as never), router).complete({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'custom/linx', messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toThrow('pod_route_reached');
    expect(router.route).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to follow redirects with the deployment key and never exposes the upstream error text', async () => {
    const redirected = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(init?.redirect).toBe('error');
      throw new TypeError('fetch failed: https://ai-gateway.example/v1/chat/completions?key=' + KEY);
    });
    const connection = new DeploymentBuiltinConnection(
      { apiBase: 'http://ai-gateway/v1', apiKey: KEY, modelMap: {} },
      { fetch: redirected as never },
    );
    await expect(connection.completeJson({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'linx', messages: [{ role: 'user', content: 'hi' }] },
    })).rejects.toMatchObject({ code: 'provider_error', status: 502 });

    const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      return Response.json({
        error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key', status: 401 },
      }, { status: 401 });
    });
    const rejecting = new DeploymentBuiltinConnection(
      { apiBase: 'http://ai-gateway/v1', apiKey: KEY, modelMap: {} },
      { fetch: upstream as never },
    );
    const failure = await rejecting.completeJson({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'linx', messages: [{ role: 'user', content: 'hi' }] },
    }).catch((error: unknown) => error) as { message: string; code: string; status: number };
    expect(failure.message).toBe('Deployment model inference failed');
    expect(failure.message).not.toContain(KEY);
    expect(failure.status).toBe(401);
    expect(JSON.stringify(failure)).not.toContain(KEY);
  });

  it.each([
    ['linx', 'linx'],
    ['xpod-builtin/linx', 'linx'],
    ['xpod-builtin/linx-lite', 'linx-lite'],
  ])('decodes a real Responses SSE transcript for model reference %s', async (requested, canonical) => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_real"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"real-"}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"answer"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
      '',
      '',
    ].join('\n');
    // A NON-identity map proves the qualified reference is normalized to the
    // bare canonical id BEFORE the deployment map, and the upstream receives the
    // configured physical model rather than `xpod-builtin/...`.
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
    const execution = await service(builtin(fetchImpl as never, { [canonical]: `upstream-${canonical}` }), podDenied).execute({
      auth: DPOP_AUTH,
      protocol: 'responses',
      body: { model: requested, stream: true, input: 'hi' },
    });
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events).toEqual([
      { type: 'response.started', id: 'resp_real' },
      { type: 'text.delta', text: 'real-' },
      { type: 'text.delta', text: 'answer' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { type: 'response.completed', finishReason: 'completed' },
    ]);
    // Route EVIDENCE carries the bare canonical model and the builtin provider.
    expect(execution.route.model).toBe(canonical);
    expect(execution.route.provider.id).toBe(builtinId);
    // Upstream body follows the non-identity map and never leaks the namespace.
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(`upstream-${canonical}`);
    expect(JSON.stringify(body)).not.toContain('xpod-builtin/');
    expect(body.user).toBe(WEB_ID);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://ai-gateway/v1/responses');
    expect(podDenied.route).not.toHaveBeenCalled();
  });

  it('fails a real Responses error event opaquely and never leaks the deployment key', async () => {
    const secret = KEY;
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_failed"}}',
      '',
      `data: {"type":"response.failed","response":{"error":{"type":"invalid_request_error","message":"Incorrect API key provided: ${secret}","code":"invalid_api_key"}}}`,
      '',
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
    const execution = await service(builtin(fetchImpl as never), podDenied).execute({
      auth: DPOP_AUTH,
      protocol: 'responses',
      body: { model: 'linx', stream: true, input: 'hi' },
    });
    const failure = await (async () => {
      try {
        for await (const _event of execution.events) { /* consume until failure */ }
        return undefined;
      } catch (error) {
        return error as Error & { code?: string; status?: number; cause?: unknown; details?: unknown };
      }
    })();
    expect(failure).toBeDefined();
    expect(failure!.message).toBe('Deployment model stream failed');
    expect(failure!.code).toBe('provider_error');
    expect(failure!.cause).toBeUndefined();
    for (const surface of [failure!.message, failure!.stack ?? '', JSON.stringify(failure!.details ?? {}), String(failure!.cause ?? '')]) {
      expect(surface).not.toContain(secret);
    }
  });

  it('reports a malformed non-JSON HTTP error body opaquely without the key', async () => {
    const secret = KEY;
    const fetchImpl = vi.fn(async () => new Response(
      `upstream proxy rejected Authorization: Bearer ${secret}`,
      { status: 502, headers: { 'content-type': 'text/html' } },
    ));
    const failure = await service(builtin(fetchImpl as never), podDenied).complete({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'linx', messages: [{ role: 'user', content: 'hi' }] },
    }).catch((error: unknown) => error) as Error & { code?: string; status?: number; cause?: unknown };
    expect(failure.message).toBe('Deployment model inference failed');
    expect(failure.status).toBe(502);
    expect(failure.cause).toBeUndefined();
    expect(`${failure.message}${failure.stack}${String(failure.cause ?? '')}`).not.toContain(secret);
  });

  it('keeps the deployment key out of a network failure cause and stack', async () => {
    const secret = KEY;
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed https://ai-gateway/v1/chat/completions?key=${secret}`), {
        code: `SOCKET_${secret}`,
      });
    });
    const failure = await service(builtin(fetchImpl as never), podDenied).complete({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: 'linx', messages: [{ role: 'user', content: 'hi' }] },
    }).catch((error: unknown) => error) as Error & { cause?: unknown; stack?: string };
    expect(failure.message).toBe('Cloud inference is unreachable');
    expect(failure.cause).toBeUndefined();
    expect(`${failure.stack}${String(failure.cause ?? '')}`).not.toContain(secret);
  });

  it.each([
    ['linx-lite', 'linx-lite'],
    ['xpod-builtin/linx', 'linx'],
    ['xpod-builtin/linx-lite', 'linx-lite'],
  ])('streams Chat for model reference %s and never forwards the caller DPoP token upstream', async (requested, canonical) => {
    const sse = 'data: {"id":"s1","choices":[{"delta":{"content":"hi"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const fetchImpl = vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
    const execution = await service(builtin(fetchImpl as never, { [canonical]: `upstream-${canonical}` }), podDenied).execute({
      auth: DPOP_AUTH,
      protocol: 'chatCompletions',
      body: { model: requested, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events.some((event) => event.type === 'text.delta')).toBe(true);
    expect(execution.route.model).toBe(canonical);
    expect(execution.route.provider.id).toBe(builtinId);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(`upstream-${canonical}`);
    expect(JSON.stringify(body)).not.toContain('xpod-builtin/');
    expect(body.user).toBe(WEB_ID);
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe('error');
    expect(String(init.body)).not.toContain('dpop-token');
    expect(podDenied.route).not.toHaveBeenCalled();
  });
});
