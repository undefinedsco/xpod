import { useRef, useState, type ReactNode } from 'react';
import {
  AccountCredentialsSurface,
  type AccountCredentialsValues,
} from './XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { loginAccountPassword } from '../utils/registration-flow';
import { clearAccountSessionToken, storeAccountSessionToken } from '../utils/account-session';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { XpodLoginBrand } from './XpodLoginBrand';
import {
  readPendingXpodAccountEmail,
  rememberPendingXpodAccountEmail,
} from './xpod-remembered-login';
import { getXpodAuthSurfaceHost } from './xpod-auth-surface-host';
import { safeXpodLoginMessage, xpodAccountCredentialsCopy } from './xpod-account-copy';

export interface XpodAccountCredentialsProps {
  surface: 'page' | 'modal' | 'embedded';
  presentation?: 'standard' | 'compact';
  lead?: ReactNode;
  onAuthenticated?: () => void;
  onClose?: () => void;
  surfaceClassName?: string;
  contentClassName?: string;
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
  presentation = 'standard',
  lead,
  onAuthenticated,
  onClose,
  surfaceClassName,
  contentClassName,
  initialEmail,
}: XpodAccountCredentialsProps) {
  const { controls, idpIndex, isAnonymous, refetchControls } = useAuth();
  const [values, setValues] = useState<AccountCredentialsValues>({
    email: initialEmail !== undefined ? initialEmail : readPendingXpodAccountEmail(undefined, idpIndex) ?? '',
    password: '',
  });
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmit = async (submitted: AccountCredentialsValues) => {
    if (submittingRef.current) return;

    submittingRef.current = true;
    setPending(true);
    setFormError(undefined);

    try {
      const loginUrl = await resolveHostedAccountControlUrl(controls?.password?.login, fetch, idpIndex)
        ?? '/.account/login/password/';

      const login = await loginAccountPassword({
        email: submitted.email?.trim() ?? '',
        password: submitted.password,
        loginUrl,
        remember: true,
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok) throw new PasswordLoginStatusError(response.status);
          return response;
        },
      });
      storeAccountSessionToken(login.accountToken);
      rememberPendingXpodAccountEmail(submitted.email?.trim() ?? '', undefined, idpIndex);
      await refetchControls();
      if (isAnonymous?.()) {
        clearAccountSessionToken();
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

  return (
    <AccountCredentialsSurface
      surface={surface}
      surfaceTitle="登录 Xpod"
      presentation={presentation}
      host={surface === 'modal' ? getXpodAuthSurfaceHost() : 'document'}
      lead={lead ?? (presentation === 'compact' ? <XpodLoginBrand compact /> : undefined)}
      copy={xpodAccountCredentialsCopy}
      surfaceClassName={surfaceClassName}
      contentClassName={contentClassName ?? (presentation === 'compact'
        ? 'flex h-full min-h-0 flex-1 flex-col justify-center px-5 pb-5 pt-4'
        : undefined)}
      onClose={surface === 'modal' ? onClose : undefined}
      closeLabel={surface === 'modal' && onClose ? '关闭登录' : undefined}
      mode="login"
      values={values}
      onChange={updateValues}
      onSubmit={handleSubmit}
      pending={pending}
      errors={formError ? { form: formError } : undefined}
    />
  );
}
