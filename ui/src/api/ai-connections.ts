import {
  createAiConnectionsClient,
  type AiConnectionsClient,
} from '@undefineds.co/ai-connections';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';

interface CreateXpodAiConnectionsClientInput {
  webId: string;
  podUrl: string;
  authenticatedFetch: typeof fetch;
  database: SolidDatabase;
}

export function createXpodAiConnectionsClient({
  webId,
  podUrl,
  authenticatedFetch,
  database,
}: CreateXpodAiConnectionsClientInput): AiConnectionsClient {
  return createAiConnectionsClient({
    webId,
    podBaseUrl: podUrl,
    authenticatedFetch: createAiConnectionsManagementFetch(authenticatedFetch),
    database,
  });
}

export function createAiConnectionsManagementFetch(authenticatedFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return sanitizeManagementFailure(await authenticatedFetch(input, init));
  }) as typeof fetch;
}

async function sanitizeManagementFailure(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    return normalizeStructuredApiError(response);
  }
  await response.arrayBuffer();
  return new Response(JSON.stringify({ error: 'internal_error' }), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

async function normalizeStructuredApiError(response: Response): Promise<Response> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!isStructuredApiError(payload)) {
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

function isStructuredApiError(value: unknown): value is {
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
