import {
  createAiConnectionClient,
  resolveAiConnectionApiBase,
  type AiConnectionClient,
} from '@undefineds.co/ai-connection';

interface CreateXpodAiConnectionClientInput {
  webId: string;
  podUrl: string;
  authenticatedFetch: typeof fetch;
}

interface AiConnectionInvocation {
  baseUrl?: string;
  gatewayKey?: string;
}

export function createXpodAiConnectionClient({
  webId,
  podUrl,
  authenticatedFetch,
}: CreateXpodAiConnectionClientInput): AiConnectionClient {
  return createAiConnectionClient({
    webId,
    podBaseUrl: podUrl,
    authenticatedFetch: createServiceAccessGatewayFetch({
      podUrl,
      authenticatedFetch,
    }),
  });
}

export function createServiceAccessGatewayFetch({
  podUrl,
  authenticatedFetch,
}: {
  podUrl: string;
  authenticatedFetch: typeof fetch;
}): typeof fetch {
  const apiBase = resolveAiConnectionApiBase(podUrl);
  let invocation: AiConnectionInvocation | undefined;

  const fetchServiceAccess = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await authenticatedFetch(input, init);
    invocation = await invocationFromResponse(response.clone());
    return response;
  };

  const ensureInvocation = async (): Promise<AiConnectionInvocation> => {
    if (invocation?.gatewayKey) {
      return invocation;
    }
    const response = await fetchServiceAccess(`${apiBase}/api/applets/service-access/ai-connection`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error('AI Connection request failed. Please try again.');
    }
    if (!invocation?.gatewayKey) {
      throw new Error('AI Connection request failed. Please try again.');
    }
    return invocation;
  };

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (isServiceAccessRequest(input, apiBase)) {
      return fetchServiceAccess(input, init);
    }

    const activeInvocation = await ensureInvocation();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${activeInvocation.gatewayKey}`);
    const response = await authenticatedFetch(input, {
      ...init,
      credentials: 'omit',
      headers,
    });
    return sanitizeManagementFailure(response);
  }) as typeof fetch;
}

function isServiceAccessRequest(input: RequestInfo | URL, apiBase: string): boolean {
  try {
    const url = new URL(String(input), apiBase);
    return url.pathname === '/api/applets/service-access/ai-connection';
  } catch {
    return false;
  }
}

async function invocationFromResponse(response: Response): Promise<AiConnectionInvocation | undefined> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return undefined;
  }
  try {
    const payload = await response.json() as { invocation?: AiConnectionInvocation };
    return payload.invocation;
  } catch {
    return undefined;
  }
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

async function normalizeStructuredGatewayError(response: Response): Promise<Response> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
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
