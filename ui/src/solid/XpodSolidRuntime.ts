import { Session } from '@inrupt/solid-client-authn-browser';
import type { IStorage } from '@inrupt/solid-client-authn-core';
import {
  createPodRuntime,
  createSolidLocalRouteFetch,
  createSolidSessionRuntime,
  type OpenPodRuntime,
  type PodRuntime,
  type SolidSessionAdapter,
  type SolidLocalRoute,
  type SolidSessionRuntime,
  type SolidSessionSnapshot,
  type StorageBinding,
  normalizeWebIdLoginTransaction,
  type WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import { drizzle, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiProviderResource, credentialResource } from '@undefineds.co/models';
import type { AiClientConfigurationCapability } from '@undefineds.co/extension-sdk/web';
import { createContext, useContext } from 'react';
import { ensureTrailingSlash, fetchProfileStorageUrls } from '../utils/provision-scope';
import { assertXpodLoginRoute, normalizeXpodReturnTo } from '../auth/xpod-login-route';

export const XPOD_LAST_OIDC_ISSUER_STORAGE_KEY = 'xpod.solid.lastOidcIssuer';
export const XPOD_SOLID_SESSION_ID_STORAGE_KEY = 'xpod.solid.sessionId';
export const INRUPT_CURRENT_SESSION_STORAGE_KEY = 'solidClientAuthn:currentSession';
const INRUPT_SESSION_STORAGE_KEY_PREFIX = 'solidClientAuthenticationUser:';
export const XPOD_INRUPT_STORAGE_KEY_PREFIX = 'xpod.inrupt.';
const INRUPT_DYNAMIC_CLIENT_FIELDS = [
  'clientId',
  'clientSecret',
  'clientName',
  'clientType',
  'expiresAt',
  'idTokenSignedResponseAlg',
] as const;
type XpodInruptStorageNamespace = 'secure' | 'insecure';
const INRUPT_STORAGE_NAMESPACES = ['secure', 'insecure'] as const satisfies readonly XpodInruptStorageNamespace[];

export type XpodSolidRuntimeState =
  | { status: 'loading'; webId?: undefined; podUrl?: undefined; issuer?: string; error?: undefined }
  | { status: 'anonymous'; webId?: undefined; podUrl?: undefined; issuer?: string; error?: undefined }
  | { status: 'authenticated'; webId: string; podUrl?: string; issuer?: string; error?: undefined }
  | { status: 'expired'; webId?: string; podUrl?: string; issuer?: string; error?: undefined }
  | { status: 'error'; webId?: string; podUrl?: string; issuer?: string; error: Error };

export interface XpodSolidRuntimeValue {
  readonly session: SolidSessionRuntime;
  readonly pod: PodRuntime<SolidDatabase>;
  readonly fetch: typeof fetch;
  readonly state: XpodSolidRuntimeState;
  readonly webId?: string;
  readonly podUrl?: string;
  readonly issuer?: string;
  readonly currentPod?: OpenPodRuntime<SolidDatabase>;
  readonly selectedStorage?: StorageBinding;
  /**
   * Pod open/binding failure scoped to the authenticated WebID. Kept out of
   * `state` on purpose: a Pod failure must not be misread as a WebID login
   * failure, so boundaries retry Pod opening instead of a full OIDC login.
   */
  readonly podError?: { readonly webId: string; readonly error: Error };
  /** Re-runs the Pod open effect after a `podError`. */
  retryPodOpen?(): void;
  readonly aiClientConfiguration?: Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>;
  readonly accountClientCredentialsUrl?: string;
  login(transaction: WebIdLoginTransaction): Promise<void>;
  logout(): Promise<void>;
}

export interface XpodSolidRuntimeCore {
  readonly session: SolidSessionRuntime;
  readonly pod: PodRuntime<SolidDatabase>;
  readonly storage: XpodSolidRuntimeStoragePolicy;
  getIssuer(): string | undefined;
  getExpectedIssuer?(): string | undefined;
  setIssuer(issuer: string | undefined): void;
  setLocalPodRoute(route: { canonicalBaseUrl: string; localBaseUrl: string } | undefined): void;
}

export interface XpodSolidRuntimeStoragePolicy {
  /** Stable host hint for Inrupt's session id. */
  sessionId?: Storage;
  /** Inrupt-owned OIDC records, including the refresh token used after an app restart. */
  oidcSession?: Storage;
  /** Public same-origin OIDC issuer hint used to reject foreign restored sessions. */
  issuer?: Storage;
  /** Public selected WebID + Pod storage binding. */
  selectedStorage?: Storage;
}

export interface CreateXpodSolidRuntimeOptions {
  /** The session signs canonical URLs, then sends them through this transport. */
  sessionFactory?: (options: { fetch: typeof globalThis.fetch }) => SolidSessionAdapter;
  storage?: Partial<XpodSolidRuntimeStoragePolicy>;
}

export const XpodSolidRuntimeContext = createContext<XpodSolidRuntimeValue | null>(null);

export function snapshotToState(
  snapshot: SolidSessionSnapshot,
  currentPod?: OpenPodRuntime<SolidDatabase>,
  issuer?: string,
): XpodSolidRuntimeState {
  if (snapshot.status === 'initializing') {
    return { status: 'loading', issuer };
  }
  if (snapshot.status === 'anonymous') {
    return { status: 'anonymous', issuer };
  }
  if (snapshot.status === 'expired') {
    return { status: 'expired', webId: snapshot.webId, issuer };
  }
  if (snapshot.status === 'error') {
    return {
      status: 'error',
      webId: snapshot.webId,
      error: snapshot.error,
      podUrl: currentPod?.podUrl,
      issuer,
    };
  }
  return {
    status: 'authenticated',
    webId: snapshot.webId!,
    podUrl: currentPod?.podUrl,
    issuer,
  };
}

export async function discoverPodUrlFromWebId({
  webId,
  fetch,
}: {
  webId: string;
  fetch: typeof globalThis.fetch;
}): Promise<string> {
  const storageUrls = await fetchProfileStorageUrls(fetch, webId);
  if (storageUrls.length !== 1) {
    throw new Error(storageUrls.length === 0
      ? 'WebID profile does not declare a Solid storage URL'
      : 'WebID profile declares multiple Solid storage URLs; choose an explicit Account binding');
  }
  return ensureTrailingSlash(new URL(storageUrls.at(0)!).toString());
}

export function createXpodSolidRuntimeValue(
  options: CreateXpodSolidRuntimeOptions = {},
): XpodSolidRuntimeCore {
  const storage = createXpodSolidRuntimeStoragePolicy(options.storage);
  let localRoutes: readonly SolidLocalRoute[] = [];
  const transport = createSolidLocalRouteFetch({
    fetch: globalThis.fetch,
    routes: () => localRoutes,
  });
  // Route below Inrupt's signer, never around Session.fetch: changing the URL
  // before signing binds the proof to the dev proxy rather than the Pod.
  const sessionAdapter = options.sessionFactory?.({ fetch: transport })
    ?? createInruptSession(storage.sessionId, storage.oidcSession, transport);
  let lastIssuer = readStoredOidcIssuer(storage.issuer);
  const baseSession = createSolidSessionRuntime({ session: sessionAdapter });
  const handleIncomingRedirect = baseSession.handleIncomingRedirect;
  const rememberAcceptedSession = (nextSnapshot: SolidSessionSnapshot): SolidSessionSnapshot => {
    const nextIssuer = readIssuerFromSessionInfo(sessionAdapter.info) ?? lastIssuer ?? readStoredOidcIssuer(storage.issuer);
    const expectedIssuer = lastIssuer ?? expectedSameOriginIssuer(nextIssuer);
    if (nextSnapshot.status === 'authenticated'
      && isCurrentXpodSessionSnapshot(nextSnapshot, nextIssuer, expectedIssuer)) {
      rememberInruptCurrentSession(storage);
    }
    return nextSnapshot;
  };
  const session: SolidSessionRuntime = {
    ...baseSession,
    initialize: async (initializeOptions) => rememberAcceptedSession(await baseSession.initialize(initializeOptions)),
    ...(handleIncomingRedirect
      ? { handleIncomingRedirect: async (url) => rememberAcceptedSession(await handleIncomingRedirect(url)) }
      : {}),
  };
  const pod = createPodRuntime<SolidDatabase>({
    adapter: {
      // Xpod storage is selected from an Account-owned binding before a Pod
      // session opens. Keep the SDK adapter explicit so a WebID-only call
      // cannot silently discover and choose the first profile storage.
      discoverPod: () => {
        throw new Error('Explicit Xpod storage binding is required to open a Pod');
      },
      openDatabase: ({ podUrl, fetch }) => drizzle({
        get info() {
          return sessionAdapter.info
        },
        fetch,
      }, {
        podUrl,
        schema: {
          aiProvider: aiProviderResource,
          credential: credentialResource,
        },
        autoConnect: false,
        resourcePreparation: 'off',
      }) as unknown as SolidDatabase,
      hydrateCollections: () => undefined,
    },
  });

  return {
    session,
    pod,
    storage,
    getIssuer: () => readIssuerFromSessionInfo(sessionAdapter.info) ?? lastIssuer ?? readStoredOidcIssuer(storage.issuer),
    getExpectedIssuer: () => lastIssuer ?? expectedSameOriginIssuer(readIssuerFromSessionInfo(sessionAdapter.info)),
    setIssuer: (issuer) => {
      const normalized = normalizeXpodOidcIssuer(issuer);
      lastIssuer = normalized;
      if (normalized) {
        writeStoredOidcIssuer(normalized, storage.issuer);
      }
    },
    setLocalPodRoute: (route) => {
      // The caller has verified this Pod is hosted by the current Xpod.
      // Service APIs share its canonical origin, but are outside the Pod path.
      // Keep explicit prefixes: do not route other Pods or IdP endpoints here.
      localRoutes = route ? [route, ...['/api/', '/v1/'].map((prefix) => ({
        canonicalBaseUrl: new URL(prefix, route.canonicalBaseUrl).href,
        localBaseUrl: new URL(prefix, route.localBaseUrl).href,
      }))] : [];
    },
  };
}

function createInruptSession(
  sessionIdStorage = getOptionalPersistentStorage(),
  oidcSessionStorage = getOptionalPersistentStorage(),
  transport = globalThis.fetch,
): Session {
  let sessionId: string | undefined;
  try {
    sessionId = sessionIdStorage?.getItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY) ?? undefined;
    if (!sessionId) {
      sessionId = globalThis.crypto?.randomUUID?.() ?? `xpod-${Date.now().toString(36)}`;
      sessionIdStorage?.setItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY, sessionId);
    }
  } catch {
    // Inrupt will generate a session id when browser storage is unavailable.
  }
  const persistentStorage = sessionIdStorage ?? getOptionalPersistentStorage();
  for (const candidate of new Set([oidcSessionStorage, persistentStorage].filter(Boolean))) {
    migrateLegacyInruptSessionRecords(candidate);
  }
  return oidcSessionStorage
    ? new Session({
      // Inrupt owns PKCE, access-token and refresh-token records. Xpod keeps
      // the SDK's secure store persistent so a still-valid refresh token can
      // restore the WebID session after the desktop process restarts.
      secureStorage: toInruptStorage(oidcSessionStorage, 'secure'),
      insecureStorage: toInruptStorage(persistentStorage ?? oidcSessionStorage, 'insecure'),
      fetch: transport,
    }, sessionId)
    : new Session({ fetch: transport }, sessionId);
}

