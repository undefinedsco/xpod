import {
  createAiConnectionsClient,
  resolveAiConnectionsApiBase,
  type AiConnectionsClient,
} from '@undefineds.co/ai-connections';
import type {
  AiClientConfigurationCapability,
  AiClientConfigurationPlan,
  AiClientConfigurationStatus,
  AiClientId,
} from '@undefineds.co/extension-sdk/web';

interface CreateXpodAiConnectionsClientInput {
  webId: string;
  podUrl: string;
  authenticatedFetch: typeof fetch;
}

interface AiConnectionsInvocation {
  baseUrl?: string;
  token?: string;
  expiresAt?: string;
}

const INVOCATION_REFRESH_MARGIN_MS = 30_000;

export function createXpodAiConnectionsClient({
  webId,
  podUrl,
  authenticatedFetch,
}: CreateXpodAiConnectionsClientInput): AiConnectionsClient {
  return createAiConnectionsClient({
    webId,
    podBaseUrl: podUrl,
    authenticatedFetch: createInteractiveAiConnectionsFetch(authenticatedFetch),
  });
}

function createInteractiveAiConnectionsFetch(authenticatedFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return sanitizeManagementFailure(await authenticatedFetch(input, init));
  }) as typeof fetch;
}

export function createServiceAccessGatewayFetch({
  podUrl,
  authenticatedFetch,
  invocationFetch = authenticatedFetch,
  now = () => new Date(),
  invocationSelector = defaultInvocationSelector,
}: {
  podUrl: string;
  authenticatedFetch: typeof fetch;
  invocationFetch?: typeof fetch;
  now?: () => Date;
  invocationSelector?: (payload: Record<string, unknown>) => unknown;
}): typeof fetch {
  const apiBase = resolveAiConnectionsApiBase(podUrl);
  let invocation: AiConnectionsInvocation | undefined;
  let pendingInvocation: Promise<AiConnectionsInvocation> | undefined;

  const fetchServiceAccess = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await authenticatedFetch(input, init);
    invocation = await invocationFromResponse(response.clone(), invocationSelector);
    return response;
  };

  const ensureInvocation = async (): Promise<AiConnectionsInvocation> => {
    if (isUsableInvocation(invocation, now())) {
      return invocation;
    }
    if (pendingInvocation) {
      return pendingInvocation;
    }
    pendingInvocation = refreshInvocation();
    try {
      return await pendingInvocation;
    } finally {
      pendingInvocation = undefined;
    }
  };

  const refreshInvocation = async (): Promise<AiConnectionsInvocation> => {
    const response = await fetchServiceAccess(`${apiBase}/api/applets/service-access/ai-connections`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error('AI Connection request failed. Please try again.');
    }
    const activeInvocation = invocation;
    if (!activeInvocation?.token) {
      throw new Error('AI Connection request failed. Please try again.');
    }
    return activeInvocation;
  };

  const fetchWithInvocation = async (input: RequestInfo | URL, init: RequestInit | undefined): Promise<Response> => {
    const activeInvocation = await ensureInvocation();
    const token = invocationToken(activeInvocation);
    if (!token) throw new Error('AI Connection request failed. Please try again.');
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return invocationFetch(input, {
      ...init,
      credentials: 'omit',
      headers,
    });
  };

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (isServiceAccessRequest(input, apiBase)) {
      return fetchServiceAccess(input, init);
    }
    if (!isAiGatewayRequest(input, apiBase)) {
      return authenticatedFetch(input, init);
    }

    const response = await fetchWithInvocation(input, init);
    if (response.status !== 401) {
      return sanitizeManagementFailure(response);
    }
    await response.arrayBuffer();
    invocation = undefined;
    const retry = await fetchWithInvocation(input, init);
    return sanitizeManagementFailure(retry);
  }) as typeof fetch;
}

export function createXpodAiClientConfigurationBridge({
  podUrl,
  authenticatedFetch,
  invocationFetch,
  now,
}: {
  podUrl: string;
  authenticatedFetch: typeof fetch;
  invocationFetch?: typeof fetch;
  now?: () => Date;
}): AiClientConfigurationCapability {
  const apiBase = resolveAiConnectionsApiBase(podUrl);
  const gatewayFetch = createServiceAccessGatewayFetch({
    podUrl,
    authenticatedFetch,
    invocationFetch,
    now,
    invocationSelector: clientConfigurationInvocationSelector,
  });

  return {
    inspect: async (client) => {
      const response = await gatewayFetch(clientConfigUrl(apiBase, client), {
        method: 'GET',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });
      if (response.status === 403 || response.status === 404 || response.status === 503) {
        await response.arrayBuffer();
        return unavailableClientConfigStatus();
      }
      return readClientConfigJson<AiClientConfigurationStatus>(response);
    },
    plan: async (input) => readClientConfigJson<AiClientConfigurationPlan>(await gatewayFetch(`${clientConfigUrl(apiBase, input.client)}/plan`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        endpoint: input.endpoint,
      }),
    })),
    apply: async (input) => readClientConfigJson<{ applied: true }>(await gatewayFetch(`${clientConfigUrl(apiBase, input.client)}/apply`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        planId: input.planId,
        apiKey: input.apiKey,
        confirmation: input.confirmation,
      }),
    })),
    verify: async (input) => readClientConfigJson<AiClientConfigurationStatus>(await gatewayFetch(`${clientConfigUrl(apiBase, input.client)}/verify`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        planId: input.planId,
      }),
    })),
    launch: async (client) => readClientConfigJson<{ launched: true }>(await gatewayFetch(`${clientConfigUrl(apiBase, client)}/launch`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })),
    restore: async (client) => {
      const response = await gatewayFetch(`${clientConfigUrl(apiBase, client)}/restore`, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      if (response.status === 403 || response.status === 404 || response.status === 503) {
        await response.arrayBuffer();
        return unavailableClientConfigStatus();
      }
      return readClientConfigJson<AiClientConfigurationStatus>(response);
    },
  };
}

