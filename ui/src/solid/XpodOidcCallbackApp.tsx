/* eslint-disable react-refresh/only-export-components */

import type {
  OpenPodRuntime,
  SolidSessionSnapshot,
  StorageBinding,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { assertXpodLoginRoute, normalizeXpodReturnTo } from '../auth/xpod-login-route';
import {
  clearXpodSelectedStorage,
  createXpodLoginTransactionStore,
  rememberXpodSelectedStorage,
  type XpodLoginTransactionError,
  type XpodLoginTransactionStore,
} from '../auth/xpod-login-transaction';
import { createXpodSolidRuntimeValue, type XpodSolidRuntimeCore } from './XpodSolidRuntime';

export type XpodOidcCallbackFailureCode =
  | 'missing-transaction'
  | 'replayed-transaction'
  | 'expired-transaction'
  | 'malformed-transaction'
  | 'oidc-state-invalid'
  | 'unauthenticated'
  | 'unsafe-route'
  | 'unsafe-return-to'
  | 'missing-storage'
  | 'webid-mismatch'
  | 'binding-mismatch'
  | 'pod-open-failed'
  | 'storage-unavailable'
  | 'redirect-failed';

export interface XpodOidcCallbackFailure {
  status: 'failure';
  code: XpodOidcCallbackFailureCode;
  message: string;
}

export interface XpodOidcCallbackSuccess {
  status: 'redirected';
  destination: string;
  transaction?: WebIdLoginTransaction;
  selectedStorage?: StorageBinding;
  pod?: OpenPodRuntime<SolidDatabase>;
}

export type XpodOidcCallbackResult = XpodOidcCallbackFailure | XpodOidcCallbackSuccess;

const CALLBACK_COMPLETION_PREFIX = 'xpod.auth.callback.completed.v1.';
const CALLBACK_COMPLETION_TTL_MS = 10 * 60 * 1_000;
const callbackRuns = new Map<string, Promise<XpodOidcCallbackResult>>();

export interface XpodOidcCallbackRuntime extends XpodSolidRuntimeCore {
  readonly session: XpodSolidRuntimeCore['session'] & {
    handleIncomingRedirect?(url: string): Promise<SolidSessionSnapshot>;
  };
  readonly pod: XpodSolidRuntimeCore['pod'];
}

export interface CompleteXpodOidcCallbackOptions {
  href: string;
  runtime: XpodOidcCallbackRuntime;
  transactionStore?: XpodLoginTransactionStore;
  storage?: Storage;
  locationReplace?: (url: string) => void;
  now?: () => number;
}

const FAILURE_MESSAGES: Record<XpodOidcCallbackFailureCode, string> = {
  'missing-transaction': 'This sign-in link is missing its transaction. Start sign-in again.',
  'replayed-transaction': 'This sign-in link has already been used. Start sign-in again.',
  'expired-transaction': 'This sign-in link has expired. Start sign-in again.',
  'malformed-transaction': 'This sign-in link is invalid. Start sign-in again.',
  'oidc-state-invalid': 'The identity provider could not verify this sign-in. Start again.',
  unauthenticated: 'The identity provider did not return an authenticated WebID. Start again.',
  'unsafe-route': 'This sign-in route is not valid for the current Xpod origin.',
  'unsafe-return-to': 'This sign-in return path is not allowed.',
  'missing-storage': 'Choose a Pod storage before signing in again.',
  'webid-mismatch': 'The returned WebID does not match the selected Pod.',
  'binding-mismatch': 'The selected Pod could not be opened for the returned WebID.',
  'pod-open-failed': 'The selected Pod could not be opened. Try again.',
  'storage-unavailable': 'This browser cannot keep the selected Pod for the next page.',
  'redirect-failed': 'Sign-in completed, but Xpod could not open the destination.',
};

export async function completeXpodOidcCallback(
  options: CompleteXpodOidcCallbackOptions,
): Promise<XpodOidcCallbackResult> {
  const callbackUrl = new URL(options.href);
  const origin = callbackUrl.origin;
  const transactionId = callbackUrl.searchParams.get('transaction');
  if (!transactionId) {
    return failure('missing-transaction');
  }

  const resumedDestination = readCompletedDestination(callbackUrl, transactionId, options.storage, options.now);
  if (resumedDestination) {
    const hasOidcResponse = callbackUrl.searchParams.has('code') || callbackUrl.searchParams.has('state');
    const currentInruptDestination = hasOidcResponse
      ? readInruptCurrentDestination(callbackUrl)
      : undefined;
    if (hasOidcResponse) {
      const restored = await handleIncomingRedirect(options.runtime, options.href);
      if (restored.status === 'failure') return restored;
    }
    const destination = currentInruptDestination ?? resumedDestination;
    options.locationReplace?.(destination);
    return { status: 'redirected', destination };
  }

  const redirectResult = await handleIncomingRedirect(options.runtime, options.href);
  if (redirectResult.status === 'failure') {
    return redirectResult;
  }
  const authenticatedWebId = redirectResult.webId;

  const store = options.transactionStore ?? createXpodLoginTransactionStore({
    storage: options.storage,
    origin,
  });
  let transaction: WebIdLoginTransaction;
  try {
    // Do not consume until every asynchronous validation/open step succeeds.
    // Inrupt can clean the callback URL with a full document navigation; the
    // next document must still be able to finish the same pending transaction.
    const pending = store.readSinglePending();
    if (!pending || pending.id !== transactionId) {
      // Preserve the store's precise replay/expiry diagnostics.
      transaction = store.consume(transactionId);
    } else {
      transaction = pending;
    }
  } catch (error) {
    return failure(transactionFailureCode(error));
  }

  try {
    assertXpodLoginRoute(transaction.route, origin);
  } catch {
    return failure('unsafe-route');
  }

  let returnTo: string | undefined;
  try {
    returnTo = normalizeXpodReturnTo(transaction.returnTo);
  } catch {
    return failure('unsafe-return-to');
  }

  const requestedStorage = transaction.selectedStorage;
  if (requestedStorage && !isSafeSelectedStorage(requestedStorage, origin, transaction.route.storageProvider?.url)) {
    return failure('binding-mismatch');
  }
  if (requestedStorage && requestedStorage.webId !== authenticatedWebId) {
    return failure('webid-mismatch');
  }

  let pod: OpenPodRuntime<SolidDatabase>;
  try {
    pod = await options.runtime.pod.open(requestedStorage ? {
      webId: authenticatedWebId,
      podUrl: requestedStorage.storageUrl,
      fetch: options.runtime.session.fetch,
    } : {
      webId: authenticatedWebId,
      fetch: options.runtime.session.fetch,
    });
  } catch {
    return failure('pod-open-failed');
  }
  const selectedStorage = requestedStorage ?? { webId: pod.webId, storageUrl: pod.podUrl };
  if (!isSafeSelectedStorage(selectedStorage, origin, transaction.route.storageProvider?.url)
    || pod.webId !== selectedStorage.webId
    || !sameUrl(pod.podUrl, selectedStorage.storageUrl)) {
    return failure('binding-mismatch');
  }

  try {
    rememberXpodSelectedStorage(selectedStorage, {
      storage: options.storage,
      origin,
      now: options.now,
    });
  } catch {
    return failure('storage-unavailable');
  }

  const destination = new URL(returnTo ?? '/dashboard/overview', origin).href;
  try {
    store.consume(transactionId);
    rememberCompletedDestination(transactionId, destination, options.storage, options.now);
    options.locationReplace?.(destination);
  } catch {
    clearXpodSelectedStorage({ storage: options.storage });
    return failure('redirect-failed');
  }
  return { status: 'redirected', destination, transaction, selectedStorage, pod };
}

function completeXpodOidcCallbackOnce(
  options: CompleteXpodOidcCallbackOptions,
): Promise<XpodOidcCallbackResult> {
  const callbackUrl = new URL(options.href);
  const key = `${callbackUrl.origin}:${callbackUrl.searchParams.get('transaction') ?? '<missing>'}`;
  const existing = callbackRuns.get(key);
  if (existing) return existing;
  const run = completeXpodOidcCallback(options);
  callbackRuns.set(key, run);
  return run;
}

function readCompletedDestination(
  callbackUrl: URL,
  transactionId: string,
  storage?: Storage,
  now: () => number = () => Date.now(),
): string | undefined {
  try {
    const targetStorage = storage ?? window.sessionStorage;
    const key = `${CALLBACK_COMPLETION_PREFIX}${transactionId}`;
    const raw = targetStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { destination?: unknown; completedAt?: unknown };
    if (typeof parsed.destination !== 'string' || typeof parsed.completedAt !== 'number') return undefined;
    if (now() - parsed.completedAt > CALLBACK_COMPLETION_TTL_MS) {
      targetStorage.removeItem(key);
      return undefined;
    }
    const destination = new URL(parsed.destination);
    return destination.origin === callbackUrl.origin ? destination.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Inrupt stores the same-origin page that initiated silent authentication in
 * localStorage. A fresh code/state response must return to that page rather
 * than replaying a stale Xpod completion marker from an earlier route.
 */
function readInruptCurrentDestination(callbackUrl: URL): string | undefined {
  try {
    const raw = window.localStorage.getItem('solidClientAuthn:currentUrl');
    if (!raw) return undefined;
    const current = new URL(raw, callbackUrl.origin);
    if (current.origin !== callbackUrl.origin) return undefined;
    const path = `${current.pathname}${current.search}`;
    const safePath = normalizeXpodReturnTo(path);
    return safePath === undefined ? undefined : new URL(safePath, callbackUrl.origin).href;
  } catch {
    return undefined;
  }
}

function rememberCompletedDestination(
  transactionId: string,
  destination: string,
  storage?: Storage,
  now: () => number = () => Date.now(),
): void {
  const targetStorage = storage ?? window.sessionStorage;
  targetStorage.setItem(`${CALLBACK_COMPLETION_PREFIX}${transactionId}`, JSON.stringify({
    destination,
    completedAt: now(),
  }));
}

export function XpodOidcCallbackApp({
  runtime,
  transactionStore,
  href = typeof window === 'undefined' ? 'http://localhost/auth/callback' : window.location.href,
  location = typeof window === 'undefined' ? undefined : window.location,
  renderRedirected,
}: {
  runtime?: XpodOidcCallbackRuntime;
  transactionStore?: XpodLoginTransactionStore;
  href?: string;
  location?: Pick<Location, 'replace'>;
  renderRedirected?: (result: XpodOidcCallbackSuccess) => ReactNode;
}) {
  const [ownedRuntime] = useState<XpodOidcCallbackRuntime | undefined>(() => runtime ? undefined : createCallbackRuntime());
  const activeRuntime = runtime ?? ownedRuntime!;
  const [result, setResult] = useState<XpodOidcCallbackResult>();
  const runRef = useRef<Promise<XpodOidcCallbackResult> | undefined>(undefined);

  useEffect(() => {
    if (!runRef.current) {
      runRef.current = completeXpodOidcCallbackOnce({
        href,
        runtime: activeRuntime,
        transactionStore,
        locationReplace: location?.replace.bind(location),
      });
      void runRef.current.then(setResult);
    }
  }, [activeRuntime, href, location, transactionStore]);

  if (!result) {
    return <main role="status" aria-live="polite">Completing Xpod sign-in…</main>;
  }
  if (result.status === 'redirected') {
    return renderRedirected?.(result)
      ?? <main role="status" aria-live="polite">Sign-in complete. Opening Xpod…</main>;
  }
  return (
    <main role="alert" aria-live="assertive">
      <h1>Unable to complete Xpod sign-in</h1>
      <p>{result.message}</p>
      <a href="/dashboard/overview">Start sign-in again</a>
    </main>
  );
}

async function handleIncomingRedirect(
  runtime: XpodOidcCallbackRuntime,
  href: string,
): Promise<{ status: 'success'; webId: string } | XpodOidcCallbackFailure> {
  try {
    if (!runtime.session.handleIncomingRedirect) {
      return failure('oidc-state-invalid');
    }
    const result = await runtime.session.handleIncomingRedirect(href) as unknown;
    const returned = isRecord(result) ? result : undefined;
    if (returned?.status === 'error' || returned?.status === 'expired') {
      return failure('oidc-state-invalid');
    }
    const returnedWebId = returned?.status === 'authenticated'
      ? readString(returned.webId)
      : returned?.isLoggedIn === true
        ? readString(returned.webId)
        : undefined;
    const snapshot = runtime.session.getSnapshot();
    if (snapshot.status === 'error' || snapshot.status === 'expired') {
      return failure('oidc-state-invalid');
    }
    const webId = returnedWebId
      ?? (snapshot.status === 'authenticated' ? snapshot.webId : undefined);
    if (!webId) return failure('unauthenticated');
    return { status: 'success', webId };
  } catch {
    return failure('oidc-state-invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isSafeSelectedStorage(
  binding: StorageBinding,
  origin: string,
  expectedStorageProvider?: string,
): boolean {
  try {
    const storageUrl = new URL(binding.storageUrl);
    const webId = new URL(binding.webId);
    const expectedOrigin = expectedStorageProvider
      ? new URL(expectedStorageProvider).origin
      : origin;
    return storageUrl.origin === origin
      && storageUrl.origin === expectedOrigin
      && webId.origin === origin
      && ['http:', 'https:'].includes(storageUrl.protocol)
      && ['http:', 'https:'].includes(webId.protocol)
      && !storageUrl.username
      && !storageUrl.password
      && !storageUrl.hash
      && !webId.username
      && !webId.password;
  } catch {
    return false;
  }
}

function transactionFailureCode(error: unknown): XpodOidcCallbackFailureCode {
  const code = (error as Partial<XpodLoginTransactionError>)?.code;
  switch (code) {
    case 'consumed': return 'replayed-transaction';
    case 'expired': return 'expired-transaction';
    case 'malformed': return 'malformed-transaction';
    default: return 'missing-transaction';
  }
}

function failure(code: XpodOidcCallbackFailureCode): XpodOidcCallbackFailure {
  return { status: 'failure', code, message: FAILURE_MESSAGES[code] };
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function createCallbackRuntime(): XpodOidcCallbackRuntime {
  // Keep one runtime/adapter for this document. Full-page navigation creates a
  // fresh document, so no object identity is expected to cross the redirect.
  return createXpodSolidRuntimeValue();
}
