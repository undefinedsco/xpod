import {
  AuthSurface,
  type AuthSurfaceProps,
} from '@undefineds.co/shared-ui';
import {
  AccountCredentialsSurface,
  AccountCredentialsView,
  type AccountCredentialsSurfaceProps,
} from './XpodAccountViews';
import { getXpodAuthSurfaceHost, useXpodAuthWindowSurface } from './xpod-auth-surface-host';
import { WebAccountLayout } from './WebAccountLayout';

export type XpodAuthSurfaceProps = Omit<
  AuthSurfaceProps,
  'host' | 'presentation' | 'className' | 'contentClassName'
>;

export type XpodBlockingAccountCredentialsSurfaceProps = Omit<
  AccountCredentialsSurfaceProps,
  'host' | 'presentation' | 'surfaceClassName' | 'contentClassName'
>;

/**
 * CSS Account documents and App auth windows have distinct presentation owners.
 * Shared modal/embedded surfaces remain available to the App, not Web pages.
 */
export function XpodAuthSurface(props: XpodAuthSurfaceProps) {
  const host = getXpodAuthSurfaceHost();
  useXpodAuthWindowSurface(host === 'window');

  return (
    <AuthSurface
      {...props}
      presentation="compact"
      host={host}
    />
  );
}

/** Explicit CSS Account document boundary; never used by WebID/App auth gates. */
export function XpodAccountPageSurface({ title, children }: Pick<XpodAuthSurfaceProps, 'title' | 'children'>) {
  const host = getXpodAuthSurfaceHost();
  useXpodAuthWindowSurface(host === 'window', 'account');
  return <WebAccountLayout title={title}>{children}</WebAccountLayout>;
}

/** Fixed product wrapper for blocking CSS Account credential states. */
export function XpodBlockingAccountCredentialsSurface(
  props: XpodBlockingAccountCredentialsSurfaceProps,
) {
  const host = getXpodAuthSurfaceHost();
  const isAccountDocument = props.surface === 'page';
  useXpodAuthWindowSurface(host === 'window', isAccountDocument ? 'account' : 'auth');

  if (isAccountDocument) {
    return (
      <WebAccountLayout
        title={props.surfaceTitle}
        description={props.mode === 'register' ? '创建你的 Xpod 账号，开始使用个人存储空间。' : '登录以继续使用你的身份与个人存储空间。'}
      >
        <AccountCredentialsView {...props} frame="bare" showHeader={false} presentation="standard" />
        {props.footer ? <div className="mt-6 space-y-3 border-t pt-5">{props.footer}</div> : null}
      </WebAccountLayout>
    );
  }

  return (
    <AccountCredentialsSurface
      {...props}
      presentation="compact"
      host={host}
    />
  );
}