export function toInruptStorage(
  storage: Storage,
  namespace?: XpodInruptStorageNamespace,
): IStorage {
  const storageKey = (key: string): string => namespace ? inruptStorageKey(namespace, key) : key;
  return {
    get: async (key) => storage.getItem(storageKey(key)) ?? undefined,
    set: async (key, value) => { storage.setItem(storageKey(key), value); },
    delete: async (key) => { storage.removeItem(storageKey(key)); },
  };
}

function inruptStorageKey(namespace: XpodInruptStorageNamespace, key: string): string {
  return `${XPOD_INRUPT_STORAGE_KEY_PREFIX}${namespace}:${key}`;
}

function migrateLegacyInruptSessionRecords(storage?: Storage): void {
  if (!storage) return;
  try {
    const legacyKeys = storageKeys(storage)
      .filter((key) => key.startsWith(INRUPT_SESSION_STORAGE_KEY_PREFIX));
    for (const legacyKey of legacyKeys) {
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      for (const namespace of INRUPT_STORAGE_NAMESPACES) {
        const targetKey = inruptStorageKey(namespace, legacyKey);
        if (storage.getItem(targetKey) === null) {
          storage.setItem(targetKey, value);
        }
      }
      storage.removeItem(legacyKey);
    }
  } catch {
    // A failed migration leaves the old storage untouched; Inrupt can still
    // create a fresh login record instead of blocking the app shell.
  }
}

