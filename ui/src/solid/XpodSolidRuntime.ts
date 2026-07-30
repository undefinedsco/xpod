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

export type XpodSolidRuntimeState =
  | { status: 'loading'; webId?: undefined; podUrl?: undefined; error?: undefined }
  | { status: 'anonymous'; webId?: undefined; podUrl?: undefined; error?: undefined }
  | { status: 'authenticated'; webId: string; podUrl?: string; error?: undefined }
  | { status: 'error'; webId?: string; podUrl?: string; error: Error };

export interface XpodSolidRuntimeValue {
  readonly session: SolidSessionRuntime;
  readonly pod: PodRuntime<SolidDatabase>;
  readonly fetch: typeof fetch;
  readonly state: XpodSolidRuntimeState;
  readonly webId?: string;
  readonly podUrl?: string;
  readonly currentPod?: OpenPodRuntime<SolidDatabase>;
  login(issuer: string): Promise<void>;
  logout(): Promise<void>;
}

export interface XpodSolidRuntimeCore {
  readonly session: SolidSessionRuntime;
  readonly pod: PodRuntime<SolidDatabase>;
}

export interface CreateXpodSolidRuntimeOptions {
  sessionFactory?: () => SolidSessionAdapter;
}

export const XpodSolidRuntimeContext = createContext<XpodSolidRuntimeValue | null>(null);
export const initializedRuntimes = new WeakSet<XpodSolidRuntimeCore>();

export function snapshotToState(
  snapshot: SolidSessionSnapshot,
  currentPod?: OpenPodRuntime<SolidDatabase>,
): XpodSolidRuntimeState {
  if (snapshot.status === 'initializing') {
    return { status: 'loading' };
  }
  if (snapshot.status === 'anonymous') {
    return { status: 'anonymous' };
  }
  if (snapshot.status === 'error') {
    return {
      status: 'error',
      webId: snapshot.webId,
      error: snapshot.error,
      podUrl: currentPod?.podUrl,
    };
  }
  return {
    status: 'authenticated',
    webId: snapshot.webId,
    podUrl: currentPod?.podUrl,
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

  return { session, pod };
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