function isServiceAccessRequest(input: RequestInfo | URL, apiBase: string): boolean {
  try {
    const url = new URL(String(input), apiBase);
    const base = new URL(apiBase);
    return url.origin === base.origin && url.pathname === '/api/applets/service-access/ai-connections';
  } catch {
    return false;
  }
}

function isAiGatewayRequest(input: RequestInfo | URL, apiBase: string): boolean {
  try {
    const url = new URL(String(input), apiBase);
    const base = new URL(apiBase);
    return url.origin === base.origin && (url.pathname.startsWith('/api/ai/') || url.pathname.startsWith('/v1/'));
  } catch {
    return false;
  }
}

async function invocationFromResponse(
  response: Response,
  selector: (payload: Record<string, unknown>) => unknown,
): Promise<AiConnectionsInvocation | undefined> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return undefined;
  }
  try {
    const payload = await response.json() as Record<string, unknown>;
    return normalizeInvocation(selector(payload));
  } catch {
    return undefined;
  }
}

function defaultInvocationSelector(payload: Record<string, unknown>): unknown {
  return payload.invocation;
}

function clientConfigurationInvocationSelector(payload: Record<string, unknown>): unknown {
  const capability = payload.aiClientConfiguration;
  return isRecord(capability) ? capability.invocation : undefined;
}

function isUsableInvocation(invocation: AiConnectionsInvocation | undefined, now: Date): invocation is AiConnectionsInvocation {
  if (!invocation?.token) {
    return false;
  }
  if (!invocation.expiresAt) {
    return true;
  }
  const expiresAt = Date.parse(invocation.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now.getTime() > INVOCATION_REFRESH_MARGIN_MS;
}

function invocationToken(invocation: AiConnectionsInvocation | undefined): string | undefined {
  return invocation?.token;
}

function normalizeInvocation(value: unknown): AiConnectionsInvocation | undefined {
  if (!isRecord(value)) return undefined;
  const legacyTokenField = ['gateway', 'Key'].join('');
  const token = typeof value.token === 'string'
    ? value.token
    : typeof value.apiKey === 'string'
      ? value.apiKey
      : typeof value[legacyTokenField] === 'string'
        ? value[legacyTokenField]
        : undefined;
  return {
    token,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : undefined,
  };
}

async function sanitizeManagementFailure(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    return normalizeStructuredGatewayError(response);
  }
  await response.arrayBuffer();
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function clientConfigUrl(apiBase: string, client: AiClientId): string {
  return `${apiBase}/api/ai/client-configuration/${encodeURIComponent(client)}`;
}

async function readClientConfigJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await clientConfigErrorFromResponse(response);
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.arrayBuffer();
    throw new Error('AI client configuration request failed. Please try again.');
  }
  return await response.json() as T;
}

async function clientConfigErrorFromResponse(response: Response): Promise<Error> {
  let payload: unknown;
  try {
    payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : undefined;
  } catch {
    payload = undefined;
  }
  if (isRecord(payload)) {
    const code = typeof payload.code === 'string'
      ? payload.code
      : typeof payload.error === 'string'
        ? payload.error
        : undefined;
    const message = typeof payload.message === 'string'
      ? payload.message
      : 'AI client configuration request failed. Please try again.';
    const error = new Error(message) as Error & { code?: string; status?: number; details?: unknown };
    error.code = code;
    error.status = response.status;
    error.details = payload.details;
    return error;
  }
  await response.arrayBuffer().catch(() => undefined);
  return new Error('AI client configuration request failed. Please try again.');
}

function unavailableClientConfigStatus(): AiClientConfigurationStatus {
  return {
    status: 'unavailable',
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  };
}

async function normalizeStructuredGatewayError(response: Response): Promise<Response> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  const legacyCode = legacyGatewayErrorCode(payload);
  if (legacyCode) {
    return new Response(JSON.stringify({ code: legacyCode }), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!isStructuredGatewayError(payload)) {
    return response;
  }
  return new Response(JSON.stringify({
    code: payload.error.code,
    error: payload.error.message,
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

function isStructuredGatewayError(value: unknown): value is {
  error: { code: string; message: string; status: number };
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  return Boolean(
    error
    && typeof error === 'object'
    && !Array.isArray(error)
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string'
    && typeof (error as { status?: unknown }).status === 'number',
  );
}

function legacyGatewayErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.error !== 'string') {
    return undefined;
  }
  switch (value.error) {
    case 'Gateway API Key plaintext is not available':
      return 'gateway_api_key_plaintext_unavailable';
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
