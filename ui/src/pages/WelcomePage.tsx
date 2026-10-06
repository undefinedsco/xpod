import { useXpodAccountCredentialValues, useXpodAccountRememberChoice } from '../auth/useXpodAccountRememberChoice';
import { scopeAccountUrl } from '../utils/account-interaction-url';
import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@undefineds.co/shared-ui';
import {
  type AccountCredentialField,
  type AccountCredentialsValues,
} from '../auth/XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { persistReturnTo, consumeReturnTo, getReturnToFromLocation, consumeAccountContinuation } from '../utils/returnTo';
import {
} from '../utils/registration';
import {
  RegistrationError,
  bootstrapAccountPasswordLogin,
  loginAccountPassword,
} from '../utils/registration-flow';
import { rememberPendingXpodAccountEmail } from '../auth/xpod-remembered-login';
import { storeAccountSessionToken, storedAccountTokenHeaders } from '../utils/account-session';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { XpodBlockingAccountCredentialsSurface } from '../auth/XpodAuthSurface';
import {
  safeXpodAuthorizationCancelMessage,
  safeXpodLoginMessage,
  safeXpodRegistrationMessage,
  xpodAccountCredentialsCopy,
  xpodAccountPageCopy,
} from '../auth/xpod-account-copy';

interface WelcomePageProps {
  initialIsRegister?: boolean;
}

function safeRegistrationMessage(error: unknown): string {
  if (error instanceof RegistrationError) return error.message;
  return safeXpodRegistrationMessage();
}

