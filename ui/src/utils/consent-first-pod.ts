import { buildPodCreatePayload, resolveProvisionCodeForPodCreate } from './pod';
import { resolveProvisionScope } from './provision-scope';
import { getRegistrationUsernameError, normalizeRegistrationUsername } from './registration';

export interface ConsentFirstPodOptions {
  createPodUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxAttempts?: number;
  pickWebIdUrl?: string;
  pollIntervalMs?: number;
  provisionCode?: string;
  username: string;
}

export type FirstPodNameAvailabilityStatus = 'available' | 'taken' | 'invalid' | 'unknown';

export interface FirstPodNameAvailabilityOptions {
  fetchImpl?: typeof fetch;
  provisionCode?: string;
  username: string;
}

export interface FirstPodNameAvailability {
  message?: string;
  status: FirstPodNameAvailabilityStatus;
}

interface PodCreateResponse {
  webId?: unknown;
  webIds?: unknown;
}

export function deriveFirstPodNameCandidate(webIds: Array<string | null | undefined>): string {
  for (const webId of webIds) {
    if (!webId) {
      continue;
    }
    const candidate = derivePodSegment(webId);
    if (!candidate) {
      continue;
    }
    const normalized = normalizeRegistrationUsername(candidate)
      .replace(/[^a-z0-9-]/gu, '-')
      .replace(/-+/gu, '-')
      .replace(/^-+|-+$/gu, '');
    if (normalized && !getRegistrationUsernameError(normalized)) {
      return normalized;
    }
  }

  return '';
}

export async function checkFirstPodNameAvailability(
  options: FirstPodNameAvailabilityOptions,
): Promise<FirstPodNameAvailability> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const username = normalizeRegistrationUsername(options.username);
  const usernameError = getRegistrationUsernameError(username);
  if (usernameError) {
    return { status: 'invalid', message: usernameError };
  }

  const provisionCode = await resolveProvisionCodeForPodCreate(fetchImpl, options.provisionCode);
  const scope = resolveProvisionScope(provisionCode);
  if (!scope) {
    return { status: 'unknown' };
  }

  const url = new URL(`/provision/pods/${encodeURIComponent(username)}`, scope.lookupUrl).toString();
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${scope.serviceToken}`,
    },
    credentials: 'include',
  } as RequestInit).catch(() => undefined);

  if (!response) {
    return {
      status: 'unknown',
      message: 'Could not check this Pod name right now.',
    };
  }
  if (response.status === 404) {
    return { status: 'available', message: 'This Pod name is available.' };
  }
  if (response.ok) {
    return {
      status: 'taken',
      message: `Pod name "${username}" is already used on this storage.`,
    };
  }
  if (response.status === 409) {
    return {
      status: 'taken',
      message: await readResponseMessage(response) ?? `Pod name "${username}" is already used on this storage.`,
    };
  }

  return {
    status: 'unknown',
    message: await readResponseMessage(response) ?? 'Could not check this Pod name right now.',
  };
}

export async function createFirstPodAndWaitForWebIds(options: ConsentFirstPodOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const username = normalizeRegistrationUsername(options.username);
  const usernameError = getRegistrationUsernameError(username);
  if (usernameError) {
    throw new Error(usernameError);
  }
  const provisionCode = await resolveProvisionCodeForPodCreate(fetchImpl, options.provisionCode);

  const response = await fetchImpl(options.createPodUrl, {
    method: 'POST',
    headers: {
      ...options.headers,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(buildPodCreatePayload(username, provisionCode)),
  } as RequestInit);

  if (!response.ok) {
    const message = await readResponseMessage(response);
    if (response.status === 409 || isPodNameConflict(message)) {
      throw new Error('Pod name is already taken. Choose another name.');
    }
    throw new Error(message || 'Failed to create Pod');
  }

  const createBody = await response.json().catch(() => undefined) as PodCreateResponse | undefined;
  const createdWebIds = extractCreatedWebIds(createBody);

  if (!options.pickWebIdUrl) {
    return createdWebIds;
  }

  const pickedWebIds = await waitForConsentWebIds({
    fetchImpl,
    headers: options.headers,
    maxAttempts: options.maxAttempts,
    pickWebIdUrl: options.pickWebIdUrl,
    pollIntervalMs: options.pollIntervalMs,
  });
  return pickedWebIds.length > 0 ? pickedWebIds : createdWebIds;
}

export interface WaitForConsentWebIdsOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  maxAttempts?: number;
  pickWebIdUrl: string;
  pollIntervalMs?: number;
}

export async function waitForConsentWebIds(options: WaitForConsentWebIdsOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 30);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 500);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const webIds = await fetchConsentWebIds(fetchImpl, options.pickWebIdUrl, options.headers);
    if (webIds.length > 0) {
      return webIds;
    }
    if (attempt < maxAttempts - 1 && pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return [];
}

async function fetchConsentWebIds(
  fetchImpl: typeof fetch,
  pickWebIdUrl: string,
  headers: Record<string, string> | undefined,
): Promise<string[]> {
  const response = await fetchImpl(pickWebIdUrl, {
    headers,
    credentials: 'include',
  } as RequestInit).catch(() => undefined);
  if (!response?.ok) {
    return [];
  }

  const data = await response.json().catch(() => undefined) as { webIds?: unknown } | undefined;
  if (!Array.isArray(data?.webIds)) {
    return [];
  }

  return data.webIds.filter((webId): webId is string => typeof webId === 'string' && webId.length > 0);
}

async function readResponseMessage(response: Response): Promise<string | undefined> {
  const text = await response.text?.().catch(() => undefined);
  if (!text) {
    return undefined;
  }

  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    return typeof body.message === 'string'
      ? body.message
      : typeof body.error === 'string'
        ? body.error
        : text;
  } catch {
    return text;
  }
}

function isPodNameConflict(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /already (?:is )?a resource/iu.test(message) ||
    /already taken/iu.test(message) ||
    /already exists/iu.test(message);
}

function extractCreatedWebIds(body: PodCreateResponse | undefined): string[] {
  const webIds = new Set<string>();
  if (typeof body?.webId === 'string' && body.webId.length > 0) {
    webIds.add(body.webId);
  }
  if (Array.isArray(body?.webIds)) {
    for (const webId of body.webIds) {
      if (typeof webId === 'string' && webId.length > 0) {
        webIds.add(webId);
      }
    }
  }
  return Array.from(webIds);
}

function derivePodSegment(webId: string): string | undefined {
  try {
    const url = new URL(webId);
    return url.pathname.split('/').filter(Boolean)[0];
  } catch {
    return undefined;
  }
}
