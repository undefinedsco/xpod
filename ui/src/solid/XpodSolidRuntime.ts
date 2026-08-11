import { Session } from '@inrupt/solid-client-authn-browser';
import {
  createPodRuntime,
  createSolidSessionRuntime,
  type OpenPodRuntime,
  type PodRuntime,
  type SolidSessionAdapter,
  type SolidSessionRuntime,
  type SolidSessionSnapshot,
  type StorageBinding,
  normalizeWebIdLoginTransaction,
  type WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import { drizzle, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiProviderResource, credentialResource } from '@undefineds.co/models';
import type { AiClientConfigurationCapability } from '@undefineds.co/extension-sdk/web';
import { createContext, useContext } from 'react';
import { ensureTrailingSlash, fetchProfileStorageUrls } from '../utils/provision-scope';
import { assertXpodLoginRoute, normalizeXpodReturnTo } from '../auth/xpod-login-route';

export const XPOD_LAST_OIDC_ISSUER_STORAGE_KEY = 'xpod.solid.lastOidcIssuer';
export const XPOD_SOLID_SESSION_ID_STORAGE_KEY = 'xpod.solid.sessionId';

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
  readonly aiClientConfiguration?: Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>;
  readonly accountClientCredentialsUrl?: string;
  login(transaction: WebIdLoginTransaction): Promise<void>;
  logout(): Promise<void>;
}

export interface XpodSolidRuntimeCore {
  readonly session: SolidSessionRuntime;
  readonly pod: PodRuntime<SolidDatabase>;
  getIssuer(): string | undefined;
  setIssuer(issuer: string | undefined): void;
}

export interface CreateXpodSolidRuntimeOptions {
  sessionFactory?: () => SolidSessionAdapter;
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
  const sessionAdapter = options.sessionFactory?.() ?? createInruptSession();
  let lastIssuer = readIssuerFromSessionInfo(sessionAdapter.info) ?? readStoredOidcIssuer();
  const session = createSolidSessionRuntime({ session: sessionAdapter });
  const authSession: SolidAuthSession = {
    get info() {
      return sessionAdapter.info;
    },
    fetch: sessionAdapter.fetch,
  };
  const pod = createPodRuntime<SolidDatabase>({
    adapter: {
      // Xpod storage is selected from an Account-owned binding before a Pod
      // session opens. Keep the SDK adapter explicit so a WebID-only call
      // cannot silently discover and choose the first profile storage.
      discoverPod: () => {
        throw new Error('Explicit Xpod storage binding is required to open a Pod');
      },
      openDatabase: ({ podUrl }) => drizzle(authSession, {
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
    getIssuer: () => readIssuerFromSessionInfo(sessionAdapter.info) ?? lastIssuer ?? readStoredOidcIssuer(),
    setIssuer: (issuer) => {
      const normalized = normalizeXpodOidcIssuer(issuer);
      lastIssuer = normalized;
      if (normalized) {
        writeStoredOidcIssuer(normalized);
      }
    },
  };
}

function createInruptSession(): Session {
  let sessionId: string | undefined;
  try {
    sessionId = globalThis.window?.sessionStorage.getItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY) ?? undefined;
    if (!sessionId) {
      sessionId = globalThis.crypto?.randomUUID?.() ?? `xpod-${Date.now().toString(36)}`;
      globalThis.window?.sessionStorage.setItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY, sessionId);
    }
  } catch {
    // Inrupt will generate a session id when browser storage is unavailable.
  }
  return new Session({}, sessionId);
}

let defaultRuntime: XpodSolidRuntimeCore | undefined;

export function getXpodSolidRuntimeValue(): XpodSolidRuntimeCore {
  defaultRuntime ??= createXpodSolidRuntimeValue();
  return defaultRuntime;
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

function readStoredOidcIssuer(): string | undefined {
  try {
    return normalizeXpodOidcIssuer(globalThis.window?.sessionStorage.getItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Clear the host-only issuer hint after a verified WebID logout. */
export function clearStoredXpodOidcIssuer(): void {
  try {
    globalThis.window?.sessionStorage.removeItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY);
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}

function writeStoredOidcIssuer(issuer: string): void {
  try {
    globalThis.window?.sessionStorage.setItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY, issuer);
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}
