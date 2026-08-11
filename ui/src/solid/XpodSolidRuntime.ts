import { EVENTS, Session } from '@inrupt/solid-client-authn-browser';
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
import { aiProviderResource, credentialResource } from '@undefineds.co/models';
import type { AiClientConfigurationCapability } from '@undefineds.co/extension-sdk/web';
import { createContext, useContext } from 'react';
import { ensureTrailingSlash, fetchProfileStorageUrls } from '../utils/provision-scope';
import { canonicalProductPathname, surfaceForPathname } from '../routes/canonical-routes';

export const XPOD_LAST_OIDC_ISSUER_STORAGE_KEY = 'xpod.solid.lastOidcIssuer';
export const XPOD_OIDC_CLIENT_STORAGE_KEY = 'xpod.solid.oidcClient';
const XPOD_SOLID_RETURN_TO_STORAGE_KEY = 'xpod.solid.returnTo';
const XPOD_OIDC_REDIRECT_PATHS = ['/ai-connections/', '/ai-config/', '/settings/', '/status/', '/network/', '/dashboard/'] as const;
const sessionRestoreListeners = new WeakSet<SolidSessionAdapter>();

export interface XpodOidcClientRegistration {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

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
  readonly aiClientConfiguration?: Pick<AiClientConfigurationCapability, 'available' | 'authority' | 'manualInstructions'>;
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

export function currentXpodSurfaceRedirectUrl(): string {
  const pathname = canonicalProductPathname(window.location.pathname);
  return `${window.location.origin}${surfaceForPathname(pathname).basename}/`;
}

export function xpodOidcRedirectUris(origin = window.location.origin): string[] {
  return XPOD_OIDC_REDIRECT_PATHS.map((path) => `${origin}${path}`);
}

export function syncStoredOidcRedirectUrl(redirectUrl = currentXpodSurfaceRedirectUrl()): void {
  try {
    const sessionId = window.localStorage.getItem('solidClientAuthn:currentSession');
    if (!sessionId) return;
    const key = `solidClientAuthenticationUser:${sessionId}`;
    const stored = window.localStorage.getItem(key);
    if (!stored) return;
    const record = JSON.parse(stored) as Record<string, unknown>;
    if (typeof record.clientId !== 'string' || typeof record.redirectUrl !== 'string') return;
    if (record.redirectUrl === redirectUrl) return;
    window.localStorage.setItem(key, JSON.stringify({ ...record, redirectUrl }));
  } catch {
    return;
  }
}

export async function ensureXpodOidcClient(issuer: string): Promise<XpodOidcClientRegistration | undefined> {
  const normalizedIssuer = normalizeXpodOidcIssuer(issuer);
  if (!normalizedIssuer || typeof window === 'undefined') return undefined;
  if (new URL(normalizedIssuer).origin !== window.location.origin) return undefined;
  const redirectUris = xpodOidcRedirectUris();
  const cached = readStoredOidcClient();
  if (cached?.issuer === normalizedIssuer && sameStringSet(cached.redirectUris, redirectUris)) {
    return cached;
  }

  try {
    const configurationUrl = new URL('/.well-known/openid-configuration', normalizedIssuer);
    const configurationResponse = await fetch(configurationUrl);
    if (!configurationResponse.ok) return undefined;
    const configuration = await configurationResponse.json() as {
      registration_endpoint?: string;
      id_token_signing_alg_values_supported?: string[];
    };
    if (!configuration.registration_endpoint) return undefined;
    const signingAlg = configuration.id_token_signing_alg_values_supported?.includes('ES256')
      ? 'ES256'
      : configuration.id_token_signing_alg_values_supported?.[0];
    const registrationResponse = await fetch(new URL(configuration.registration_endpoint, normalizedIssuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Xpod',
        application_type: 'web',
        redirect_uris: redirectUris,
        subject_type: 'public',
        token_endpoint_auth_method: 'client_secret_basic',
        ...(signingAlg ? { id_token_signed_response_alg: signingAlg } : {}),
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    });
    if (!registrationResponse.ok) return undefined;
    const registration = await registrationResponse.json() as { client_id?: string; client_secret?: string };
    if (!registration.client_id || !registration.client_secret) return undefined;
    const client = {
      issuer: normalizedIssuer,
      clientId: registration.client_id,
      clientSecret: registration.client_secret,
      redirectUris,
    };
    window.localStorage.setItem(XPOD_OIDC_CLIENT_STORAGE_KEY, JSON.stringify(client));
    return client;
  } catch {
    return undefined;
  }
}

export function persistSolidLoginReturnTo(url: string): void {
  try {
    window.sessionStorage.setItem(XPOD_SOLID_RETURN_TO_STORAGE_KEY, url);
  } catch {
    return;
  }
}

export function restoreSolidLoginReturnTo(): void {
  try {
    const target = window.sessionStorage.getItem(XPOD_SOLID_RETURN_TO_STORAGE_KEY);
    if (!target) return;
    window.sessionStorage.removeItem(XPOD_SOLID_RETURN_TO_STORAGE_KEY);
    navigateToClientUrl(target);
  } catch {
    return;
  }
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
  attachSessionRestoreListener(sessionAdapter);
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

function attachSessionRestoreListener(session: SolidSessionAdapter): void {
  if (sessionRestoreListeners.has(session) || typeof window === 'undefined') return;
  sessionRestoreListeners.add(session);
  session.events.on(EVENTS.SESSION_RESTORED, navigateToClientUrl);
}

function navigateToClientUrl(value: unknown): void {
  try {
    if (typeof value !== 'string' || typeof window === 'undefined') return;
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return;
    const nextPath = `${target.pathname}${target.search}${target.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextPath) return;
    const currentSurface = surfaceForPathname(canonicalProductPathname(window.location.pathname)).basename;
    const targetSurface = surfaceForPathname(canonicalProductPathname(target.pathname)).basename;
    if (currentSurface !== targetSurface) {
      window.location.assign(target.toString());
      return;
    }
    window.history.pushState(null, '', nextPath);
    window.dispatchEvent(new Event('popstate'));
  } catch {
    return;
  }
}

export function markOidcClientAsNonExpiring(clientId: string): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith('solidClientAuthenticationUser:')) continue;
      const stored = window.localStorage.getItem(key);
      if (!stored) continue;
      const record = JSON.parse(stored) as Record<string, unknown>;
      if (record.clientId !== clientId) continue;
      window.localStorage.setItem(key, JSON.stringify({ ...record, expiresAt: '0' }));
    }
  } catch {
    return;
  }
}

function readStoredOidcClient(): XpodOidcClientRegistration | undefined {
  try {
    const stored = window.localStorage.getItem(XPOD_OIDC_CLIENT_STORAGE_KEY);
    if (!stored) return undefined;
    const value = JSON.parse(stored) as Partial<XpodOidcClientRegistration>;
    if (
      typeof value.issuer !== 'string'
      || typeof value.clientId !== 'string'
      || typeof value.clientSecret !== 'string'
      || !Array.isArray(value.redirectUris)
      || value.redirectUris.some((uri) => typeof uri !== 'string')
    ) {
      return undefined;
    }
    return value as XpodOidcClientRegistration;
  } catch {
    return undefined;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
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
