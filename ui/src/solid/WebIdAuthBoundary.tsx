import {
  Button,
  PodSignIn,
  XpodMark,
  resolvePodSignInCopy,
  webIdShortName,
  type PodSignInNotice,
  type PodSignInState,
  type RememberedIdentity,
} from '@undefineds.co/shared-ui';
import type { RememberedWebIdLogin, StorageSelectionState, WebIdAuthState } from '@undefineds.co/solid-sdk';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { XpodProductLogoutBoundary } from '../auth/XpodProductLogoutBoundary';
import { XpodLocalLoginPreflight } from '../auth/XpodLocalLoginPreflight';
import { consumeXpodAccountSwitch, readXpodAccountSwitch, readXpodLoginCancelled, setXpodLoginCancelled } from '../auth/xpod-login-recovery';
import { createXpodLoginController } from '../auth/XpodLoginController';
import { XpodSignInFrame } from '../auth/XpodAuthSurface';
import { xpodStorageLocationKind } from '../auth/xpod-storage-location';
import { AuthContext } from '../context/AuthContextValue';
import { isXpodAutomaticLoginBlocked, logoutXpodProduct, subscribeXpodProductLogout } from '../auth/xpod-product-logout';
import { clearRememberedXpodLogin, readRememberedXpodLogin } from '../auth/xpod-remembered-login';
import { useXpodSolidRuntime } from './useXpodSolidRuntime';

const copy = resolvePodSignInCopy('zh-CN');
// The Xpod console is a WebID application like any other: it names itself.
const XPOD_APP = { name: 'Xpod', icon: <XpodMark size={24} /> };

const podFailureMessage = '无法打开选中的 Pod，请重试。';
const actionFailureMessage = '操作未完成，请重试。';

export function WebIdAuthBoundary(props: { children: ReactNode; autoStart?: boolean; developerMode?: boolean }) {
  return <XpodProductLogoutBoundary><WebIdAuthBoundaryContent {...props} /></XpodProductLogoutBoundary>;
}