let defaultRuntime: XpodSolidRuntimeCore | undefined;

export function getXpodSolidRuntimeValue(): XpodSolidRuntimeCore {
  defaultRuntime ??= createXpodSolidRuntimeValue();
  return defaultRuntime;
}

/**
 * Forget only Inrupt's cached dynamic client registration before an explicit
 * login. A local CSS restart can remove its registration database while the
 * browser still considers the cached client valid. Keeping that client would
 * send the user to CSS's "unknown client" error page, where the app cannot
 * recover because the redirect never reaches our callback.
 */
export function clearCachedInruptDynamicClientRegistration(
  storagePolicy: Pick<XpodSolidRuntimeStoragePolicy, 'sessionId' | 'oidcSession'>,
): void {
  const storage = storagePolicy.oidcSession;
  if (!storage) return;

  // Inrupt may have generated an older session id before Xpod began persisting
  // its stable host id. Clear registration fields from every Inrupt-owned
  // record on this app origin so such a migrated record cannot win lookup.
  const keys = storageKeys(storage).filter(isInruptSessionStorageRecordKey);
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as Record<string, unknown>;
      for (const field of INRUPT_DYNAMIC_CLIENT_FIELDS) delete record[field];
      storage.setItem(key, JSON.stringify(record));
    } catch {
      // Corrupt SDK state cannot be repaired field-by-field. Removing this one
      // Inrupt-owned record lets the SDK rebuild it without touching app data.
      storage.removeItem(key);
    }
  }
}

