import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { LoginRestoringView } from '@undefineds.co/shared-ui';
import { XpodAuthSurface } from './XpodAuthSurface';
import { WebAccountFailureView } from './WebAccountViews';
import { getXpodProductLogoutState, retryXpodProductLogout, subscribeXpodProductLogout } from './xpod-product-logout';

const LogoutRecoveryOwner = createContext(false);

/** A product operation must survive Account/WebID gates replacing their children. */
export function XpodProductLogoutBoundary({ children }: { children: ReactNode }) {
  const hasOwner = useContext(LogoutRecoveryOwner);
  const state = useSyncExternalStore(subscribeXpodProductLogout, getXpodProductLogoutState, getXpodProductLogoutState);
  if (hasOwner) return <>{children}</>;
  const active = state.status !== 'idle';
  return (
    <LogoutRecoveryOwner.Provider value>
      {active && <XpodAuthSurface mode="page" title="退出 Xpod">
        {state.status === 'running' ? <LoginRestoringView label="正在退出…" /> : (
          <WebAccountFailureView
            title="退出未完成"
            description={state.step === 'account'
              ? '账号会话尚未退出，请重试完成退出。'
              : 'WebID 会话尚未退出，请重试完成退出。'}
            primaryLabel="重试退出"
            onPrimary={() => { void retryXpodProductLogout().catch(() => undefined); }}
          />
        )}
      </XpodAuthSurface>}
      {/* Keep the login controller mounted so a successful Switch continuation
          can run, while no protected content is usable during partial cleanup. */}
      <div className={active ? 'hidden' : 'contents'} aria-hidden={active || undefined} inert={active || undefined}>
        {children}
      </div>
    </LogoutRecoveryOwner.Provider>
  );
}