function WebIdAuthBoundaryContent({
  children,
  autoStart = false,
  developerMode = false,
}: {
  children: ReactNode;
  /** Xpod product routes continue their single fixed WebID flow without a second click. */
  autoStart?: boolean;
  /** Technical detail of a failure becomes expandable. Persisting the switch is not this component's job. */
  developerMode?: boolean;
}) {
  const runtime = useXpodSolidRuntime();
  const account = useContext(AuthContext);
  const automaticLoginBlocked = useSyncExternalStore(subscribeXpodProductLogout, isXpodAutomaticLoginBlocked, () => false);
  const loginController = useMemo(() => createXpodLoginController({ runtime }), [runtime]);
  const [switchOnEntry] = useState(readXpodAccountSwitch);
  const [loginCancelled, setLoginCancelled] = useState(() => switchOnEntry || readXpodLoginCancelled());
  useLayoutEffect(() => {
    if (switchOnEntry) consumeXpodAccountSwitch();
  }, [switchOnEntry]);
  useEffect(() => {
    if (!loginCancelled) return;
    try { loginController.cancelLogin(); } catch { /* Expired records are cleared by the store. */ }
  }, [loginCancelled, loginController]);
  const state = runtimeState(runtime.state);
  // The screen a login was started from: while connecting, the remembered identity stays
  // on screen with its button busy instead of falling back to the first-visit screen.
  const lastRemembered = useRef<RememberedWebIdLogin | undefined>(undefined);
  if ('remembered' in state) lastRemembered.current = state.remembered;
  const storageState = storageSelectionState(runtime, state);
  const contentReady = state.status === 'authenticated' && storageState?.status === 'ready';
  // Login/switch failures must surface here: the boundary fires the async
  // auth actions, so an unobserved rejection would otherwise dead-end the UI.
  const [actionError, setActionError] = useState<string>();
  const [pending, setPending] = useState(false);
  // Explicit switching requests fresh authentication using the standard OIDC prompt.
  const [preflight, setPreflight] = useState<{ prompt?: 'login' } | undefined>(
    switchOnEntry ? { prompt: 'login' } : undefined,
  );
  const actionVersion = useRef(0);
  const [switchRequested, setSwitchRequested] = useState(false);
  const restoreAttempted = useRef(false);
  const autoStartAttempted = useRef(false);
  const reportActionError = useCallback((error: unknown) => {
    console.error('[WebIdAuthBoundary] authentication action failed', error);
    setActionError(actionFailureMessage);
  }, []);
  const runAction = useCallback((action: () => Promise<unknown>) => {
    const version = ++actionVersion.current;
    setActionError(undefined);
    setPending(true);
    void action().catch((error) => {
      if (version === actionVersion.current) reportActionError(error);
    }).finally(() => {
      if (version === actionVersion.current) setPending(false);
    });
  }, [reportActionError]);
  const startLogin = useCallback(
    () => {
      setXpodLoginCancelled(false);
      setLoginCancelled(false);
      setActionError(undefined);
      setPreflight({});
    },
    [],
  );
  const continueLogin = useCallback(() => {
    if (!preflight) return;
    const prompt = preflight.prompt;
    setXpodLoginCancelled(false);
    setLoginCancelled(false);
    setPreflight(undefined);
    runAction(async () => {
      if (switchOnEntry) await runtime.session.initialize({ restorePreviousSession: false });
      await loginController.startLogin(undefined, undefined, prompt);
    });
  }, [loginController, preflight, runAction, runtime.session, switchOnEntry]);
  const retry = () => {
    if (switchRequested) {
      switchAccount();
      return;
    }
    if (state.status === 'authenticated') {
      runtime.retryPodOpen?.();
    } else {
      startLogin();
    }
  };
  const cancel = () => {
    if (switchRequested) return;
    try { loginController.cancelLogin(); } catch { /* Expired records are already cleared. */ }
    setXpodLoginCancelled(true);
    setLoginCancelled(true);
    setPreflight(undefined);
    actionVersion.current += 1;
    setPending(false);
    setActionError(undefined);
  };
  const switchAccount = () => runAction(async () => {
    setSwitchRequested(true);
    const onComplete = () => {
      setXpodLoginCancelled(false);
      setLoginCancelled(false);
      clearRememberedXpodLogin();
      setActionError(undefined);
      setPreflight({ prompt: 'login' });
      setSwitchRequested(false);
    };
    if (account) await logoutXpodProduct(account, runtime, { onComplete });
    else {
      await runtime.logout();
      onComplete();
    }
  });

  useEffect(() => {
    if (runtime.state.status !== 'loading' || restoreAttempted.current) return;
    restoreAttempted.current = true;
    void runtime.session.initialize({ restorePreviousSession: !loginCancelled }).catch(reportActionError);
  }, [loginCancelled, reportActionError, runtime.session, runtime.state.status]);

  useEffect(() => {
    if (loginCancelled || preflight || automaticLoginBlocked || pending || switchRequested || !autoStart || autoStartAttempted.current || state.status !== 'anonymous') return;
    autoStartAttempted.current = true;
    startLogin();
  }, [loginCancelled, automaticLoginBlocked, autoStart, pending, preflight, startLogin, state.status, switchRequested]);

  // Keep the same WebID + selected Pod readiness gate. Only the host's
  // presentation changes: Xpod has one fixed login route, not a route picker.
  if (contentReady && !pending && !actionError) {
    return <>{children}</>;
  }


  const remembered = 'remembered' in state ? state.remembered : undefined;
  const restoring = state.status === 'restoring';
  const connecting = pending || Boolean(preflight) || (autoStart && !loginCancelled && !automaticLoginBlocked && state.status === 'anonymous' && !actionError);
  // A cancelled or switching login returns to the first-visit screen, not to the remembered one.
  const identity = remembered && !loginCancelled ? presentedIdentity(remembered) : undefined;
  const idle = (busy = false): PodSignInState => identity
    ? { kind: 'remembered', identity, busy }
    : { kind: 'choose-service', busy };

  let podState: PodSignInState = idle();
  let notice: PodSignInNotice | undefined;
  let onPrimary: () => void = startLogin;
  let onUseAnother: (() => void) | undefined;
  let cancellable = false;

  if (!loginCancelled && runtime.state.status === 'error'
    && runtime.state.error.name === 'SolidSessionPendingError') {
    notice = {
      tone: 'warning',
      text: copy.noticePending,
      primaryLabel: copy.refreshPage,
      developerDetail: runtime.state.error.message,
    };
    onPrimary = () => window.location.reload();
  } else if (actionError) {
    notice = { tone: 'warning', text: copy.noticeIncomplete, primaryLabel: copy.retry, developerDetail: actionError };
    onPrimary = retry;
    onUseAnother = identity && !switchRequested ? switchAccount : undefined;
  } else if (restoring) {
    podState = { kind: 'restoring', ...(remembered ? { identity: presentedIdentity(remembered) } : {}) };
  } else if (connecting) {
    const from = identity ?? (!loginCancelled && lastRemembered.current ? presentedIdentity(lastRemembered.current) : undefined);
    podState = from ? { kind: 'remembered', identity: from, busy: true } : { kind: 'choose-service', busy: true };
    onPrimary = () => undefined;
    cancellable = !switchRequested;
  } else if (state.status === 'authenticated') {
    // Valid WebID sessions stay valid while their Pod opens or retries.
    // Never turn a storage failure into a second login / provider selection.
    const active = presentedIdentity(rememberedWebIdLogin(state.webId) ?? {
      displayName: webIdShortName(state.webId),
      webId: state.webId,
    });
    if (storageState?.status === 'conflict') {
      podState = { kind: 'remembered', identity: active };
      notice = { tone: 'warning', text: copy.noticeIncomplete, primaryLabel: copy.useAnother, developerDetail: storageState.message };
      onPrimary = switchAccount;
    } else if (storageState?.status === 'error') {
      podState = { kind: 'remembered', identity: active };
      notice = { tone: 'warning', text: copy.noticeUnreachable, primaryLabel: copy.retry, developerDetail: storageState.message };
      onPrimary = retry;
      onUseAnother = switchAccount;
    } else {
      podState = { kind: 'remembered', identity: active, busy: true };
      onPrimary = () => undefined;
    }
  } else if (identity) {
    onUseAnother = switchAccount;
    if (state.status === 'expired') {
      podState = { kind: 'expired', identity };
      onPrimary = retry;
    } else if (state.status === 'error') {
      notice = { tone: 'warning', text: copy.noticeIncomplete, primaryLabel: copy.reauthenticate, developerDetail: state.message };
      onPrimary = retry;
    }
  } else if (!loginCancelled && (state.status === 'error' || state.status === 'expired')) {
    notice = {
      tone: 'warning',
      text: copy.noticeIncomplete,
      primaryLabel: copy.reauthenticate,
      developerDetail: state.status === 'error' ? state.message : undefined,
    };
    onPrimary = retry;
  }

  return (
    <XpodSignInFrame ariaLabel="登录 Xpod">
      {preflight ? <XpodLocalLoginPreflight onReady={continueLogin} /> : null}
      <PodSignIn
        app={XPOD_APP}
        state={podState}
        notice={notice}
        locale="zh-CN"
        developerMode={developerMode}
        capabilities={{ customService: false, register: false }}
        onPrimary={onPrimary}
        onUseAnother={onUseAnother}
      />
      {cancellable ? (
        <Button type="button" variant="ghost" className="mt-2 h-9 w-full rounded-lg px-2" onClick={cancel}>
          {copy.cancel}
        </Button>
      ) : null}
    </XpodSignInFrame>
  );
}

