/* eslint-disable react-refresh/only-export-components */

import type {
  OpenPodRuntime,
  SolidSessionSnapshot,
  StorageBinding,
  WebIdLoginCallbackFailure,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { Button } from '@undefineds.co/shared-ui';
import { AlertCircle, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { XpodLoginBrand } from '../auth/XpodLoginBrand';
import { XpodAuthSurface } from '../auth/XpodAuthSurface';
import { assertXpodLoginRoute, normalizeXpodReturnTo } from '../auth/xpod-login-route';
import { XPOD_DEFAULT_RETURN_PATH } from '../routes/canonical-routes';
import {
  clearXpodSelectedStorage,
  createXpodLoginTransactionStore,
  rememberXpodSelectedStorage,
  type XpodLoginTransactionError,
  type XpodLoginTransactionStore,
} from '../auth/xpod-login-transaction';
import { createXpodSolidRuntimeValue, type XpodSolidRuntimeCore } from './XpodSolidRuntime';
import {
  XPOD_INRUPT_STORAGE_KEY_PREFIX,
  XPOD_LAST_OIDC_ISSUER_STORAGE_KEY,
  XPOD_SOLID_SESSION_ID_STORAGE_KEY,
} from './XpodSolidRuntime';
import { filterWebIdsByStorageRoot, storageUrlBelongsToRoot } from '../utils/provision-scope';
import { currentProvisionLocalPodRoute } from './xpod-local-route';

/**
 * Xpod storage-class callback failures, layered on top of the canonical
 * protocol-level codes from `@undefineds.co/solid-sdk`.
 */
export type XpodOidcStorageCallbackFailure =
  | 'missing-storage'
  | 'local-binding-missing'
  | 'webid-mismatch'
  | 'binding-mismatch'
  | 'profile-read-failed'
  | 'pod-open-failed'
  | 'storage-unavailable';

export type XpodOidcCallbackFailureCode = WebIdLoginCallbackFailure | XpodOidcStorageCallbackFailure;

export interface XpodOidcCallbackFailure {
  status: 'failure';
  code: XpodOidcCallbackFailureCode;
  message: string;
  actionUrl?: string;
  developerDiagnostic?: string;
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
const INRUPT_CURRENT_URL_KEY = 'solidClientAuthn:currentUrl';
const callbackRuns = new Map<string, Promise<XpodOidcCallbackResult>>();
const AUTO_RESET_FAILURE_CODES = new Set<XpodOidcCallbackFailureCode>([
  'webid-mismatch',
  'binding-mismatch',
]);

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
  fetch?: typeof fetch;
}

export interface XpodOidcCallbackAppProps {
  runtime?: XpodOidcCallbackRuntime;
  transactionStore?: XpodLoginTransactionStore;
  href?: string;
  location?: Pick<Location, 'replace'>;
  restartSignIn?: (url: string) => void;
  renderRedirected?: (result: XpodOidcCallbackSuccess) => ReactNode;
}

const FAILURE_MESSAGES: Record<XpodOidcCallbackFailureCode, {
  title: string;
  message: string;
  action: string;
}> = {
  'missing-transaction': {
    title: '登录请求已失效',
    message: '这次登录请求已经失效，请重新登录。',
    action: '重新登录',
  },
  'replayed-transaction': {
    title: '登录请求已使用',
    message: '这次登录请求已经完成，不能再次使用。请重新登录。',
    action: '重新登录',
  },
  'expired-transaction': {
    title: '登录请求已过期',
    message: '登录等待时间过长，请重新登录。',
    action: '重新登录',
  },
  'malformed-transaction': {
    title: '登录请求无效',
    message: '登录信息不完整或已被修改，请重新登录。',
    action: '重新登录',
  },
  'oidc-state-invalid': {
    title: '登录验证已失效',
    message: '登录页面与当前会话不再匹配，请重新登录。',
    action: '重新登录',
  },
  unauthenticated: {
    title: '登录没有完成',
    message: 'Xpod 没有收到有效的 WebID，请重新登录。',
    action: '重新登录',
  },
  'unsafe-route': {
    title: '登录请求不安全',
    message: 'Xpod 已阻止异常的登录来源，请从应用内重新登录。',
    action: '重新登录',
  },
  'unsafe-return-to': {
    title: '登录请求不安全',
    message: 'Xpod 已阻止异常的返回地址，请从应用内重新登录。',
    action: '重新登录',
  },
  'missing-storage': {
    title: '没有可用的 Pod',
    message: '当前账号还没有可用于本次登录的 Pod，请返回后重试。',
    action: '返回并重试',
  },
  'local-binding-missing': {
    title: '本机绑定尚未完成',
    message: '当前账号还没有绑定到这台 Xpod。请先修复本机初始化，再重新登录。',
    action: '修复本机绑定',
  },
  'webid-mismatch': {
    title: '身份与 Pod 不匹配',
    message: '本次登录身份与所选 Pod 不一致，请重新登录。',
    action: '重新登录',
  },
  'binding-mismatch': {
    title: '身份与 Pod 不匹配',
    message: 'Xpod 无法确认当前身份拥有所选 Pod，请重新登录。',
    action: '重新登录',
  },
  'profile-read-failed': {
    title: '暂时无法读取身份资料',
    message: '未能读取你的 WebID 资料，暂时无法确认 Pod 地址。请稍后重试，不需要重新创建 Pod。',
    action: '重试登录',
  },
  'pod-open-failed': {
    title: '暂时无法打开 Pod',
    message: 'Xpod 无法连接到你的 Pod，请检查服务状态后重试。',
    action: '重试登录',
  },
  'storage-unavailable': {
    title: '无法保存登录状态',
    message: '当前环境无法保存本次登录状态，请重新打开 Xpod 后重试。',
    action: '重新登录',
  },
  'redirect-failed': {
    title: '登录已完成',
    message: '身份验证已经完成，但目标页面没有正常打开。',
    action: '返回概览',
  },
};

export async function completeXpodOidcCallback(
  options: CompleteXpodOidcCallbackOptions,
): Promise<XpodOidcCallbackResult> {
  const callbackUrl = new URL(options.href);
  const origin = callbackUrl.origin;
  let transactionId = callbackUrl.searchParams.get('transaction');
  const hasOidcResponse = callbackUrl.searchParams.has('code')
    || callbackUrl.searchParams.has('state')
    || callbackUrl.searchParams.has('error');
  const currentInruptDestination = hasOidcResponse
    ? readInruptCurrentDestination(callbackUrl)
    : undefined;

  let store: XpodLoginTransactionStore | undefined;
  let transaction: WebIdLoginTransaction | undefined;
  let transactionError: XpodOidcCallbackFailure | undefined;
  try {
    store = options.transactionStore ?? createXpodLoginTransactionStore({
      storage: options.storage,
      origin,
    });
    const pending = store.readSinglePending();
    // The stable callback URL keeps the Xpod transaction out of the URL. An
    // active same-tab transaction always wins over Inrupt's currentUrl marker;
    // the marker can coexist after an interrupted restore attempt.
    if (!transactionId && pending) transactionId = pending.id;
    if (transactionId) {
      // Validate the host transaction before touching the one-time OIDC code.
      if (!pending || pending.id !== transactionId) {
        store.consume(transactionId);
        transactionError = failure('missing-transaction');
      } else {
        transaction = pending;
      }
    } else {
      transactionError = failure('missing-transaction');
    }
  } catch (error) {
    transactionError = failure(transactionFailureCode(error));
  }

  const resumedDestination = transactionId
    ? readCompletedDestination(callbackUrl, transactionId, options.storage, options.now)
    : undefined;
  if (resumedDestination) {
    // A fresh Inrupt silent-auth response can reuse the redirect URL that was
    // originally registered for an already-completed Xpod login transaction.
    // In that case currentUrl is the route that requested restoration now; the
    // completed transaction destination is stale and must not hijack the rail
    // navigation back to the previous product.
    if (hasOidcResponse && currentInruptDestination && !transaction) {
      const restored = await handleIncomingRedirect(options.runtime, options.href);
      if (restored.status === 'failure') {
        const recovered = await recoverFailedOidcCallback({
          callbackUrl,
          destination: currentInruptDestination,
          runtime: options.runtime,
          storage: options.storage,
          locationReplace: options.locationReplace,
        });
        if (recovered) return recovered;
        return restored;
      }
      options.locationReplace?.(currentInruptDestination);
      return { status: 'redirected', destination: currentInruptDestination };
    }
    // Electron or browser history can restore a completed Xpod callback with
    // stale code/state. Once the host transaction is completed, this URL is
    // never an Inrupt-owned silent-auth callback and must not redeem code again.
    options.locationReplace?.(resumedDestination);
    return { status: 'redirected', destination: resumedDestination };
  }

  if (!transaction) {
    // Inrupt owns silent session restoration and does not create an Xpod host
    // transaction. Complete that flow, then return to its recorded product URL.
    if (currentInruptDestination) {
      const restored = await handleIncomingRedirect(options.runtime, options.href);
      if (restored.status === 'failure') {
        const recovered = await recoverFailedOidcCallback({
          callbackUrl,
          destination: currentInruptDestination,
          runtime: options.runtime,
          storage: options.storage,
          locationReplace: options.locationReplace,
        });
        if (recovered) return recovered;
        return restored;
      }
      options.locationReplace?.(currentInruptDestination);
      return { status: 'redirected', destination: currentInruptDestination };
    }
    return transactionError ?? failure('missing-transaction');
  }
  if (!store || !transactionId) {
    return failure('missing-transaction');
  }

  const redirectResult = await handleIncomingRedirect(options.runtime, options.href);
  if (redirectResult.status === 'failure') {
    const recovered = await recoverFailedOidcCallback({
      callbackUrl,
      destination: productDestinationForTransaction(transaction, origin),
      runtime: options.runtime,
      transactionStore: store,
      transactionId,
      storage: options.storage,
      locationReplace: options.locationReplace,
    });
    if (recovered) return recovered;
    return redirectResult;
  }
  const authenticatedWebId = redirectResult.webId;

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

  const provisionStatus = transaction.selectedStorage
    && new URL(transaction.selectedStorage.storageUrl).origin === origin
    ? { storageRoot: origin }
    : await resolveCurrentXpodProvisionStatus(options.fetch ?? fetch, origin);
  const localStorageRoot = provisionStatus.storageRoot;
  let requestedStorage: StorageBinding | undefined;
  try {
    requestedStorage = transaction.selectedStorage
      ?? await discoverCurrentXpodStorage(options.runtime.session.fetch, authenticatedWebId, localStorageRoot);
  } catch {
    return failure('profile-read-failed');
  }
  if (requestedStorage && !isSafeSelectedStorage(requestedStorage, origin, localStorageRoot)) {
    return failure('binding-mismatch');
  }
  if (requestedStorage && requestedStorage.webId !== authenticatedWebId) {
    return failure('webid-mismatch');
  }
  if (!requestedStorage) {
    return provisionStatus.managed
      ? failure('local-binding-missing', provisionStatus.provisionUrl)
      : failure('missing-storage');
  }

  let pod: OpenPodRuntime<SolidDatabase>;
  try {
    options.runtime.setLocalPodRoute(currentProvisionLocalPodRoute(requestedStorage.storageUrl, provisionStatus));
    pod = await options.runtime.pod.open({
      webId: authenticatedWebId,
      podUrl: requestedStorage.storageUrl,
      fetch: options.runtime.session.fetch,
    });
  } catch (error) {
    return {
      ...failure('pod-open-failed'),
      ...(import.meta.env.DEV && error instanceof Error
        ? { developerDiagnostic: error.stack?.split('\n').slice(0, 6).join('\n') ?? error.message }
        : {}),
    };
  }
  const selectedStorage = requestedStorage;
  if (!isSafeSelectedStorage(selectedStorage, origin, localStorageRoot)
    || pod.webId !== selectedStorage.webId
    || !sameUrl(pod.podUrl, selectedStorage.storageUrl)) {
    return failure('binding-mismatch');
  }

  try {
    rememberXpodSelectedStorage(selectedStorage, {
      storage: options.storage,
      origin,
      storageRoot: localStorageRoot,
      now: options.now,
    });
  } catch {
    return failure('storage-unavailable');
  }

  const destination = new URL(returnTo ?? XPOD_DEFAULT_RETURN_PATH, origin).href;
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
  const key = callbackRunKey(callbackUrl, options.transactionStore);
  const existing = callbackRuns.get(key);
  if (existing) return existing;
  const run = completeXpodOidcCallback(options);
  callbackRuns.set(key, run);
  return run;
}

function callbackRunKey(callbackUrl: URL, transactionStore?: XpodLoginTransactionStore): string {
  let correlation = callbackUrl.searchParams.get('transaction');
  if (!correlation) {
    try {
      correlation = transactionStore?.readSinglePending()?.id
        ?? createXpodLoginTransactionStore({ origin: callbackUrl.origin }).readSinglePending()?.id
        ?? (readInruptCurrentDestination(callbackUrl) ? '<silent>' : '<missing>');
    } catch {
      correlation = readInruptCurrentDestination(callbackUrl) ? '<silent>' : '<missing>';
    }
  }
  return `${callbackUrl.origin}:${correlation}`;
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
    const raw = window.localStorage.getItem(INRUPT_CURRENT_URL_KEY);
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
  restartSignIn,
  renderRedirected,
}: XpodOidcCallbackAppProps) {
  const [ownedRuntime] = useState<XpodOidcCallbackRuntime | undefined>(() => runtime ? undefined : createCallbackRuntime());
  const activeRuntime = runtime ?? ownedRuntime!;
  const [result, setResult] = useState<XpodOidcCallbackResult>();
  const [restarting, setRestarting] = useState(false);
  const runRef = useRef<Promise<XpodOidcCallbackResult> | undefined>(undefined);
  const autoRestartRef = useRef(false);
  const restartDestination = useMemo(() => resolveXpodCallbackRestartDestination({
    href,
    transactionStore,
  }), [href, transactionStore]);

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

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (result?.status === 'redirected' && renderRedirected) return;
    document.title = result?.status === 'failure'
      ? `Xpod - ${FAILURE_MESSAGES[result.code].title}`
      : result?.status === 'redirected'
        ? 'Xpod - 登录完成'
        : 'Xpod - 正在登录';
  }, [renderRedirected, result]);

  useEffect(() => {
    if (!result || result.status !== 'failure') return;
    if (!AUTO_RESET_FAILURE_CODES.has(result.code)) return;
    if (autoRestartRef.current) return;
    autoRestartRef.current = true;
    queueMicrotask(() => {
      setRestarting(true);
      void resetXpodOidcCallback({
        href,
        runtime: activeRuntime,
        transactionStore,
      }).finally(() => {
        const restart = restartSignIn
          ?? ((url: string) => window.location.replace(url));
        restart(restartDestination);
      });
    });
  }, [activeRuntime, href, restartDestination, restartSignIn, result, transactionStore]);

  if (!result) {
    return <XpodCallbackStatus title="正在完成登录" message="请稍候，不要关闭这个窗口。" />;
  }
  if (result.status === 'redirected') {
    return renderRedirected?.(result)
      ?? <XpodCallbackStatus title="登录完成" message="正在打开 Xpod。" />;
  }
  if (AUTO_RESET_FAILURE_CODES.has(result.code)) {
    return <XpodCallbackStatus title="正在重新登录" message="Xpod 正在清理不匹配的登录状态。" />;
  }
  const failure = FAILURE_MESSAGES[result.code];
  return (
    <XpodAuthSurface
      mode="modal"
      title={failure.title}
      lead={<XpodLoginBrand compact />}
      closeOnEscape={false}
    >
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5">
        <div className="flex min-h-0 flex-1 flex-col justify-center py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
              <h2 className="text-[15px] font-semibold leading-6 text-foreground">{failure.title}</h2>
            </div>
            <p role="alert" className="mt-2 text-xs leading-5 text-muted-foreground">
              {failure.message}
            </p>
            <details className="group mt-3 text-[11px] leading-4 text-muted-foreground">
              <summary className="-ml-1 inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 group-open:rotate-90" />
                技术详情
              </summary>
              <div className="mt-1 max-h-24 overflow-y-auto overscroll-contain">
                <code className="block break-all text-left">{result.code}</code>
                {import.meta.env.DEV && result.developerDiagnostic && (
                  <pre className="mt-2 max-w-full whitespace-pre-wrap break-words text-left">{result.developerDiagnostic}</pre>
                )}
              </div>
            </details>
          </div>
        </div>
        <Button
          type="button"
          className="w-full shrink-0 rounded-xl"
          disabled={restarting}
          aria-busy={restarting}
          onClick={() => {
            if (restarting) return;
            setRestarting(true);
            void (result.code === 'redirect-failed'
              ? Promise.resolve()
              : resetXpodOidcCallback({
                href,
                runtime: activeRuntime,
                transactionStore,
              }))
              .finally(() => {
                if (result.actionUrl) {
                  const navigate = restartSignIn
                    ?? ((url: string) => window.location.replace(url));
                  navigate(result.actionUrl);
                  return;
                }
                const restart = restartSignIn
                  ?? ((url: string) => window.location.replace(url));
                restart(restartDestination);
              });
          }}
        >
          {restarting ? '正在重置…' : failure.action}
        </Button>
      </div>
    </XpodAuthSurface>
  );
}

