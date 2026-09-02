interface ProvisionStatusResponse {
  managed?: boolean;
  registered?: boolean;
  provisionCode?: unknown;
}

export interface XpodAuthProvisionContext {
  authenticating?: boolean;
  provisionCode?: unknown;
}

export const CLOUD_PROVISIONING_UNAVAILABLE = 'Cloud storage is not ready. Please wait for Xpod to reconnect and try again.';

function readStoredProvisionCodeRaw(): string | undefined {
  try {
    const value = sessionStorage.getItem('provisionCode')?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

function isProvisionCodeCurrent(provisionCode: string): boolean {
  const data = provisionCode.split('.')[0];
  if (!data) {
    return true;
  }

  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    if (typeof globalThis.atob !== 'function') {
      return true;
    }
    const payload = JSON.parse(globalThis.atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number'
      ? payload.exp > Math.floor(Date.now() / 1000)
      : true;
  } catch {
    return true;
  }
}

function normalizeProvisionCode(provisionCode: string | undefined | null): string | undefined {
  const value = provisionCode?.trim();
  if (!value) {
    return undefined;
  }
  return isProvisionCodeCurrent(value) ? value : undefined;
}

export function getStoredProvisionCode(): string | undefined {
  const value = readStoredProvisionCodeRaw();
  const current = normalizeProvisionCode(value);
  if (value && !current) {
    clearStoredProvisionCode();
  }
  return current;
}

export function syncProvisionCodeFromLocation(search = typeof window !== 'undefined' ? window.location.search : ''): string | undefined {
  try {
    const raw = new URLSearchParams(search).get('provisionCode')?.trim();
    if (!raw) {
      return getStoredProvisionCode();
    }

    const current = normalizeProvisionCode(raw);
    if (current) {
      setStoredProvisionCode(current);
      return current;
    }
    clearStoredProvisionCode();
  } catch {
    // Keep the existing cached value if URL parsing is unavailable.
  }

  return getStoredProvisionCode();
}

export function syncProvisionCodeFromAuthContext(
  search = typeof window !== 'undefined' ? window.location.search : '',
  context: XpodAuthProvisionContext | undefined = typeof window !== 'undefined' ? window.__XPOD__ : undefined,
): string | undefined {
  const rawFromContext = typeof context?.provisionCode === 'string'
    ? context.provisionCode.trim()
    : undefined;
  if (context?.authenticating === true) {
    if (rawFromContext) {
      const current = normalizeProvisionCode(rawFromContext);
      if (current) {
        setStoredProvisionCode(current);
        return current;
      }
    }
    clearStoredProvisionCode();
    return undefined;
  }

  try {
    const rawFromUrl = new URLSearchParams(search).get('provisionCode')?.trim();
    if (rawFromUrl) {
      const current = normalizeProvisionCode(rawFromUrl);
      if (current) {
        setStoredProvisionCode(current);
        return current;
      }
      clearStoredProvisionCode();
      return undefined;
    }
  } catch {
    // Keep the existing cached value if URL parsing is unavailable.
  }

  if (rawFromContext) {
    const current = normalizeProvisionCode(rawFromContext);
    if (current) {
      setStoredProvisionCode(current);
      return current;
    }
    clearStoredProvisionCode();
    return undefined;
  }

  return getStoredProvisionCode();
}

export function setStoredProvisionCode(provisionCode: string): void {
  try {
    sessionStorage.setItem('provisionCode', provisionCode);
  } catch {
    // ignore
  }
}

export function clearStoredProvisionCode(): void {
  try {
    sessionStorage.removeItem('provisionCode');
  } catch {
    // ignore
  }
}

export function buildPodCreatePayload(
  name: string,
  provisionCode = getStoredProvisionCode(),
  provisionReceipt?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: name.trim() };
  if (provisionCode) {
    payload.settings = {
      provisionCode,
      ...(provisionReceipt ? { provisionReceipt } : {}),
    };
  }
  return payload;
}

export async function resolveProvisionCodeForCurrentScope(
  fetchImpl: typeof fetch = fetch,
  preferredProvisionCode?: string,
): Promise<string | undefined> {
  const context = typeof window !== 'undefined' ? window.__XPOD__ : undefined;
  if (context?.authenticating === true) {
    // The server's active interaction is authoritative, even if sessionStorage
    // is unavailable or still contains a different Local node's provisioning.
    const raw = typeof context.provisionCode === 'string' ? context.provisionCode.trim() : undefined;
    const current = normalizeProvisionCode(raw);
    if (current) {
      setStoredProvisionCode(current);
      return current;
    }
    clearStoredProvisionCode();
    if (raw) {
      throw new Error(CLOUD_PROVISIONING_UNAVAILABLE);
    }
    // An ordinary Cloud/Standalone interaction has no Local provisioning scope.
    return undefined;
  }

  const rawPreferred = preferredProvisionCode?.trim()
    || readStoredProvisionCodeRaw();
  const fallback = normalizeProvisionCode(rawPreferred);

  if (rawPreferred || typeof window !== 'undefined') {
    const current = await fetchCurrentProvisionCode(fetchImpl);
    if (current) {
      setStoredProvisionCode(current);
      return current;
    }
  }

  if (rawPreferred && !fallback) {
    clearStoredProvisionCode();
  }
  return fallback;
}

export async function resolveProvisionCodeForPodCreate(
  fetchImpl: typeof fetch = fetch,
  preferredProvisionCode?: string,
): Promise<string | undefined> {
  return resolveProvisionCodeForCurrentScope(fetchImpl, preferredProvisionCode);
}

async function fetchCurrentProvisionCode(fetchImpl: typeof fetch): Promise<string | undefined> {
  const response = await fetchImpl('/provision/status', {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  } as RequestInit).catch(() => undefined);
  if (!response?.ok) {
    return undefined;
  }

  const body = await response.json().catch(() => undefined) as ProvisionStatusResponse | undefined;
  // Local+Cloud must never silently fall back to provisioning a localhost
  // identity. Standalone has no Cloud manager and may legitimately create a
  // local WebID; a managed node must wait for its signed provision code.
  if (body?.managed && (!body.registered || typeof body.provisionCode !== 'string')) {
    throw new Error(CLOUD_PROVISIONING_UNAVAILABLE);
  }
  if (!body?.registered || typeof body.provisionCode !== 'string') {
    return undefined;
  }

  return normalizeProvisionCode(body.provisionCode);
}
