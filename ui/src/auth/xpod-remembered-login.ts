import type { StorageBinding } from '@undefineds.co/solid-sdk';
import type { SanitizedAccountIdentity } from '../context/AuthContextValue';
import { XPOD_LOGIN_ROUTE_ID } from './xpod-login-route';

export const XPOD_REMEMBERED_LOGIN_KEY = 'xpod.remembered-login.v1';
export const XPOD_PENDING_ACCOUNT_EMAIL_KEY = 'xpod.pending-account-email.v1';
export const XPOD_PENDING_ACCOUNT_ISSUER_KEY = 'xpod.pending-account-issuer.v1';

export interface RememberedXpodAccount extends SanitizedAccountIdentity {
  email?: string;
  avatarUrl?: string;
}

/**
 * Non-secret presentation data remembered after WebID + Pod readiness is
 * verified. Account email is optional: WebID login need not open an Account
 * session. This record never grants access or serializes either session.
 */
export interface RememberedXpodLogin {
  account: RememberedXpodAccount;
  webId: string;
  storageBinding: StorageBinding;
  routeId: typeof XPOD_LOGIN_ROUTE_ID;
}

export interface ReadRememberedXpodLoginOptions {
  storage?: Storage;
  origin?: string;
}

export type RememberXpodLoginOptions = ReadRememberedXpodLoginOptions;

export interface RememberedXpodLoginActiveState {
  accountIdentity?: SanitizedAccountIdentity;
  accountEmail?: string;
  webId?: string;
  selectedStorage?: StorageBinding;
}

export type RememberedXpodAccountActiveState = Pick<
  RememberedXpodLoginActiveState,
  'accountIdentity' | 'accountEmail'
>;

function optionalPersistentStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function readRememberedXpodLogin(
  options: ReadRememberedXpodLoginOptions = {},
): RememberedXpodLogin | undefined {
  const storage = options.storage ?? optionalPersistentStorage();
  if (!storage) return undefined;

  try {
    const raw = storage.getItem(XPOD_REMEMBERED_LOGIN_KEY);
    if (!raw) return undefined;
    const remembered = normalizeRememberedXpodLogin(
      JSON.parse(raw) as unknown,
      options.origin ?? currentOrigin(),
    );
    if (!remembered) storage.removeItem(XPOD_REMEMBERED_LOGIN_KEY);
    return remembered;
  } catch {
    try {
      storage.removeItem(XPOD_REMEMBERED_LOGIN_KEY);
    } catch {
      // A remembered identity is optional; an unavailable storage must not
      // block Xpod from falling back to first login.
    }
    return undefined;
  }
}

export function rememberXpodLogin(
  input: RememberedXpodLogin,
  options: RememberXpodLoginOptions = {},
): RememberedXpodLogin | undefined {
  const storage = options.storage ?? optionalPersistentStorage();
  if (!storage) return undefined;
  const remembered = normalizeRememberedXpodLogin(
    input,
    options.origin ?? currentOrigin(),
  );
  if (!remembered) return undefined;

  try {
    storage.setItem(XPOD_REMEMBERED_LOGIN_KEY, JSON.stringify(remembered));
    storage.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
    storage.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
    return remembered;
  } catch {
    return undefined;
  }
}

export function clearRememberedXpodLogin(storage: Storage | undefined = optionalPersistentStorage()): void {
  try {
    storage?.removeItem(XPOD_REMEMBERED_LOGIN_KEY);
    storage?.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
    storage?.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
  } catch {
    // Clearing a convenience record remains best-effort during account switch.
  }
}

export function rememberedXpodLoginMatchesActive(
  remembered: RememberedXpodLogin | undefined,
  active: RememberedXpodLoginActiveState,
): boolean {
  if (!remembered || !active.webId || !active.selectedStorage) return false;
  const rememberedWebId = normalizedUrl(remembered.webId);
  const rememberedBindingWebId = normalizedUrl(remembered.storageBinding.webId);
  const rememberedStorageUrl = normalizedUrl(remembered.storageBinding.storageUrl, true);
  const activeWebId = normalizedUrl(active.webId);
  const activeBindingWebId = normalizedUrl(active.selectedStorage.webId);
  const activeStorageUrl = normalizedUrl(active.selectedStorage.storageUrl, true);
  if (!rememberedWebId
    || !rememberedBindingWebId
    || !rememberedStorageUrl
    || !activeWebId
    || !activeBindingWebId
    || !activeStorageUrl) {
    return false;
  }
  if (rememberedWebId !== rememberedBindingWebId || activeWebId !== activeBindingWebId) return false;
  if (rememberedWebId !== activeWebId || rememberedStorageUrl !== activeStorageUrl) return false;

  return rememberedXpodAccountMatchesActive(remembered, active);
}