/**
 * Inrupt browser 3.1.1 keeps the silent-restore session pointer outside its
 * injected storage adapters, directly in window.localStorage. It writes that
 * pointer only for LOGIN, not for SESSION_RESTORED, so Xpod anchors the same
 * stable session id after accepting an authenticated snapshot.
 */
export function rememberInruptCurrentSession(
  storagePolicy: Pick<XpodSolidRuntimeStoragePolicy, 'sessionId'>,
): void {
  try {
    const sessionId = storagePolicy.sessionId?.getItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY);
    if (!sessionId) return;
    getOptionalPersistentStorage()?.setItem(INRUPT_CURRENT_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}

export async function resolveXpodLoginIssuer(
  fallbackIssuer: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  return (await resolveXpodLoginContext(fallbackIssuer, fetchImpl)).oidcIssuer;
}

export interface XpodLoginContext {
  oidcIssuer?: string;
  provisionCode?: string;
}

export function withXpodProvisionScope(authorizationUrl: string, provisionCode: string): string {
  const redirectUrl = new URL(authorizationUrl);
  if (provisionCode?.trim()) {
    redirectUrl.searchParams.set('provisionCode', provisionCode.trim());
  }
  return redirectUrl.toString();
}

export async function resolveXpodLoginContext(
  fallbackIssuer: string,
  fetchImpl: typeof fetch,
): Promise<XpodLoginContext> {
  try {
    const response = await fetchImpl('/provision/status', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (response.ok) {
      const status = await response.json() as { oidcIssuer?: unknown; provisionCode?: unknown };
      const provisionedIssuer = normalizeXpodOidcIssuer(status.oidcIssuer);
      if (provisionedIssuer) {
        return {
          oidcIssuer: provisionedIssuer,
          provisionCode: typeof status.provisionCode === 'string' && status.provisionCode.trim()
            ? status.provisionCode.trim()
            : undefined,
        };
      }
    }
  } catch {
    // Standalone and non-Local hosts have no provisioning endpoint.
  }
  return { oidcIssuer: normalizeXpodOidcIssuer(fallbackIssuer) };
}

function isInruptSessionStorageRecordKey(key: string): boolean {
  if (key.startsWith(INRUPT_SESSION_STORAGE_KEY_PREFIX)) return true;
  return INRUPT_STORAGE_NAMESPACES.some((namespace) =>
    key.startsWith(`${XPOD_INRUPT_STORAGE_KEY_PREFIX}${namespace}:${INRUPT_SESSION_STORAGE_KEY_PREFIX}`));
}

function storageKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key));
}

