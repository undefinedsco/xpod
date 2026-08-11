import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  AccountLoginMethodListView,
  AuthSurface,
} from '@undefineds.co/shared-ui';
import { useAuth } from '../context/AuthContextValue';
import { useXpodAuth } from '../auth/useXpodAuth';

const xpodLoginMethod = {
  id: 'xpod-current-origin',
  label: 'Sign in to Xpod',
  description: 'Continue with this Xpod account',
} as const;

export function LoginSelectPage() {
  const { isLoggedIn } = useAuth();
  const { startLogin } = useXpodAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleStartLogin = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await startLogin();
    } catch {
      setError('Sign-in is temporarily unavailable. Please try again.');
    } finally {
      setPending(false);
    }
  };

  if (isLoggedIn) return <Navigate to="/.account/account/" replace />;

  return (
    <AuthSurface mode="page" title="Sign in">
      <div className="p-4">
        {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
        <AccountLoginMethodListView
          methods={[xpodLoginMethod]}
          onSelect={() => void handleStartLogin()}
          pending={pending}
          copy={{
            title: 'Sign in to Xpod',
            description: 'Use the current Xpod account to continue.',
            methodActionLabel: 'Continue',
          }}
        />
      </div>
    </AuthSurface>
  );
}