export function resolveXpodCallbackRestartDestination({
  href,
  transactionStore,
  basePath = import.meta.env.BASE_URL,
}: {
  href: string;
  transactionStore?: XpodLoginTransactionStore;
  basePath?: string;
}): string {
  const callbackUrl = new URL(href);
  const transaction = readRestartTransaction(callbackUrl, transactionStore);
  const transactionReturnTo = transaction?.returnTo;
  if (transactionReturnTo) {
    try {
      const returnTo = normalizeXpodReturnTo(transactionReturnTo);
      if (returnTo) return returnTo;
    } catch {
      // Fall back to the active product surface.
    }
  }

  const inruptDestination = readInruptCurrentDestination(callbackUrl);
  if (inruptDestination) {
    try {
      const destination = new URL(inruptDestination);
      if (destination.origin === callbackUrl.origin) {
        return `${destination.pathname}${destination.search}${destination.hash}`;
      }
    } catch {
      // Fall back to the active product surface.
    }
  }

  return callbackProductEntryPath(basePath, callbackUrl.pathname);
}

function readRestartTransaction(
  callbackUrl: URL,
  transactionStore?: XpodLoginTransactionStore,
): WebIdLoginTransaction | undefined {
  try {
    const pending = transactionStore
      ? transactionStore.readSinglePending()
      : createXpodLoginTransactionStore({ origin: callbackUrl.origin }).readSinglePending();
    const transactionId = callbackUrl.searchParams.get('transaction');
    if (transactionId && pending?.id !== transactionId) return undefined;
    return pending;
  } catch {
    return undefined;
  }
}

