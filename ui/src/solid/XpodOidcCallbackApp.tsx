/* eslint-disable react-refresh/only-export-components */

import type {
  OpenPodRuntime,
  SolidSessionSnapshot,
  StorageBinding,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { useEffect, useRef, useState } from 'react';
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
  transaction: WebIdLoginTransaction;
  selectedStorage: StorageBinding;
  pod: OpenPodRuntime<SolidDatabase>;
}

export type XpodOidcCallbackResult = XpodOidcCallbackFailure | XpodOidcCallbackSuccess;

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
    // Inrupt state has been validated before the host-owned transaction is
    // consumed. This ordering keeps failed OIDC callbacks replayable.
    transaction = store.consume(transactionId);
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

  const selectedStorage = transaction.selectedStorage;
  if (!selectedStorage) {
    return failure('missing-storage');
  }
  if (!isSafeSelectedStorage(selectedStorage, origin, transaction.route.storageProvider?.url)) {
    return failure('binding-mismatch');
  }
  if (selectedStorage.webId !== authenticatedWebId) {
    return failure('webid-mismatch');
  }

  let pod: OpenPodRuntime<SolidDatabase>;
  try {
    pod = await options.runtime.pod.open({
      webId: authenticatedWebId,
      podUrl: selectedStorage.storageUrl,
      fetch: options.runtime.session.fetch,
    });
  } catch {
    return failure('pod-open-failed');
  }
  if (pod.webId !== selectedStorage.webId || !sameUrl(pod.podUrl, selectedStorage.storageUrl)) {
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
    options.locationReplace?.(destination);
  } catch {
    clearXpodSelectedStorage({ storage: options.storage });
    return failure('redirect-failed');
  }
  return { status: 'redirected', destination, transaction, selectedStorage, pod };
}

export function XpodOidcCallbackApp({
  runtime,
  transactionStore,
  href = typeof window === 'undefined' ? 'http://localhost/auth/callback' : window.location.href,
  location = typeof window === 'undefined' ? undefined : window.location,
}: {
  runtime?: XpodOidcCallbackRuntime;
  transactionStore?: XpodLoginTransactionStore;
  href?: string;
  location?: Pick<Location, 'replace'>;
}) {
  const [ownedRuntime] = useState<XpodOidcCallbackRuntime | undefined>(() => runtime ? undefined : createCallbackRuntime());
  const activeRuntime = runtime ?? ownedRuntime!;
  const [result, setResult] = useState<XpodOidcCallbackResult>();
  const runRef = useRef<Promise<XpodOidcCallbackResult> | undefined>(undefined);

  useEffect(() => {
    if (!runRef.current) {
      runRef.current = completeXpodOidcCallback({
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
    return <main role="status" aria-live="polite">Sign-in complete. Opening Xpod…</main>;
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