export function WelcomePage({ initialIsRegister = false }: WelcomePageProps) {
  const { controls, idpIndex, isLoggedIn, hasOidcPending, isInitializing } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // The route decides the mode, but a router transition can land a frame after the click.
  // The switch is shown at once so the next field the user (or automation) touches already
  // belongs to the new form; the override lapses as soon as the route prop catches up.
  const [modeSwitch, setModeSwitch] = useState<{ from: boolean; register: boolean }>();
  const isRegister = modeSwitch && modeSwitch.from === initialIsRegister ? modeSwitch.register : initialIsRegister;
  const [values, setValues, credentialScope] = useXpodAccountCredentialValues(idpIndex, isInitializing);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rememberAccount, setRememberAccount] = useXpodAccountRememberChoice(idpIndex, isInitializing);
  const [isCancelling, setIsCancelling] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const returnTo = getReturnToFromLocation();
    if (returnTo) persistReturnTo(returnTo);
  }, []);

  if (isLoggedIn) {
    // 账号已登录不等于 Pod 就绪（设计 §4.1）：落到 Account 管理，由用户显式建 Pod。
    return <Navigate to={scopeAccountUrl('/.account/account/')} replace state={{ next: hasOidcPending ? scopeAccountUrl('/.account/oidc/consent/') : scopeAccountUrl('/.account/account/') }} />;
  }

  const updateValues = (next: AccountCredentialsValues) => {
    setValues(next);
    if (next.email !== values.email) setEmailError(null);
    setFormError(null);
  };

  const handleFieldChange = (field: AccountCredentialField, value: string) => {
    if (field === 'email') setEmailError(null);
    setFormError(null);
    setValues((current) => ({ ...current, [field]: value }));
  };

  // 注册只创建 Account（设计第二部分 §4.1 / U01–U03）：不再隐式 prepare 或创建 Pod。
  // 有挂起的授权时交给 consent 去给出"缺少 Pod"的出口；否则进入 Account 管理。
  const finishRegistration = () => {
    window.location.href = consumeAccountContinuation(hasOidcPending, scopeAccountUrl('/.account/account/'));
  };

  const handleSubmit = async (submitted: AccountCredentialsValues) => {
    if (isSubmitting || isInitializing) return;
    setIsSubmitting(true);
    setEmailError(null);
    setFormError(null);

    const email = submitted.email?.trim() ?? '';
    const password = submitted.password;

    try {
      if (isRegister) {
        // Registration completes the Account only (email + password). Pod name,
        // machine and storage belong to the Pod flow, never to this form.
        const fallbackLoginUrl = await resolveHostedAccountControlUrl(controls?.password?.login, fetch, idpIndex)
          ?? scopeAccountUrl('/.account/login/password/');
        const recoverExistingAccount = async (duplicateEmailRecovery = false): Promise<string> => {
          const login = await loginAccountPassword({
            duplicateEmailRecovery,
            email,
            fetchImpl: fetch,
            loginUrl: fallbackLoginUrl,
            password,
            remember: true,
          });
          storeAccountSessionToken(login.accountToken);
          return login.accountToken;
        };

        let accountToken: string;
        const recoveredAccountToken = await recoverExistingAccount().catch(() => undefined);
        if (recoveredAccountToken) {
          accountToken = recoveredAccountToken;
        } else {
          try {
            const bootstrap = await bootstrapAccountPasswordLogin({
              accountCreateUrl: await resolveHostedAccountControlUrl(controls?.account?.create, fetch, idpIndex)
                ?? scopeAccountUrl('/.account/account/'),
              email,
              password,
            });
            accountToken = bootstrap.accountToken;
            storeAccountSessionToken(accountToken);
          } catch (error: unknown) {
            if (!(error instanceof RegistrationError) || error.code !== 'EMAIL_ALREADY_REGISTERED') throw error;
            accountToken = await recoverExistingAccount(true);
          }
        }

        finishRegistration();
        return;
      }

      const loginUrl = await resolveHostedAccountControlUrl(controls?.password?.login, fetch, idpIndex)
        ?? scopeAccountUrl('/.account/login/password/');
      const response = await fetch(scopeAccountUrl(loginUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        // CSS owns the cookie lifetime for the explicit Account remember choice.
        body: JSON.stringify({ email, password, remember: rememberAccount }),
      });
      const json = await response.json().catch(() => ({})) as { authorization?: unknown; location?: unknown };

      if (!response.ok) {
        setFormError(safeXpodLoginMessage(response.status));
        return;
      }

      storeAccountSessionToken(typeof json.authorization === 'string' ? json.authorization : undefined);
      // CSS owns the password form; the Xpod host remembers only this public
      // identity hint after the eventual Account + WebID + Pod composition.
      rememberPendingXpodAccountEmail(email, undefined, idpIndex, rememberAccount);
      const locationHeader = response.headers.get('Location');
      if (typeof json.location === 'string' && json.location) {
        window.location.href = scopeAccountUrl(json.location);
        return;
      }
      if (locationHeader) {
        window.location.href = scopeAccountUrl(locationHeader);
        return;
      }

      const returnTo = consumeReturnTo();
      if (returnTo) {
        window.location.href = scopeAccountUrl(returnTo);
        return;
      }

      try {
        const consentCheck = await fetch(scopeAccountUrl('/.account/oidc/consent/'), {
          headers: storedAccountTokenHeaders(),
          credentials: 'include',
        });
        if (consentCheck.ok) {
          window.location.href = scopeAccountUrl('/.account/oidc/consent/');
          return;
        }
      } catch {
        // Continue to Account management when no consent request is pending.
      }
      // 登录成功不依赖 Pod 就绪（设计 §4.1）：落到 Account 管理，不自动进入建 Pod。
      window.location.href = scopeAccountUrl('/.account/account/');
    } catch (error: unknown) {
      if (error instanceof RegistrationError && error.code === 'EMAIL_ALREADY_REGISTERED') {
        setEmailError(error.message);
      } else if (isRegister) {
        setFormError(safeRegistrationMessage(error));
      } else {
        setFormError(safeXpodLoginMessage(500));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleMode = (mode: 'login' | 'register') => {
    setModeSwitch({ from: initialIsRegister, register: mode === 'register' });
    navigate({
      pathname: mode === 'register' ? scopeAccountUrl('/.account/login/password/register/') : scopeAccountUrl('/.account/login/password/'),
      search: location.search,
    });
    setValues({ email: '', password: '', confirmation: '' });
    setEmailError(null);
    setFormError(null);
  };

  const handleCancel = async () => {
    const cancelUrl = controls?.oidc?.cancel;
    if (!cancelUrl || !hasOidcPending || isCancelling) return;
    setIsCancelling(true);
    setFormError(null);
    try {
      const response = await fetch(scopeAccountUrl(cancelUrl), {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
      });
      const body = await response.json().catch(() => ({})) as { location?: unknown };
      if (!response.ok || typeof body.location !== 'string' || !body.location) {
        setFormError(safeXpodAuthorizationCancelMessage());
        return;
      }
      window.location.href = scopeAccountUrl(body.location);
    } catch {
      setFormError(safeXpodAuthorizationCancelMessage());
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <XpodBlockingAccountCredentialsSurface
      key={credentialScope ?? 'bootstrap'}
      surface="page"
      surfaceTitle={isRegister ? xpodAccountPageCopy.registerSurfaceTitle : xpodAccountPageCopy.loginSurfaceTitle}
      mode={isRegister ? 'register' : 'login'}
      values={values}
      onChange={updateValues}
      onFieldChange={handleFieldChange}
      onSubmit={handleSubmit}
      onModeChange={isRegister ? toggleMode : undefined}
      pending={isSubmitting || isCancelling}
      rememberAccount={rememberAccount}
      onRememberAccountChange={setRememberAccount}
      errors={{
        ...(emailError ? { email: emailError } : {}),
        ...(formError ? { form: formError } : {}),
      }}
      copy={xpodAccountCredentialsCopy}
      onRegister={() => toggleMode('register')}
      onForgot={() => navigate({ pathname: scopeAccountUrl('/.account/login/password/forgot/'), search: location.search })}
      footer={!isRegister && hasOidcPending && controls?.oidc?.cancel ? (
        <Button type="button" variant="outline" className="h-11 w-full rounded-lg" disabled={isSubmitting || isCancelling} onClick={handleCancel}>
          {isCancelling ? xpodAccountPageCopy.cancellingAuthorization : xpodAccountPageCopy.cancelAuthorization}
        </Button>
      ) : undefined}
    />
  );
}
