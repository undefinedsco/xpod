/**
 * Grants the task layer may use while nobody is present.
 *
 * The settings page owns the whole lifecycle: it grants with the session's own credential, shows
 * what is on file, and revokes. No response here ever carries a secret.
 */
export type TaskCredentialStatus = 'pending' | 'active' | 'revoked' | 'expired';

export interface TaskCredentialSummary {
  credentialRef: string;
  ownerWebId: string;
  issuer: string;
  clientId: string;
  version: number;
  status: TaskCredentialStatus;
  createdAt: string;
  rotatedAt?: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface TaskCredentialClientOptions {
  fetch: typeof fetch;
  /** Current origin; defaults to the browser's. */
  origin?: string;
}

function apiUrl(path: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? undefined : window.location.origin);
  if (!base) {
    throw new Error('task credential request needs a current browser origin');
  }
  return new URL(path, base).toString();
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text().catch(() => '');
  if (!text) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function failureMessage(payload: Record<string, unknown> | undefined, fallback: string): string {
  const error = payload?.error;
  return typeof error === 'string' && error ? error : fallback;
}

export async function fetchTaskCredentials(
  options: TaskCredentialClientOptions,
): Promise<TaskCredentialSummary[]> {
  const response = await options.fetch(apiUrl('/api/ai/task-credentials', options.origin), {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(failureMessage(payload, 'Task credential request failed'));
  }
  const data = payload?.data;
  return Array.isArray(data) ? data as TaskCredentialSummary[] : [];
}

/** Grant the task layer the credential this session prepared. */
export async function grantTaskCredential(
  options: TaskCredentialClientOptions & { apiKey: string; name?: string },
): Promise<TaskCredentialSummary> {
  const response = await options.fetch(apiUrl('/api/ai/task-credentials', options.origin), {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: options.apiKey, ...(options.name ? { name: options.name } : {}) }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(failureMessage(payload, 'Task credential grant failed'));
  }
  const credential = payload?.credential;
  if (!credential || typeof credential !== 'object') {
    throw new Error('Task credential grant returned no grant');
  }
  return credential as TaskCredentialSummary;
}

export async function revokeTaskCredential(
  options: TaskCredentialClientOptions & { credentialRef: string },
): Promise<void> {
  const response = await options.fetch(
    apiUrl(`/api/ai/task-credentials/${encodeURIComponent(options.credentialRef)}`, options.origin),
    { method: 'DELETE', credentials: 'include', headers: { accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(failureMessage(await readJson(response), 'Task credential revocation failed'));
  }
}

/** The grant this deployment would use, if the owner made one that still applies. */
export function activeTaskCredential(
  credentials: readonly TaskCredentialSummary[],
  issuer: string | undefined,
): TaskCredentialSummary | undefined {
  return credentials
    .filter((credential) => credential.status === 'active' && (!issuer || credential.issuer === issuer))
    .sort((left, right) => right.version - left.version)[0];
}
