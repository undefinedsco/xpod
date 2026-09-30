import type { ReactNode } from 'react';
import {
  AuthSurface,
  IdpRegisterView,
  IdpSignInView,
  PodSignInFrame,
  type AuthSurfaceProps,
  type PodSignInCopy,
} from '@undefineds.co/shared-ui';
import {
  type AccountCredentialField,
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
  /** Password recovery and registration are pages of the account app; the host decides how to reach them. */
  onForgot?: () => void;
  onRegister?: () => void;
  /** Real links, for hosts that reach those pages by navigation. */
  forgotHref?: string;
  registerHref?: string;
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

/**
 * The application-side WebID gate frame: the native auth window in the desktop
 * shell, the full page in a browser. Keeps the native window geometry in step.
 */
export function XpodSignInFrame({ ariaLabel, children }: { ariaLabel: string; children: ReactNode }) {
  const host = getXpodAuthSurfaceHost();
  useXpodAuthWindowSurface(host === 'window');
  return (
    <PodSignInFrame presentation={host === 'window' ? 'window' : 'page'} ariaLabel={ariaLabel}>
      {children}
    </PodSignInFrame>
  );
}

/**
 * Explicit CSS Account document boundary; never used by WebID/App auth gates.
 * `bare` is for bodies that bring their own service bar and heading.
 */
export function XpodAccountPageSurface({ title, children, presentation = 'compact', bare = false }: Pick<XpodAuthSurfaceProps, 'title' | 'children'> & {
  presentation?: 'standard' | 'compact';
  bare?: boolean;
}) {
  const host = getXpodAuthSurfaceHost();
  useXpodAuthWindowSurface(host === 'window', 'account');
  return <WebAccountLayout title={title} presentation={presentation} host={host} bare={bare}>{children}</WebAccountLayout>;
}

/** Wording of the shared views is carried over from the account copy, so labels keep their accessible names. */
function credentialViewCopy(copy: AccountCredentialsViewProps['copy']): Partial<PodSignInCopy> {
  return {
    email: copy.emailLabel,
    password: copy.passwordLabel,
    username: copy.usernameLabel,
    signIn: copy.loginAction,
    registerSubmit: copy.registerAction,
    // The account app names its registration entry "创建账号" everywhere.
    registerLink: copy.registerAction,
    // Same wording as the embedded credentials form, which keeps the older view.
    rememberDevice: '记住账号',
  };
}

/** Fixed product wrapper for blocking CSS Account credential states (presentation only). */
export function XpodBlockingAccountCredentialsSurface(
  props: XpodBlockingAccountCredentialsSurfaceProps,
) {
  const host = getXpodAuthSurfaceHost();
  useXpodAuthWindowSurface(host === 'window', 'account');
  const {
    mode, values, onChange, onSubmit, onFieldChange, onModeChange, rememberAccount = true, onRememberAccountChange,
    pending = false, errors, copy, surfaceTitle, footer, onForgot, onRegister, forgotHref, registerHref,
  } = props;
  const service = { serviceName: 'Xpod', serviceHost: window.location.host, copy: credentialViewCopy(copy) };
  const changeField = (field: AccountCredentialField, value: string) => {
    onChange({ ...values, [field]: value });
    onFieldChange?.(field, value);
  };


  return (
    <WebAccountLayout title={surfaceTitle} host={host} bare>
      {mode === 'register' ? (
        <IdpRegisterView
          {...service}
          requireUsername={false}
          pending={pending}
          defaultEmail={values.email}
          error={errors?.form}
          fieldErrors={{ email: errors?.email, password: errors?.password }}
          onFieldChange={changeField}
          onSubmit={(submitted) => void onSubmit({ ...values, ...submitted })}
          onSignIn={onModeChange ? () => onModeChange('login') : undefined}
        />
      ) : (
        <IdpSignInView
          {...service}
          pending={pending}
          remember={rememberAccount}
          defaultEmail={values.email}
          error={errors?.form}
          fieldErrors={{ email: errors?.email, password: errors?.password }}
          onFieldChange={changeField}
          onRememberChange={onRememberAccountChange}
          onSubmit={(submitted) => void onSubmit({ ...values, ...submitted })}
          onForgot={onForgot}
          forgotHref={forgotHref}
          registerHref={registerHref}
          onRegister={onRegister ?? (onModeChange ? () => onModeChange('register') : undefined)}
        />
      )}
      {footer ? <div className="space-y-3">{footer}</div> : null}
    </WebAccountLayout>
  );
}
