import { useRef, useState } from 'react';
import {
  AccountCredentialsView,
  AuthSurface,
  type AccountCredentialsCopy,
  type AccountCredentialsValues,
} from '@undefineds.co/shared-ui';
import { useAuth } from '../context/AuthContextValue';
import { loginAccountPassword } from '../utils/registration-flow';
import { storeAccountSessionToken } from '../utils/account-session';

export interface XpodAccountCredentialsProps {
  surface: 'modal' | 'embedded';
  onAuthenticated?: () => void;
  onClose?: () => void;
}

const credentialsCopy: AccountCredentialsCopy = {
  productName: 'Xpod account',
  loginTitle: 'Sign in',
  registerTitle: 'Create an account',
  usernameLabel: 'Pod name',
  usernamePlaceholder: 'Choose a Pod name',
  emailLabel: 'Email',
  emailPlaceholder: 'you@example.com',
  passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password',
  confirmationLabel: 'Confirm password',
  confirmationPlaceholder: 'Enter it again',
  loginAction: 'Sign in',
  registerAction: 'Create account',
  switchToRegister: 'Create an account',
  switchToLogin: 'Back to sign in',
  usernameChecking: 'Checking Pod name…',
  usernameAvailable: 'Pod name is available',
  usernameUnavailable: 'Pod name is unavailable',
  suggestionsLabel: 'Available suggestions',
  mismatchError: 'Passwords do not match',
};

function safeLoginMessage(status: number): string {
  if (status === 401 || status === 403) return 'Invalid email or password.';
  if (status === 429) return 'Too many attempts. Please try again later.';
  return 'Sign-in failed. Please try again.';
}

function sameOriginUrl(value: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? value : undefined;
  } catch {
    return undefined;
  }
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
  onClose,
}: XpodAccountCredentialsProps) {
  const { controls, refetchControls } = useAuth();
  const [values, setValues] = useState<AccountCredentialsValues>({ email: '', password: '' });
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const submittingRef = useRef(false);

  const handleSubmit = async (submitted: AccountCredentialsValues) => {
    if (submittingRef.current) return;

    submittingRef.current = true;
    setPending(true);
    setFormError(undefined);

    try {
      const loginUrl = sameOriginUrl(controls?.password?.login || '/.account/login/password/');
      if (!loginUrl) {
        setFormError('Sign-in failed. Please try again.');
        return;
      }

      const login = await loginAccountPassword({
        email: submitted.email?.trim() ?? '',
        password: submitted.password,
        loginUrl,
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init);
          if (!response.ok) throw new PasswordLoginStatusError(response.status);
          return response;
        },
      });
      storeAccountSessionToken(login.accountToken);
      await refetchControls();
      await onAuthenticated?.();
    } catch (error: unknown) {
      setFormError(error instanceof PasswordLoginStatusError
        ? safeLoginMessage(error.status)
        : 'Sign-in failed. Please try again.');
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
    <AuthSurface
      mode={surface}
      title="Sign in to Xpod"
      onClose={surface === 'modal' ? onClose : undefined}
      closeLabel={surface === 'modal' && onClose ? 'Close sign in' : undefined}
    >
      <div className="space-y-4 p-4">
        <AccountCredentialsView
          mode="login"
          values={values}
          onChange={updateValues}
          onSubmit={handleSubmit}
          pending={pending}
          errors={formError ? { form: formError } : undefined}
          copy={credentialsCopy}
        />
      </div>
    </AuthSurface>
  );
}