export function safeAuthError(error: Error): Error {
  if (error.message === 'Solid session expired') {
    return error;
  }
  return new Error('Solid login failed. Please reconnect your Pod.');
}

export function normalizeXpodLoginTransaction(
  input: WebIdLoginTransaction,
  origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
): WebIdLoginTransaction {
  if (!input || typeof input !== 'object') {
    throw new TypeError('Xpod login requires a validated WebID transaction');
  }
  const normalized = normalizeWebIdLoginTransaction(input);
  const route = assertXpodLoginRoute(normalized.route, origin);
  const returnTo = normalizeXpodReturnTo(normalized.returnTo);
  return {
    ...normalized,
    route,
    authorizationSurface: 'redirect',
    discovery: 'strict',
    ...(returnTo === undefined ? {} : { returnTo }),
  };
}

export function useXpodSolidRuntimeContext(): XpodSolidRuntimeValue {
  const value = useContext(XpodSolidRuntimeContext);
  if (!value) {
    throw new Error('useXpodSolidRuntime must be used within XpodSolidRuntimeProvider');
  }
  return value;
}

function readIssuerFromSessionInfo(info: SolidSessionAdapter['info']): string | undefined {
  const issuer = (info as { issuer?: unknown; oidcIssuer?: unknown }).issuer
    ?? (info as { issuer?: unknown; oidcIssuer?: unknown }).oidcIssuer;
  return normalizeXpodOidcIssuer(issuer);
}

export function normalizeXpodOidcIssuer(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }
    if (url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isCurrentXpodSessionSnapshot(
  snapshot: SolidSessionSnapshot,
  issuer: string | undefined,
  expectedIssuer: string | undefined,
): boolean {
  if (snapshot.status !== 'authenticated') return true;
  // The OIDC issuer authenticates the WebID. Solid deliberately allows the
  // WebID and its storage to live on origins that differ from the IdP, so the
  // WebID host is not an authentication boundary. Compare the SDK-reported
  // issuer with the issuer selected before redirect instead.
  const normalizedIssuer = normalizeXpodOidcIssuer(issuer);
  const normalizedExpectedIssuer = normalizeXpodOidcIssuer(expectedIssuer);
  if (!normalizedIssuer || !normalizedExpectedIssuer || normalizedIssuer !== normalizedExpectedIssuer) {
    return false;
  }
  return isHttpResourceUrl(snapshot.webId);
}

function expectedSameOriginIssuer(
  issuer: string | undefined,
  origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
): string | undefined {
  const normalizedIssuer = normalizeXpodOidcIssuer(issuer);
  return normalizedIssuer && hasOrigin(normalizedIssuer, origin) ? normalizedIssuer : undefined;
}

function hasOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function isHttpResourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function readStoredOidcIssuer(storage = getOptionalPersistentStorage()): string | undefined {
  try {
    return normalizeXpodOidcIssuer(storage?.getItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Clear the host-only issuer hint after a verified WebID logout. */
export function clearStoredXpodOidcIssuer(storage?: Storage): void {
  try {
    storage?.removeItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY);
    getOptionalPersistentStorage()?.removeItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY);
    getOptionalSessionStorage()?.removeItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}

function writeStoredOidcIssuer(issuer: string, storage = getOptionalPersistentStorage()): void {
  try {
    storage?.setItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY, issuer);
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}

function createXpodSolidRuntimeStoragePolicy(
  storage: Partial<XpodSolidRuntimeStoragePolicy> = {},
): XpodSolidRuntimeStoragePolicy {
  const persistent = getOptionalPersistentStorage();
  return {
    sessionId: storage.sessionId ?? persistent,
    oidcSession: storage.oidcSession ?? persistent,
    issuer: storage.issuer ?? persistent,
    selectedStorage: storage.selectedStorage ?? persistent,
  };
}

function getOptionalPersistentStorage(): Storage | undefined {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
  return undefined;
}

function getOptionalSessionStorage(): Storage | undefined {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
  return undefined;
}