/** What the sign-in screen shows for a remembered identity: name, avatar, and where its Pod lives. */
function presentedIdentity(remembered: { displayName: string; avatarUrl?: string; webId?: string }): RememberedIdentity {
  const stored = readRememberedXpodLogin();
  const storageUrl = stored && (!remembered.webId || stored.webId === remembered.webId)
    ? stored.storageBinding.storageUrl
    : undefined;
  const kind = xpodStorageLocationKind(storageUrl);
  return {
    displayName: remembered.displayName,
    ...(remembered.avatarUrl ? { avatarUrl: remembered.avatarUrl } : {}),
    ...(storageUrl ? { storage: { kind, label: kind === 'cloud' ? copy.storageCloud : copy.storageEdge } } : {}),
  };
}

function storageSelectionState(
  runtime: ReturnType<typeof useXpodSolidRuntime>,
  state: WebIdAuthState,
): StorageSelectionState | undefined {
  if (state.status !== 'authenticated') return undefined;
  // A Pod open failure is not a WebID login failure: report it at the storage
  // step so retry reopens the Pod instead of restarting OIDC.
  if (runtime.podError?.webId === state.webId) {
    return { status: 'error', message: podFailureMessage };
  }
  if (runtime.currentPod === undefined) return { status: 'waiting_for_binding' };

  const selected = runtime.selectedStorage ?? {
    webId: runtime.currentPod.webId,
    storageUrl: runtime.currentPod.podUrl,
  };
  const sessionPodUrl = runtime.state.status === 'authenticated' ? runtime.state.podUrl : undefined;
  const matches = runtime.currentPod.webId === state.webId
    && selected.webId === runtime.currentPod.webId
    && sameUrl(selected.storageUrl, runtime.currentPod.podUrl)
    && (sessionPodUrl === undefined || sameUrl(runtime.currentPod.podUrl, sessionPodUrl));

  if (matches) return { status: 'ready', selected };
  return {
    status: 'conflict',
    message: '当前 WebID 已登录，但选中的 Pod 与该身份不一致。',
  };
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function rememberedWebIdLogin(activeWebId?: string): RememberedWebIdLogin | undefined {
  const remembered = readRememberedXpodLogin();
  if (!remembered) return undefined;
  // A remembered identity only applies to the WebID it was verified for.
  if (activeWebId && activeWebId !== remembered.webId) return undefined;
  return {
    displayName: remembered.account.displayName
      ?? remembered.account.username
      ?? remembered.account.email
      ?? 'Xpod',
    ...(remembered.account.avatarUrl ? { avatarUrl: remembered.account.avatarUrl } : {}),
    webId: remembered.webId,
    routeId: remembered.routeId,
  };
}

type RememberedCapableState = Extract<WebIdAuthState, { remembered?: RememberedWebIdLogin }>;

function withRemembered<T extends RememberedCapableState>(state: T, activeWebId?: string): T {
  const remembered = rememberedWebIdLogin(activeWebId);
  return remembered ? { ...state, remembered } as T : state;
}

type PresentedWebIdAuthState = WebIdAuthState | (Extract<WebIdAuthState, { status: 'error' }> & { remembered: RememberedWebIdLogin });

function runtimeState(state: ReturnType<typeof useXpodSolidRuntime>['state']): PresentedWebIdAuthState {
  switch (state.status) {
    case 'loading':
      return withRemembered({ status: 'restoring' });
    case 'anonymous':
      return withRemembered({ status: 'anonymous' });
    case 'expired':
      return withRemembered({ status: 'expired' }, state.webId);
    case 'authenticated':
      return { status: 'authenticated', webId: state.webId };
    case 'error': {
      const remembered = rememberedWebIdLogin(state.webId);
      // Presentation metadata enables a deliberate retry; it never changes
      // the failed session into anonymous (which would auto-start) or authenticated.
      return { status: 'error', message: state.error.message, retryRouteId: 'xpod-current-origin',
        ...(remembered ? { remembered } : {}) };
    }
  }
}
