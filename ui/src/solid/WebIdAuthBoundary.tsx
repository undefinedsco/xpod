import {
  LoginAccountView,
  LoginConnectingView,
  LoginFailureView,
  LoginRestoringView,
  WebIdLoginEntryView,
} from '@undefineds.co/shared-ui';
import type { RememberedWebIdLogin, StorageSelectionState, WebIdAuthState } from '@undefineds.co/solid-sdk';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { XpodProductLogoutBoundary } from '../auth/XpodProductLogoutBoundary';
import { XpodLocalLoginPreflight } from '../auth/XpodLocalLoginPreflight';
import { consumeXpodAccountSwitch, readXpodAccountSwitch, readXpodLoginCancelled, setXpodLoginCancelled } from '../auth/xpod-login-recovery';
import { createXpodLoginController } from '../auth/XpodLoginController';
import { XpodAuthSurface } from '../auth/XpodAuthSurface';
import { XpodLoginBrand } from '../auth/XpodLoginBrand';
import { AuthContext } from '../context/AuthContextValue';
import { isXpodAutomaticLoginBlocked, logoutXpodProduct, subscribeXpodProductLogout } from '../auth/xpod-product-logout';
import { clearRememberedXpodLogin, readRememberedXpodLogin } from '../auth/xpod-remembered-login';
import { useXpodSolidRuntime } from './useXpodSolidRuntime';

const rememberedCopy = {
  restoringLabel: '正在恢复 Xpod 会话…',
  continueLabel: (name: string) => `使用 ${name} 登录`,
  reauthenticateLabel: (name: string) => `重新登录 ${name}`,
  switchAccountLabel: '切换账号',
  expiredTitle: '会话已过期',
  connectingTitle: '正在登录…',
  connectingDetail: '请在授权页面完成登录。',
  cancelLabel: '取消',
};

const podFailureMessage = '无法打开选中的 Pod，请重试。';
const actionFailureMessage = '操作未完成，请重试。';

export function WebIdAuthBoundary(props: { children: ReactNode; autoStart?: boolean }) {
  return <XpodProductLogoutBoundary><WebIdAuthBoundaryContent {...props} /></XpodProductLogoutBoundary>;
}

function WebIdAuthBoundaryContent({
  children,
  autoStart = false,
}: {
  children: ReactNode;
  /** Xpod product routes continue their single fixed WebID flow without a second click. */
  autoStart?: boolean;
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

  if (preflight) return <XpodLocalLoginPreflight onReady={continueLogin} />;

  const remembered = 'remembered' in state ? state.remembered : undefined;
  const restoring = state.status === 'restoring';
  const connecting = pending || (autoStart && !loginCancelled && !automaticLoginBlocked && state.status === 'anonymous' && !actionError);
  const brand = <XpodLoginBrand compact showSubtitle />;
  let content: ReactNode;
  let lead: ReactNode;

  if (actionError) {
    content = (
      <LoginFailureView
        title="登录未完成"
        description={actionError}
        primaryLabel="重试"
        onPrimary={retry}
        secondaryLabel={switchRequested ? undefined : '返回登录'}
        onSecondary={switchRequested ? undefined : cancel}
      />
    );
  } else if (restoring) {
    lead = remembered ? undefined : brand;
    content = (
      <LoginRestoringView
        accountName={remembered?.displayName}
        avatarUrl={remembered?.avatarUrl}
        label={rememberedCopy.restoringLabel}
      />
    );
  } else if (connecting) {
    content = switchRequested ? <LoginRestoringView label="正在切换账号…" /> : (
      <LoginConnectingView
        title={rememberedCopy.connectingTitle}
        detail={rememberedCopy.connectingDetail}
        cancelLabel={rememberedCopy.cancelLabel}
        onCancel={cancel}
      />
    );
  } else if (state.status === 'authenticated') {
    // Valid WebID sessions stay valid while their Pod opens or retries.
    // Never turn a storage failure into a second login / provider selection.
    content = storageState?.status === 'conflict' || storageState?.status === 'error' ? (
      <LoginFailureView
        title={storageState.status === 'conflict' ? '存储绑定冲突' : '暂时无法打开 Pod'}
        description={storageState.message}
        primaryLabel="重试"
        onPrimary={retry}
        secondaryLabel="切换账号"
        onSecondary={switchAccount}
      />
    ) : <LoginRestoringView label="正在打开选中的 Pod。" />;
  } else if (remembered && !loginCancelled) {
    content = (
      <>
        {state.status === 'error' && <p role="alert" className="mb-3 text-center text-xs text-muted-foreground">{state.message}</p>}
        <LoginAccountView
          name={remembered.displayName}
          avatarUrl={remembered.avatarUrl}
          bindingLabel="Xpod"
          expired={state.status === 'expired' || state.status === 'error'}
          expiredTitle={state.status === 'error' ? '会话恢复未完成' : rememberedCopy.expiredTitle}
          enterLabel={state.status === 'expired' || state.status === 'error'
            ? rememberedCopy.reauthenticateLabel(remembered.displayName)
            : rememberedCopy.continueLabel(remembered.displayName)}
          switchLabel={rememberedCopy.switchAccountLabel}
          onEnter={startLogin}
          onReauthenticate={retry}
          onSwitchAccount={switchAccount}
        />
      </>
    );
  } else if (!loginCancelled && (state.status === 'error' || state.status === 'expired')) {
    content = (
      <LoginFailureView
        title={state.status === 'expired' ? rememberedCopy.expiredTitle : '无法登录 Xpod'}
        description={state.status === 'error' ? state.message : '请重新登录后继续。'}
        primaryLabel="重试"
        onPrimary={retry}
        secondaryLabel="返回登录"
        onSecondary={cancel}
      />
    );
  } else {
    content = (
      <WebIdLoginEntryView
        copy={{ title: '', startLabel: '登录', pendingLabel: rememberedCopy.connectingTitle }}
        logo={brand}
        onStart={startLogin}
      />
    );
  }
  return (
    <XpodAuthSurface
      mode="page"
      title="登录 Xpod"
      lead={lead}
    >
      {content}
    </XpodAuthSurface>
  );
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
