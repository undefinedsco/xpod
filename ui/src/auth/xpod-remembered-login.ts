import { hasInvalidWebIdWhitespace } from './webid-validation';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import type { SanitizedAccountIdentity } from '../context/AuthContextValue';
import { XPOD_LOGIN_ROUTE_ID } from './xpod-login-route';

export const XPOD_REMEMBERED_LOGIN_KEY = 'xpod.remembered-login.v1';
export const XPOD_PENDING_ACCOUNT_EMAIL_KEY = 'xpod.pending-account-email.v1';
export const XPOD_PENDING_ACCOUNT_ISSUER_KEY = 'xpod.pending-account-issuer.v1';
export const XPOD_ACCOUNT_REMEMBER_CHOICE_KEY = 'xpod.account-remember-choice.v1';

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
  /** Public Account authority scope; never an authentication credential. */
  issuer?: string;
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
    const issuer = remembered.issuer ?? normalizedIssuer(options.origin ?? currentOrigin() ?? '');
    clearPendingEmailForIssuer(storage, issuer);
    clearPendingEmailForIssuer(optionalTemporaryStorage(), issuer);
    return remembered;
  } catch {
    return undefined;
  }
}

export function clearRememberedXpodLogin(storage: Storage | undefined = optionalPersistentStorage()): void {
  for (const target of [storage, optionalTemporaryStorage()]) {
    try {
      target?.removeItem(XPOD_REMEMBERED_LOGIN_KEY);
      target?.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
      target?.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
    } catch {
      // Clearing a convenience record remains best-effort during account switch.
    }
  }
}

export function rememberedXpodLoginMatchesActive(
  remembered: RememberedXpodLogin | undefined,
  active: RememberedXpodLoginActiveState,
): boolean {
  if (!remembered || !active.webId || !active.selectedStorage) return false;
  const rememberedWebId = validatedWebId(remembered.webId);
  const rememberedBindingWebId = validatedWebId(remembered.storageBinding.webId);
  const rememberedStorageUrl = normalizedUrl(remembered.storageBinding.storageUrl, true);
  const activeWebId = validatedWebId(active.webId);
  const activeBindingWebId = validatedWebId(active.selectedStorage.webId);
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

/** Undefined means no Account remember decision exists on this origin for this issuer. */
export function readXpodAccountRememberChoice(
  issuer?: string,
  storage: Storage | undefined = optionalPersistentStorage(),
): boolean | undefined {
  try {
    const choices = JSON.parse(storage?.getItem(XPOD_ACCOUNT_REMEMBER_CHOICE_KEY) ?? '{}');
    const choice = choices[normalizedIssuer(issuer ?? currentOrigin() ?? '')];
    return typeof choice === 'boolean' ? choice : undefined;
  } catch { return undefined; }
}

function optionalTemporaryStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

function clearPendingEmailForIssuer(storage: Storage | undefined, issuer: string): void {
  const previous = storage?.getItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
  if (!previous || previous === issuer) {
    storage?.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
    storage?.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
  }
}

export function rememberPendingXpodAccountEmail(
  email: string,
  storage: Storage | undefined = optionalPersistentStorage(),
  issuer?: string,
  remember = true,
  temporaryStorage: Storage | undefined = optionalTemporaryStorage(),
): string | undefined {
  const normalized = normalizedEmail(email);
  if (!normalized) return undefined;
  const scope = normalizedIssuer(issuer ?? currentOrigin() ?? '');
  try {
    const storedChoices = JSON.parse(storage?.getItem(XPOD_ACCOUNT_REMEMBER_CHOICE_KEY) ?? '{}');
    const choices = storedChoices && typeof storedChoices === 'object' && !Array.isArray(storedChoices) ? storedChoices : {};
    storage?.setItem(XPOD_ACCOUNT_REMEMBER_CHOICE_KEY, JSON.stringify({ ...choices, [scope]: remember }));
    if (!remember) {
      clearPendingEmailForIssuer(storage, scope);
      const previous = readRememberedXpodLogin({ storage });
      // Legacy records have no authority evidence; do not retain their Account hint.
      if (!previous?.issuer || previous.issuer === scope) storage?.removeItem(XPOD_REMEMBERED_LOGIN_KEY);
    }
    const target = remember ? storage : temporaryStorage;
    if (!target) return undefined;
    target.setItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY, normalized);
    target.setItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY, scope);
    if (remember) {
      clearPendingEmailForIssuer(temporaryStorage, scope);
    }
    return normalized;
  } catch { return undefined; }
}

export function readPendingXpodAccountEmail(
  storage: Storage | undefined = optionalPersistentStorage(),
  issuer?: string,
  temporaryStorage: Storage | undefined = optionalTemporaryStorage(),
): string | undefined {
  const source = readXpodAccountRememberChoice(issuer, storage) === false ? temporaryStorage : storage;
  if (!source) return undefined;
  try {
    const email = normalizedEmail(source.getItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY));
    if (issuer) {
      const storedIssuer = source.getItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
      if (!storedIssuer) {
        source.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
        source.removeItem(XPOD_PENDING_ACCOUNT_ISSUER_KEY);
        return undefined;
      }
      if (storedIssuer !== normalizedIssuer(issuer)) return undefined;
    }
    if (!email) source.removeItem(XPOD_PENDING_ACCOUNT_EMAIL_KEY);
    return email;
  } catch { return undefined; }
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
  const accountWebId = validatedWebId(identity.webId);
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
    issuer?: unknown;
  };
  if (candidate.routeId !== XPOD_LOGIN_ROUTE_ID) return undefined;
  if (candidate.issuer !== undefined && !normalizedUrl(candidate.issuer)) return undefined;
  if (!candidate.account || typeof candidate.account !== 'object') return undefined;
  if (!candidate.storageBinding || typeof candidate.storageBinding !== 'object') return undefined;

  const account = candidate.account as Record<string, unknown>;
  const binding = candidate.storageBinding as Record<string, unknown>;
  const email = normalizedEmail(account.email);
  const webId = validatedWebId(candidate.webId);
  const bindingWebId = validatedWebId(binding.webId);
  const storageUrl = normalizedUrl(binding.storageUrl, true);
  if (account.email !== undefined && !email) return undefined;
  if (!webId || !bindingWebId || !storageUrl || webId !== bindingWebId) return undefined;
  const avatarUrl = normalizedAvatarUrl(account.avatarUrl, [webId, storageUrl, origin]);

  return {
    ...(typeof candidate.issuer === 'string' ? { issuer: normalizedIssuer(candidate.issuer) } : {}),
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

// Validation must not turn distinct WebID strings into the same identity.
function validatedWebId(value: unknown): string | undefined {
  return typeof value === 'string' && !hasInvalidWebIdWhitespace(value) && normalizedUrl(value) ? value : undefined;
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