/** Account-only routes validate this half without claiming WebID/Pod readiness. */
export function rememberedXpodAccountMatchesActive(
  remembered: RememberedXpodLogin | undefined,
  active: RememberedXpodAccountActiveState,
): boolean {
  if (!remembered) return false;
  return matchingOptionalEmail(remembered.account.email, active.accountEmail);
}

export function rememberPendingXpodAccountEmail(
  email: string,
  storage: Storage | undefined = optionalPersistentStorage(),
  issuer?: string,
): string | undefined {
  const normalized = normalizedEmail(email);
  if (!storage || !normalized) return undefined;
  try {
    storage.setItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY, normalized);
    if (issuer) storage.setItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY, normalizedIssuer(issuer));
    else storage.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
    return normalized;
  } catch {
    return undefined;
  }
}

export function readPendingXpodAccountEmail(
  storage: Storage | undefined = optionalPersistentStorage(),
  issuer?: string,
): string | undefined {
  if (!storage) return undefined;
  try {
    const email = normalizedEmail(storage.getItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY));
    if (issuer) {
      const storedIssuer = storage.getItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
      if (!storedIssuer || storedIssuer !== normalizedIssuer(issuer)) {
        storage.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
        storage.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
        return undefined;
      }
    }
    if (!email) storage.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
    return email;
  } catch {
    return undefined;
  }
}

function normalizedIssuer(value: string): string {
  try {
    const origin = currentOrigin();
    return origin ? new URL(value, origin).origin : new URL(value).origin;
  } catch {
    return value.trim();
  }
}

export function mergeRememberedXpodAccount(
  remembered: RememberedXpodLogin,
  identity: SanitizedAccountIdentity | undefined,
  options: RememberXpodLoginOptions = {},
): RememberedXpodLogin | undefined {
  if (!identity) return remembered;
  const accountWebId = normalizedUrl(identity.webId);
  return rememberXpodLogin({
    ...remembered,
    account: {
      ...remembered.account,
      ...(normalizedText(identity.id) ? { id: normalizedText(identity.id) } : {}),
      ...(normalizedText(identity.username) ? { username: normalizedText(identity.username) } : {}),
      ...(normalizedText(identity.displayName) ? { displayName: normalizedText(identity.displayName) } : {}),
      ...(accountWebId ? { webId: accountWebId } : {}),
    },
  }, options);
}

function normalizeRememberedXpodLogin(value: unknown, origin: string | undefined): RememberedXpodLogin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as {
    account?: unknown;
    webId?: unknown;
    storageBinding?: unknown;
    routeId?: unknown;
  };
  if (candidate.routeId !== XPOD_LOGIN_ROUTE_ID) return undefined;
  if (!candidate.account || typeof candidate.account !== 'object') return undefined;
  if (!candidate.storageBinding || typeof candidate.storageBinding !== 'object') return undefined;

  const account = candidate.account as Record<string, unknown>;
  const binding = candidate.storageBinding as Record<string, unknown>;
  const email = normalizedEmail(account.email);
  const webId = normalizedUrl(candidate.webId);
  const bindingWebId = normalizedUrl(binding.webId);
  const storageUrl = normalizedUrl(binding.storageUrl, true);
  if (account.email !== undefined && !email) return undefined;
  if (!webId || !bindingWebId || !storageUrl || webId !== bindingWebId) return undefined;
  const avatarUrl = normalizedAvatarUrl(account.avatarUrl, [webId, storageUrl, origin]);

  return {
    account: {
      ...(email ? { email } : {}),
      ...(normalizedText(account.id) ? { id: normalizedText(account.id) } : {}),
      ...(normalizedText(account.username) ? { username: normalizedText(account.username) } : {}),
      ...(normalizedText(account.displayName) ? { displayName: normalizedText(account.displayName) } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    },
    webId,
    storageBinding: { webId, storageUrl },
    routeId: XPOD_LOGIN_ROUTE_ID,
  };
}

function normalizedEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim();
  return email && email.length <= 320 && email.includes('@') ? email : undefined;
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact ? Array.from(compact).slice(0, 160).join('') : undefined;
}

function normalizedUrl(value: unknown, asStorage = false): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    // The UI, Cloud identity and canonical Local Pod may have three origins.
    // Their ownership is checked by the live runtime, not this display cache.
    if (url.username || url.password) return undefined;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (asStorage) {
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizedAvatarUrl(value: unknown, sources: (string | undefined)[]): string | undefined {
  const avatarUrl = normalizedUrl(value);
  if (!avatarUrl) return undefined;
  const avatarOrigin = new URL(avatarUrl).origin;
  // Do not make the signed-out card contact unrelated image/tracking hosts.
  return sources.some((source) => {
    const url = normalizedUrl(source);
    return url && new URL(url).origin === avatarOrigin;
  }) ? avatarUrl : undefined;
}

function matchingOptionalEmail(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizedEmail(left)?.toLowerCase();
  const normalizedRight = normalizedEmail(right)?.toLowerCase();
  return !normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight;
}

function currentOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}