function callbackProductEntryPath(basePath: string | undefined, callbackPathname: string): string {
  const normalizedBase = normalizeBasePath(basePath);
  if (normalizedBase === '/settings/') return '/settings/';
  if (callbackPathname === '/settings/auth-callback.html' || callbackPathname.startsWith('/settings/')) {
    return '/settings/';
  }
  return XPOD_DEFAULT_RETURN_PATH;
}

function normalizeBasePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, 'https://xpod.local');
    return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  } catch {
    return undefined;
  }
}

function XpodCallbackStatus({ title, message }: { title: string; message: string }) {
  return (
    <XpodAuthSurface
      mode="modal"
      title={title}
      lead={<XpodLoginBrand compact />}
      closeOnEscape={false}
    >
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
        <p role="status" aria-live="polite" className="mt-2 max-w-[13rem] text-xs leading-5 text-muted-foreground">
          {message}
        </p>
      </div>
    </XpodAuthSurface>
  );
}

export async function resetXpodOidcCallback({
  href,
  runtime,
  transactionStore,
  storage,
}: {
  href: string;
  runtime: XpodOidcCallbackRuntime;
  transactionStore?: XpodLoginTransactionStore;
  storage?: Storage;
}): Promise<void> {
  const callbackUrl = new URL(href);
  let transactionId = callbackUrl.searchParams.get('transaction');
  try {
    const store = transactionStore ?? createXpodLoginTransactionStore({
      storage,
      origin: callbackUrl.origin,
    });
    const pending = store.readSinglePending();
    if (!transactionId && pending) transactionId = pending.id;
    if (pending && pending.id === transactionId) store.cancel(pending.id);
  } catch {
    // The callback may already be consumed, expired, or unavailable.
  }
  try {
    const targetStorage = storage ?? window.sessionStorage;
    if (transactionId) targetStorage.removeItem(`${CALLBACK_COMPLETION_PREFIX}${transactionId}`);
    window.localStorage.removeItem(INRUPT_CURRENT_URL_KEY);
  } catch {
    // Navigation still recovers when browser storage is unavailable.
  }
  try {
    await runtime.session.logout();
  } catch {
    // A fresh product document can still establish a new session.
  }
  callbackRuns.delete(`${callbackUrl.origin}:${transactionId ?? '<missing>'}`);
  callbackRuns.delete(`${callbackUrl.origin}:<silent>`);
  callbackRuns.delete(`${callbackUrl.origin}:<missing>`);
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

async function recoverFailedOidcCallback({
  callbackUrl,
  destination,
  runtime,
  transactionStore,
  transactionId,
  storage,
  locationReplace,
}: {
  callbackUrl: URL;
  destination: string;
  runtime: XpodOidcCallbackRuntime;
  transactionStore?: XpodLoginTransactionStore;
  transactionId?: string;
  storage?: Storage;
  locationReplace?: (url: string) => void;
}): Promise<XpodOidcCallbackSuccess | undefined> {
  const oidcError = callbackUrl.searchParams.get('error');
  if (!isRecoverableSilentRestoreError(oidcError)) return undefined;
  clearRecoverableCallbackState({ transactionStore, transactionId, storage });
  try {
    await runtime.session.logout();
  } catch {
    // The product route will reduce the missing live session to idle.
  }
  locationReplace?.(destination);
  return { status: 'redirected', destination };
}

function isRecoverableSilentRestoreError(error: string | null): boolean {
  return error === 'login_required'
    || error === 'interaction_required'
    || error === 'consent_required'
    || error === 'account_selection_required';
}

function clearRecoverableCallbackState({
  transactionStore,
  transactionId,
  storage,
}: {
  transactionStore?: XpodLoginTransactionStore;
  transactionId?: string;
  storage?: Storage;
}): void {
  try {
    const pending = transactionStore?.readSinglePending();
    const id = transactionId ?? pending?.id;
    if (id && pending?.id === id) transactionStore?.cancel(id);
    if (id) (storage ?? window.sessionStorage).removeItem(`${CALLBACK_COMPLETION_PREFIX}${id}`);
  } catch {
    // Callback cleanup must not block returning to the product idle route.
  }
  clearXpodSelectedStorage({ storage });
  clearInruptActiveStorage(window.localStorage);
  clearInruptActiveStorage(window.sessionStorage);
}

function clearInruptActiveStorage(storage?: Storage): void {
  if (!storage) return;
  try {
    storage.removeItem(INRUPT_CURRENT_URL_KEY);
    storage.removeItem('solidClientAuthn:currentSession');
    storage.removeItem(XPOD_SOLID_SESSION_ID_STORAGE_KEY);
    storage.removeItem(XPOD_LAST_OIDC_ISSUER_STORAGE_KEY);
    for (const key of Object.keys(storage)) {
      if (key.startsWith('solidClientAuthenticationUser:')
        || key.startsWith(XPOD_INRUPT_STORAGE_KEY_PREFIX)
        || key.startsWith('issuerConfig:')
        || key.startsWith('oidc.')) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Browser storage can be unavailable; recovery still proceeds by navigation.
  }
}

function productDestinationForTransaction(transaction: WebIdLoginTransaction, origin: string): string {
  try {
    const returnTo = normalizeXpodReturnTo(transaction.returnTo);
    return new URL(returnTo ?? XPOD_DEFAULT_RETURN_PATH, origin).href;
  } catch {
    return new URL(XPOD_DEFAULT_RETURN_PATH, origin).href;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isSafeSelectedStorage(
  binding: StorageBinding,
  origin: string,
  localStorageRoot?: string,
): boolean {
  try {
    const storageUrl = new URL(binding.storageUrl);
    const webId = new URL(binding.webId);
    const storageIsCurrentXpod = storageUrl.origin === origin
      || storageUrlBelongsToRoot(storageUrl.href, localStorageRoot);
    return storageIsCurrentXpod
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

async function resolveCurrentXpodProvisionStatus(
  fetchImpl: typeof fetch,
  origin: string,
): Promise<{ storageRoot: string; managed?: boolean; provisionUrl?: string }> {
  const response = await fetchImpl(new URL('/provision/status', origin), {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  } as RequestInit).catch(() => undefined);
  if (!response?.ok) return { storageRoot: origin };
  const status = await response.json().catch(() => undefined) as {
    managed?: unknown;
    provisionUrl?: unknown;
    publicUrl?: unknown;
  } | undefined;
  return {
    storageRoot: typeof status?.publicUrl === 'string' && status.publicUrl
      ? status.publicUrl
      : origin,
    managed: status?.managed === true,
    provisionUrl: safeProvisionUrl(status?.provisionUrl),
  };
}

function safeProvisionUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

async function discoverCurrentXpodStorage(
  fetchImpl: typeof fetch,
  webId: string,
  localStorageRoot: string,
): Promise<StorageBinding | undefined> {
  let profileReadFailed = false;
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init).catch((error) => {
      if (String(input) === webId) profileReadFailed = true;
      throw error;
    });
    if (String(input) === webId && !response.ok) {
      profileReadFailed = true;
    }
    return response;
  };
  const bindings = await filterWebIdsByStorageRoot(observedFetch, [webId], localStorageRoot);
  if (profileReadFailed) {
    throw new Error('Unable to read WebID profile storage bindings');
  }
  if (bindings.length !== 1) return undefined;
  return bindings[0];
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

function failure(code: XpodOidcCallbackFailureCode, actionUrl?: string): XpodOidcCallbackFailure {
  return {
    status: 'failure',
    code,
    message: FAILURE_MESSAGES[code].message,
    ...(actionUrl ? { actionUrl } : {}),
  };
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
