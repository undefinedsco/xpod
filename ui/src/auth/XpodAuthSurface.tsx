import type { ReactNode } from 'react';
import {
  AuthSurface,
  type AuthSurfaceProps,
} from '@undefineds.co/shared-ui';
import {
  AccountCredentialsView,
  type AccountCredentialsViewProps,
} from './XpodAccountViews';
import { getXpodAuthSurfaceHost, useXpodAuthWindowSurface } from './xpod-auth-surface-host';
import { WebAccountLayout } from './WebAccountLayout';

export type XpodAuthSurfaceProps = Omit<
  AuthSurfaceProps,
  'host' | 'presentation' | 'className' | 'contentClassName'
>;

export interface XpodBlockingAccountCredentialsSurfaceProps extends AccountCredentialsViewProps {
  surface: 'page';
  surfaceTitle: string;
  footer?: ReactNode;
}

/**
 * Shared WebID authentication and CSS Account documents have distinct owners.
 * This shared surface is reserved for WebID gates in either host.
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
export function XpodAccountPageSurface({ title, children, presentation = 'compact' }: Pick<XpodAuthSurfaceProps, 'title' | 'children'> & {
  presentation?: 'standard' | 'compact';
}) {
  const host = getXpodAuthSurfaceHost();
  useXpodAuthWindowSurface(host === 'window' && presentation === 'compact', 'account');
  return <WebAccountLayout title={title} presentation={presentation} host={host}>{children}</WebAccountLayout>;
}

/** Fixed product wrapper for blocking CSS Account credential states. */
export function XpodBlockingAccountCredentialsSurface(
  props: XpodBlockingAccountCredentialsSurfaceProps,
) {
  const host = getXpodAuthSurfaceHost();
  const presentation = 'compact' as const;
  useXpodAuthWindowSurface(host === 'window' && presentation === 'compact', 'account');

  return (
    <WebAccountLayout
      title={props.surfaceTitle}
      description={props.mode === 'register' ? '创建你的 Xpod 账号，开始使用个人存储空间。' : '登录以继续使用你的身份与个人存储空间。'}
      presentation={presentation}
      host={host}
    >
      <AccountCredentialsView {...props} frame="bare" showHeader={false} presentation={presentation} />
      {props.footer ? <div className="mt-6 space-y-3 border-t pt-5">{props.footer}</div> : null}
    </WebAccountLayout>
  );
}
