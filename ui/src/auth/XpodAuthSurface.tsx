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
import { XpodAccountServiceIntro } from './XpodAccountServiceIntro';
import { XpodDeploymentIdentity } from './XpodDeploymentIdentity';

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
export function XpodAccountPageSurface({ title, children, bare = false, intro, presentation = 'compact' }: Pick<XpodAuthSurfaceProps, 'title' | 'children'> & {
  presentation?: 'standard' | 'compact';
  bare?: boolean;
  /** Overrides the account-service introduction column of a browser page frame. */
  intro?: ReactNode;
}) {
  const host = getXpodAuthSurfaceHost();
  const compact = presentation === 'compact';
  useXpodAuthWindowSurface(host === 'window', compact ? 'account' : 'workspace');
  return (
    <WebAccountLayout
      title={title}
      host={compact ? host : 'document'}
      bare={bare}
      intro={intro ?? <XpodAccountServiceIntro serviceHost={window.location.host} />}
      serviceIcon={<XpodDeploymentIdentity />}
    >
      {children}
    </WebAccountLayout>
  );
}

/** Wording of the shared views is carried over from the account copy, so labels keep their accessible names. */
function credentialViewCopy(copy: AccountCredentialsViewProps['copy']): Partial<PodSignInCopy> {
  return {
    email: copy.emailLabel,
    password: copy.passwordLabel,
    username: copy.usernameLabel,
    signIn: copy.loginAction,
    registerSubmit: copy.registerAction,
    // The registration *entry* stays the shared navigation label ("注册账号");
    // only the submit action says "创建账号". Binding both to registerAction made
    // the sign-in footer read "没有账号？ 创建账号".
    // Same wording as the embedded credentials form, which keeps the older view.
    rememberDevice: '记住账号',
  };
}

/** Fixed product wrapper for blocking CSS Account credential states (presentation only). */
export function XpodBlockingAccountCredentialsSurface(
  props: XpodBlockingAccountCredentialsSurfaceProps,
) {
  const host = getXpodAuthSurfaceHost();
  const compact = props.mode !== 'register';
  useXpodAuthWindowSurface(host === 'window', compact ? 'account' : 'workspace');
  const {
    mode, values, onChange, onSubmit, onFieldChange, onModeChange, rememberAccount = true, onRememberAccountChange,
    pending = false, errors, copy, surfaceTitle, footer, onForgot, onRegister, forgotHref, registerHref,
  } = props;
  const service = { serviceName: 'Xpod', serviceHost: window.location.host, serviceIcon: <XpodDeploymentIdentity />, copy: credentialViewCopy(copy) };
  const changeField = (field: AccountCredentialField, value: string) => {
    onChange({ ...values, [field]: value });
    onFieldChange?.(field, value);
  };


  return (
    <WebAccountLayout
      title={surfaceTitle}
      host={compact ? host : 'document'}
      bare
      intro={<XpodAccountServiceIntro serviceHost={window.location.host} />}
    >
      {mode === 'register' ? (
        <IdpRegisterView
          {...service}
          requireUsername={false}
          pending={pending}
          defaultEmail={values.email}
          defaultPassword={values.password}
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
          defaultPassword={values.password}
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
