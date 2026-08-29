import {
  AuthSurface,
  LoginAccountView,
  LoginConnectingView,
  LoginFailureView,
  LoginRestoringView,
  WebIdLoginEntryView,
} from '@undefineds.co/shared-ui';
import type { RememberedWebIdLogin, StorageSelectionState, WebIdAuthState } from '@undefineds.co/solid-sdk';
import { useRef, useState, type ReactNode } from 'react';
import { useXpodAuth } from '../auth/useXpodAuth';
import { XpodLoginBrand } from '../auth/XpodLoginBrand';
import { getXpodAuthSurfaceHost } from '../auth/xpod-auth-surface-host';
import { readRememberedXpodLogin } from '../auth/xpod-remembered-login';
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

export function WebIdAuthBoundary({ children }: { children: ReactNode }) {
  const runtime = useXpodSolidRuntime();
  const auth = useXpodAuth();
  const state = runtimeState(runtime.state);
  const storageState = storageSelectionState(runtime, state);
  // Login/switch failures must surface here: the boundary fires the async
  // auth actions, so an unobserved rejection would otherwise dead-end the UI.
  const [actionError, setActionError] = useState<string>();
  const [pending, setPending] = useState(false);
  const actionVersion = useRef(0);
  const reportActionError = (error: unknown) => {
    console.error('[WebIdAuthBoundary] authentication action failed', error);
    setActionError(actionFailureMessage);
  };
  const runAction = (action: () => Promise<unknown>) => {
    const version = ++actionVersion.current;
    setActionError(undefined);
    setPending(true);
    void action().catch((error) => {
      if (version === actionVersion.current) reportActionError(error);
    }).finally(() => {
      if (version === actionVersion.current) setPending(false);
    });
  };
  const startLogin = () => runAction(() => auth.startLogin());
  const retry = () => {
    if (state.status === 'authenticated') {
      runtime.retryPodOpen?.();
    } else {
      runAction(() => auth.retryLogin());
    }
  };
  const cancel = () => {
    auth.cancelLogin();
    actionVersion.current += 1;
    setPending(false);
    setActionError(undefined);
  };
  const switchAccount = () => runAction(async () => {
    const result = await auth.switchAccount();
    if (result.status === 'error') {
      throw new Error('Switch account could not clear both sessions');
    }
  });

  // Keep the same WebID + selected Pod readiness gate. Only the host's
  // presentation changes: Xpod has one fixed login route, not a route picker.
  if (state.status === 'authenticated' && storageState?.status === 'ready') {
    return <>{children}</>;
  }

  const remembered = 'remembered' in state ? state.remembered : undefined;
  const restoring = state.status === 'restoring';
  const connecting = pending || auth.webIdState.status === 'connecting';
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
        secondaryLabel="取消当前登录"
        onSecondary={cancel}
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
    content = (
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
      />
    ) : <LoginRestoringView label="正在打开选中的 Pod。" />;
  } else if (remembered) {
    content = (
      <LoginAccountView
        name={remembered.displayName}
        avatarUrl={remembered.avatarUrl}
        bindingLabel="Xpod"
        expired={state.status === 'expired'}
        expiredTitle={rememberedCopy.expiredTitle}
        enterLabel={state.status === 'expired'
          ? rememberedCopy.reauthenticateLabel(remembered.displayName)
          : rememberedCopy.continueLabel(remembered.displayName)}
        switchLabel={rememberedCopy.switchAccountLabel}
        onEnter={startLogin}
        onReauthenticate={retry}
        onSwitchAccount={switchAccount}
      />
    );
  } else if (state.status === 'error' || state.status === 'expired') {
    content = (
      <LoginFailureView
        title={state.status === 'expired' ? rememberedCopy.expiredTitle : '无法登录 Xpod'}
        description={state.status === 'error' ? state.message : '请重新登录后继续。'}
        primaryLabel="重试"
        onPrimary={retry}
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
    <AuthSurface
      mode="page"
      title="登录 Xpod"
      presentation="compact"
      host={getXpodAuthSurfaceHost()}
      lead={lead}
    >
      {content}
    </AuthSurface>
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

function runtimeState(state: ReturnType<typeof useXpodSolidRuntime>['state']): WebIdAuthState {
  switch (state.status) {
    case 'loading':
      return withRemembered({ status: 'restoring' });
    case 'anonymous':
      return withRemembered({ status: 'anonymous' });
    case 'expired':
      return withRemembered({ status: 'expired' }, state.webId);
    case 'authenticated':
      return { status: 'authenticated', webId: state.webId };
    case 'error':
      return { status: 'error', message: state.error.message, retryRouteId: 'xpod-current-origin' };
  }
}
