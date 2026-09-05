import { resolveProvisionStorageTarget } from './provision-scope';

export interface XpodAuthProvisionContext {
  authenticating?: boolean;
  provisionCode?: unknown;
}

export interface CurrentProvisionTarget {
  activeProvisionCode?: string;
  storageRoot?: string;
}

interface CurrentProvisionTargetState extends CurrentProvisionTarget {
  hasProvisionOperation: boolean;
}

export const CLOUD_PROVISIONING_UNAVAILABLE = 'Cloud storage is not ready. Please wait for Xpod to reconnect and try again.';

// Only a host that has positively discovered a managed Local gateway installs
// this capability. CSS Account pages and OIDC interactions do not discover it.
const localProvisionResolvers = new WeakMap<Window, () => Promise<string>>();

export function registerLocalProvisionResolver(resolveCode: () => Promise<string>): void {
  if (typeof window !== 'undefined') localProvisionResolvers.set(window, resolveCode);
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
  // An expired operation is not an absent operation. Do not return it as a
  // usable credential, but retain it so creation/retry can fail closed.
  return normalizeProvisionCode(readStoredProvisionCodeRaw());
}

export function syncProvisionCodeFromLocation(search = typeof window !== 'undefined' ? window.location.search : ''): string | undefined {
  try {
    const raw = new URLSearchParams(search).get('provisionCode')?.trim();
    if (!raw) {
      return getStoredProvisionCode();
    }

    setStoredProvisionCode(raw);
    return normalizeProvisionCode(raw);
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
      setStoredProvisionCode(rawFromContext);
      return normalizeProvisionCode(rawFromContext);
    }
    clearStoredProvisionCode();
    return undefined;
  }

  try {
    const rawFromUrl = new URLSearchParams(search).get('provisionCode')?.trim();
    if (rawFromUrl) {
      setStoredProvisionCode(rawFromUrl);
      return normalizeProvisionCode(rawFromUrl);
    }
  } catch {
    // Keep the existing cached value if URL parsing is unavailable.
  }

  if (rawFromContext) {
    setStoredProvisionCode(rawFromContext);
    return normalizeProvisionCode(rawFromContext);
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
  preferredProvisionCode?: string,
): Promise<string | undefined> {
  const target = await resolveCurrentProvisionTargetState(preferredProvisionCode);
  if (target.activeProvisionCode) {
    return target.activeProvisionCode;
  }
  if (target.hasProvisionOperation) {
    throw new Error(CLOUD_PROVISIONING_UNAVAILABLE);
  }
  return undefined;
}

export async function resolveCurrentProvisionTarget(
  preferredProvisionCode?: string,
): Promise<CurrentProvisionTarget> {
  const { hasProvisionOperation, ...target } = await resolveCurrentProvisionTargetState(preferredProvisionCode);
  void hasProvisionOperation;
  return target;
}

async function resolveCurrentProvisionTargetState(
  preferredProvisionCode?: string,
): Promise<CurrentProvisionTargetState> {
  const context = typeof window !== 'undefined' ? window.__XPOD__ : undefined;
  if (context?.authenticating === true) {
    // The server's active interaction is authoritative, even if sessionStorage
    // is unavailable or still contains a different Local node's provisioning.
    const raw = typeof context.provisionCode === 'string' ? context.provisionCode.trim() : undefined;
    const current = normalizeProvisionCode(raw);
    if (current) {
      setStoredProvisionCode(current);
      return {
        activeProvisionCode: current,
        hasProvisionOperation: true,
        storageRoot: resolveProvisionStorageTarget(current)?.storageRoot,
      };
    }
    clearStoredProvisionCode();
    // An ordinary Cloud/Standalone interaction has no Local provisioning scope.
    return raw
      ? { hasProvisionOperation: true, storageRoot: resolveProvisionStorageTarget(raw)?.storageRoot }
      : { hasProvisionOperation: false };
  }

  // Account pages consume the current operation's context. They are not Local
  // gateways, even when served on loopback by a development proxy. Discovery
  // and refresh belong to the host that starts the Local login operation.
  const explicit = preferredProvisionCode?.trim()
    || (typeof context?.provisionCode === 'string' ? context.provisionCode.trim() : undefined);
  const localResolver = typeof window !== 'undefined' ? localProvisionResolvers.get(window) : undefined;
  if (!explicit && localResolver) {
    const raw = await localResolver();
    const current = normalizeProvisionCode(raw);
    if (current) {
      setStoredProvisionCode(current);
      return {
        activeProvisionCode: current,
        hasProvisionOperation: true,
        storageRoot: resolveProvisionStorageTarget(current)?.storageRoot,
      };
    }
    return { hasProvisionOperation: true, storageRoot: resolveProvisionStorageTarget(raw)?.storageRoot };
  }
  const rawPreferred = explicit
    || readStoredProvisionCodeRaw();
  const fallback = normalizeProvisionCode(rawPreferred);
  if (fallback) {
    return {
      activeProvisionCode: fallback,
      hasProvisionOperation: true,
      storageRoot: resolveProvisionStorageTarget(fallback)?.storageRoot,
    };
  }

  // Keep failed operation context: a retry must not become an unscoped
  // Cloud create just because the first attempt consumed an expired code.
  return rawPreferred
    ? { hasProvisionOperation: true, storageRoot: resolveProvisionStorageTarget(rawPreferred)?.storageRoot }
    : { hasProvisionOperation: false };
}

export async function resolveProvisionCodeForPodCreate(
  preferredProvisionCode?: string,
): Promise<string | undefined> {
  return resolveProvisionCodeForCurrentScope(preferredProvisionCode);
}
