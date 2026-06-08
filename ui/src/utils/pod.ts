interface ProvisionStatusResponse {
  registered?: boolean;
  provisionCode?: unknown;
}

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

export function buildPodCreatePayload(name: string, provisionCode = getStoredProvisionCode()): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: name.trim() };
  if (provisionCode) {
    payload.settings = { provisionCode };
  }
  return payload;
}

export async function resolveProvisionCodeForCurrentScope(
  fetchImpl: typeof fetch = fetch,
  preferredProvisionCode?: string,
): Promise<string | undefined> {
  const rawPreferred = preferredProvisionCode?.trim() || readStoredProvisionCodeRaw();
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
  if (!body?.registered || typeof body.provisionCode !== 'string') {
    return undefined;
  }

  return normalizeProvisionCode(body.provisionCode);
}
