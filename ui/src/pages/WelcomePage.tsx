import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@undefineds.co/shared-ui';
import {
  type AccountCredentialField,
  type AccountCredentialsValues,
} from '../auth/XpodAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { persistReturnTo, consumeReturnTo, getReturnToFromLocation } from '../utils/returnTo';
import {
  checkRegistrationUsernameAvailability,
  getRegistrationUsernameError,
  normalizeRegistrationUsername,
} from '../utils/registration';
import {
  RegistrationError,
  RegistrationProvisioningNotReadyError,
  bootstrapAccountPasswordLogin,
  completeRegistrationProvisioning,
  loginAccountPassword,
  retryRegistrationReadiness,
  type RegistrationFlowOptions,
} from '../utils/registration-flow';
import { readPendingXpodAccountEmail, rememberPendingXpodAccountEmail } from '../auth/xpod-remembered-login';
import { storeAccountSessionToken, storedAccountTokenHeaders } from '../utils/account-session';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import { XpodAccountPageSurface, XpodBlockingAccountCredentialsSurface } from '../auth/XpodAuthSurface';
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
  const { controls, idpIndex, isLoggedIn, hasOidcPending } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isRegister = initialIsRegister;
  const [values, setValues] = useState<AccountCredentialsValues>({
    username: '',
    email: readPendingXpodAccountEmail(undefined, idpIndex) ?? '',
    password: '',
    confirmation: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);
  const [isUsernameAvailable, setIsUsernameAvailable] = useState<boolean | null>(null);
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [usernameAvailabilityError, setUsernameAvailabilityError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingProvisioning, setPendingProvisioning] = useState<RegistrationFlowOptions>();

  const normalizedUsername = normalizeRegistrationUsername(values.username ?? '');
  const usernameError = isRegister ? getRegistrationUsernameError(normalizedUsername) : undefined;

  useEffect(() => {
    const returnTo = getReturnToFromLocation();
    if (returnTo) persistReturnTo(returnTo);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isRegister || !normalizedUsername) {
      queueMicrotask(() => {
        if (cancelled) return;
        setIsCheckingUsername(false);
        setIsUsernameAvailable(null);
        setUsernameSuggestions([]);
        setUsernameAvailabilityError(null);
      });
      return () => { cancelled = true; };
    }

    if (usernameError) {
      queueMicrotask(() => {
        if (cancelled) return;
        setIsCheckingUsername(false);
        setIsUsernameAvailable(false);
        setUsernameSuggestions([]);
        setUsernameAvailabilityError(usernameError);
      });
      return () => { cancelled = true; };
    }

    queueMicrotask(() => {
      if (!cancelled) setIsCheckingUsername(true);
    });
    const timer = window.setTimeout(async () => {
      const result = await checkRegistrationUsernameAvailability(normalizedUsername, idpIndex);
      if (cancelled) return;
      setIsCheckingUsername(false);
      setIsUsernameAvailable(result.available);
      setUsernameSuggestions(result.suggestions);
      setUsernameAvailabilityError(result.error ?? null);
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [idpIndex, isRegister, normalizedUsername, usernameError]);

  if (isLoggedIn && !pendingProvisioning) {
    return <Navigate to="/.account/create-pod/" replace state={{ next: hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/' }} />;
  }

  const updateValues = (next: AccountCredentialsValues) => {
    setValues(next);
    if (next.email !== values.email) setEmailError(null);
    setFormError(null);
  };

  const handleFieldChange = (field: AccountCredentialField, value: string) => {
    if (field === 'email') setEmailError(null);
    if (field === 'username') setUsernameAvailabilityError(null);
    setFormError(null);
    setValues((current) => ({ ...current, [field]: value }));
  };

  const finishRegistration = async (accountToken: string, username: string) => {
    const options = {
      accountIndexUrl: await resolveHostedAccountControlUrl(idpIndex, fetch, idpIndex) ?? '/.account/',
      accountToken,
      username,
    };
    try {
      const result = await completeRegistrationProvisioning(options);
      window.location.href = result.redirectedToConsent ? '/.account/oidc/consent/' : '/.account/create-pod/';
    } catch (error) {
      if (!(error instanceof RegistrationProvisioningNotReadyError)) throw error;
      setPendingProvisioning(options);
      setValues((current) => ({ ...current, password: '', confirmation: '' }));
    }
  };

  const retryReadiness = async () => {
    if (!pendingProvisioning || isSubmitting) return;
    setIsSubmitting(true);
    setFormError(null);
    try {
      const result = await retryRegistrationReadiness(pendingProvisioning);
      window.location.href = result.redirectedToConsent ? '/.account/oidc/consent/' : '/.account/account/';
    } catch {
      setFormError('暂时无法确认存储空间状态。账号和已创建的空间会保留，请稍后重试。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (submitted: AccountCredentialsValues) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setEmailError(null);
    setFormError(null);

    const email = submitted.email?.trim() ?? '';
    const password = submitted.password;

    try {
      if (isRegister) {
        const username = normalizeRegistrationUsername(submitted.username ?? '');
        const normalizedUsernameError = getRegistrationUsernameError(username);
        if (normalizedUsernameError) {
          setIsUsernameAvailable(false);
          setUsernameAvailabilityError(normalizedUsernameError);
          return;
        }

        const availability = await checkRegistrationUsernameAvailability(username, idpIndex);
        const fallbackLoginUrl = await resolveHostedAccountControlUrl(controls?.password?.login, fetch, idpIndex)
          ?? '/.account/login/password/';
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

        if (!availability.available) {
          let recoveredAccountToken: string | undefined;
          try {
            recoveredAccountToken = await recoverExistingAccount();
          } catch {
            // An unavailable Pod name may still be independent from this account.
          }

          if (recoveredAccountToken) {
            await finishRegistration(recoveredAccountToken, username);
            return;
          }

          setIsUsernameAvailable(false);
          setUsernameSuggestions(availability.suggestions);
          setUsernameAvailabilityError(availability.error ?? 'Pod 名称已被占用。');
          return;
        }
        if (availability.error) {
          setIsUsernameAvailable(false);
          setUsernameAvailabilityError(availability.error);
          return;
        }

        let accountToken: string;
        const recoveredAccountToken = await recoverExistingAccount().catch(() => undefined);
        if (recoveredAccountToken) {
          accountToken = recoveredAccountToken;
        } else {
          try {
            const bootstrap = await bootstrapAccountPasswordLogin({
              accountCreateUrl: await resolveHostedAccountControlUrl(controls?.account?.create, fetch, idpIndex)
                ?? '/.account/account/',
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

        await finishRegistration(accountToken, username);
        return;
      }

      const loginUrl = await resolveHostedAccountControlUrl(controls?.password?.login, fetch, idpIndex)
        ?? '/.account/login/password/';
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        // Xpod is a trusted local desktop host. Remember this Account inside
        // the live desktop process so a renderer recreated from the tray can
        // resume the single WebID login without asking for the password again.
        body: JSON.stringify({ email, password, remember: true }),
      });
      const json = await response.json().catch(() => ({})) as { authorization?: unknown; location?: unknown };

      if (!response.ok) {
        setFormError(safeXpodLoginMessage(response.status));
        return;
      }

      storeAccountSessionToken(typeof json.authorization === 'string' ? json.authorization : undefined);
      // CSS owns the password form; the Xpod host remembers only this public
      // identity hint after the eventual Account + WebID + Pod composition.
      rememberPendingXpodAccountEmail(email, undefined, idpIndex);
      const locationHeader = response.headers.get('Location');
      if (typeof json.location === 'string' && json.location) {
        window.location.href = json.location;
        return;
      }
      if (locationHeader) {
        window.location.href = locationHeader;
        return;
      }

      const returnTo = consumeReturnTo();
      if (returnTo) {
        window.location.href = returnTo;
        return;
      }

      try {
        const consentCheck = await fetch('/.account/oidc/consent/', {
          headers: storedAccountTokenHeaders(),
          credentials: 'include',
        });
        if (consentCheck.ok) {
          window.location.href = '/.account/oidc/consent/';
          return;
        }
      } catch {
        // Continue to storage setup when no consent request is pending.
      }
      window.location.href = '/.account/create-pod/';
    } catch (error: unknown) {
      if (error instanceof RegistrationError && error.code === 'EMAIL_ALREADY_REGISTERED') {
        setEmailError(error.message);
      } else if (error instanceof RegistrationError && error.code === 'USERNAME_ALREADY_TAKEN') {
        setIsUsernameAvailable(false);
        setUsernameAvailabilityError(error.message);
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
    navigate({
      pathname: mode === 'register' ? '/.account/login/password/register/' : '/.account/login/password/',
      search: location.search,
    });
    setValues({ username: '', email: '', password: '', confirmation: '' });
    setIsCheckingUsername(false);
    setIsUsernameAvailable(null);
    setUsernameSuggestions([]);
    setUsernameAvailabilityError(null);
    setEmailError(null);
    setFormError(null);
  };

  const handleCancel = async () => {
    const cancelUrl = controls?.oidc?.cancel;
    if (!cancelUrl || !hasOidcPending || isCancelling) return;
    setIsCancelling(true);
    setFormError(null);
    try {
      const response = await fetch(cancelUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
      });
      const body = await response.json().catch(() => ({})) as { location?: unknown };
      if (!response.ok || typeof body.location !== 'string' || !body.location) {
        setFormError(safeXpodAuthorizationCancelMessage());
        return;
      }
      window.location.href = body.location;
    } catch {
      setFormError(safeXpodAuthorizationCancelMessage());
    } finally {
      setIsCancelling(false);
    }
  };

  if (pendingProvisioning) {
    return (
      <XpodAccountPageSurface title="正在确认存储空间">
        <div className="space-y-6">
          <p role="status" aria-live="polite" className="text-sm leading-relaxed text-muted-foreground">
            账号和存储空间已创建，正在确认身份与存储的关联。无需重新注册或创建。
          </p>
          {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
          <Button type="button" className="w-full" disabled={isSubmitting} onClick={() => void retryReadiness()}>
            {isSubmitting ? '正在确认…' : '重试确认'}
          </Button>
        </div>
      </XpodAccountPageSurface>
    );
  }

  return (
    <XpodBlockingAccountCredentialsSurface
      surface="page"
      surfaceTitle={isRegister ? xpodAccountPageCopy.registerSurfaceTitle : xpodAccountPageCopy.loginSurfaceTitle}
      mode={isRegister ? 'register' : 'login'}
      values={values}
      onChange={updateValues}
      onFieldChange={handleFieldChange}
      onSubmit={handleSubmit}
      onModeChange={isRegister ? toggleMode : undefined}
      pending={isSubmitting || isCancelling}
      errors={{
        ...(emailError ? { email: emailError } : {}),
        ...(formError ? { form: formError } : {}),
        ...(isRegister && usernameAvailabilityError && !isCheckingUsername ? { username: usernameAvailabilityError } : {}),
      }}
      usernameAvailability={isCheckingUsername
        ? 'checking'
        : isUsernameAvailable === true
          ? 'available'
          : isUsernameAvailable === false
            ? { status: 'unavailable', message: usernameAvailabilityError ?? undefined }
            : 'idle'}
      usernameSuggestions={usernameSuggestions}
      copy={xpodAccountCredentialsCopy}
      footer={!isRegister ? (
        <>
          {!isRegister && hasOidcPending && controls?.oidc?.cancel ? (
            <Button type="button" variant="outline" className="w-full" disabled={isSubmitting || isCancelling} onClick={handleCancel}>
              {isCancelling ? xpodAccountPageCopy.cancellingAuthorization : xpodAccountPageCopy.cancelAuthorization}
            </Button>
          ) : null}
          {!isRegister ? (
            <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
              <Button
                type="button"
                variant="ghost"
                className="h-auto px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground"
                disabled={isSubmitting}
                onClick={() => toggleMode('register')}
              >
                创建账号
              </Button>
              <span aria-hidden="true" className="text-border">·</span>
              <Button
                type="button"
                variant="ghost"
                className="h-auto px-2 py-1 text-xs font-normal text-muted-foreground hover:text-foreground"
                disabled={isSubmitting}
                onClick={() => navigate({ pathname: '/.account/login/password/forgot/', search: location.search })}
              >
                {xpodAccountPageCopy.forgotPassword}
              </Button>
            </div>
          ) : null}
        </>
      ) : undefined}
    />
  );
}
