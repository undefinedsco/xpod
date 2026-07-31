import { Session } from '@inrupt/solid-client-authn-browser';
import {
  createPodRuntime,
  createSolidSessionRuntime,
  type OpenPodRuntime,
  type PodRuntime,
  type SolidSessionAdapter,
  type SolidSessionRuntime,
  type SolidSessionSnapshot,
} from '@undefineds.co/solid-sdk';
import { drizzle, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { createContext, useContext } from 'react';
import { ensureTrailingSlash, fetchProfileStorageUrls } from '../utils/provision-scope';

export const XPOD_LAST_OIDC_ISSUER_STORAGE_KEY = 'xpod.solid.lastOidcIssuer';

export type XpodSolidRuntimeState =
  | { status: 'loading'; webId?: undefined; podUrl?: undefined; issuer?: string; error?: undefined }
  | { status: 'anonymous'; webId?: undefined; podUrl?: undefined; issuer?: string; error?: undefined }
  | { status: 'authenticated'; webId: string; podUrl?: string; issuer?: string; error?: undefined }
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
  login(issuer: string): Promise<void>;
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
export const initializedRuntimes = new WeakSet<XpodSolidRuntimeCore>();

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
    webId: snapshot.webId,
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
  const storageUrl = storageUrls[0];
  if (!storageUrl) {
    throw new Error('WebID profile does not declare a Solid storage URL');
  }
  return ensureTrailingSlash(new URL(storageUrl).toString());
}

export function createXpodSolidRuntimeValue(
  options: CreateXpodSolidRuntimeOptions = {},
): XpodSolidRuntimeCore {
  const sessionAdapter = options.sessionFactory?.() ?? new Session();
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
      discoverPod: ({ webId, fetch }) => discoverPodUrlFromWebId({ webId, fetch }),
      openDatabase: ({ podUrl }) => drizzle(authSession, {
        podUrl,
        autoConnect: false,
        resourcePreparation: 'off',
      }),
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

function writeStoredOidcIssuer(issuer: string): void {
  try {
    globalThis.window?.sessionStorage.setItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY, issuer);
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}
