import { scopeAccountUrl } from '../utils/account-interaction-url';
import { useRef, useState, type ComponentProps } from 'react';
import { Button } from '@undefineds.co/shared-ui';
import {
  AccountCredentialsView,
  type AccountCredentialsValues,
} from './XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { loginAccountPassword } from '../utils/registration-flow';
import { clearAccountSessionToken, storeAccountSessionToken } from '../utils/account-session';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { normalizeXpodReturnTo } from './xpod-login-route';
import {
  readPendingXpodAccountEmail,
  rememberPendingXpodAccountEmail,
} from './xpod-remembered-login';
import { safeXpodLoginMessage, xpodAccountPageCopy, xpodAccountCredentialsCopy } from './xpod-account-copy';
import { XpodBlockingAccountCredentialsSurface } from './XpodAuthSurface';

export interface XpodAccountCredentialsProps {
  surface: 'page' | 'embedded';
  onAuthenticated?: () => void;
  initialEmail?: string;
}

class PasswordLoginStatusError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`Password login failed with status ${status}`);
    this.name = 'PasswordLoginStatusError';
    this.status = status;
  }
}

export function XpodAccountCredentials({
  surface,
  onAuthenticated,
  initialEmail,
}: XpodAccountCredentialsProps) {
  const { controls, idpIndex, refetchControls } = useAuth();
  const [values, setValues] = useState<AccountCredentialsValues>({
    email: initialEmail !== undefined ? initialEmail : readPendingXpodAccountEmail(undefined, idpIndex) ?? '',
    password: '',
  });
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [rememberAccount, setRememberAccount] = useState(true);
  const submittingRef = useRef(false);

  const handleSubmit = async (submitted: AccountCredentialsValues) => {
    if (submittingRef.current) return;

    submittingRef.current = true;
    setPending(true);
    setFormError(undefined);

    try {
      const loginUrl = await resolveHostedAccountControlUrl(controls?.password?.login, fetch, idpIndex)
        ?? scopeAccountUrl('/.account/login/password/');

      const login = await loginAccountPassword({
        email: submitted.email?.trim() ?? '',
        password: submitted.password,
        loginUrl,
        remember: rememberAccount,
        fetchImpl: async (input, init) => {
          const response = await fetch(typeof input === 'string' || input instanceof URL ? scopeAccountUrl(input) : input, init);
          if (!response.ok) throw new PasswordLoginStatusError(response.status);
          return response;
        },
      });
      storeAccountSessionToken(login.accountToken);
      rememberPendingXpodAccountEmail(submitted.email?.trim() ?? '', undefined, idpIndex);
      const confirmedState = await refetchControls();
      if (confirmedState?.status !== 'authenticated') {
        if (confirmedState?.status === 'anonymous') clearAccountSessionToken();
        setFormError('登录失败，请重试。');
        return;
      }
      await onAuthenticated?.();
    } catch (error: unknown) {
      setFormError(error instanceof PasswordLoginStatusError
        ? safeXpodLoginMessage(error.status)
        : safeXpodLoginMessage(500));
    } finally {
      submittingRef.current = false;
      setPending(false);
    }
  };

  const updateValues = (next: AccountCredentialsValues) => {
    setValues(next);
    if (formError) setFormError(undefined);
  };

  const surfaceProps = {
    surface: 'page' as const,
    surfaceTitle: '登录 Xpod',
    copy: xpodAccountCredentialsCopy,
    // Registration and password recovery are pages of the account app, so a
    // gate that owns its own surface links to them the same way the account
    // sign-in page does. Without them the Dashboard gate offered no way forward
    // for a user who has no account yet or forgot the password. The embedded
    // form is hosted inside a document that owns its layout and navigation, so
    // it stays self-contained.
    footer: surface === 'embedded' ? undefined : <AccountEntryLinks />,
    mode: 'login' as const,
    values,
    onChange: updateValues,
    onSubmit: handleSubmit,
    pending,
    rememberAccount,
    onRememberAccountChange: setRememberAccount,
    errors: formError ? { form: formError } : undefined,
  } satisfies ComponentProps<typeof XpodBlockingAccountCredentialsSurface>;

  return surface === 'embedded' ? (
    <AccountCredentialsView
      {...surfaceProps}
      presentation="compact"
      frame="bare"
      showHeader={false}
    />
  ) : (
    <XpodBlockingAccountCredentialsSurface {...surfaceProps} />
  );
}

/**
 * Secondary sign-in entries, matching the account sign-in page: creating an
 * account and recovering a forgotten password are pages of the account app, so
 * they stay plain links instead of in-surface state changes.
 */
export function AccountEntryLinks() {
  let search = '';
  try {
    const returnTo = normalizeXpodReturnTo(`${window.location.pathname}${window.location.search}`);
    if (returnTo) search = `?${new URLSearchParams({ returnTo })}`;
  } catch {
    // Account documents already belong to the server's OIDC interaction.
  }
  return (
    <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
      <Button
        asChild
        variant="ghost"
        className="h-auto px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground"
      >
        <a href={scopeAccountUrl(`/.account/login/password/register/${search}`)}>创建账号</a>
      </Button>
      <span aria-hidden="true" className="text-border">·</span>
      <Button
        asChild
        variant="ghost"
        className="h-auto px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground"
      >
        <a href={scopeAccountUrl(`/.account/login/password/forgot/${search}`)}>{xpodAccountPageCopy.forgotPassword}</a>
      </Button>
    </div>
  );
}
