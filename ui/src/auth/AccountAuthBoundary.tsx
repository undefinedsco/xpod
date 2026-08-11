import type { AccountAuthState } from '@undefineds.co/shared-ui';
import { AuthSurface, Button, Card, CardContent, CardHeader, CardTitle } from '@undefineds.co/shared-ui';
import { Loader2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { XpodAccountCredentials } from './XpodAccountCredentials';
import { useXpodAuth } from './useXpodAuth';

export interface AccountAuthBoundaryProps {
  children?: ReactNode;
  state?: AccountAuthState;
  accountState?: AccountAuthState;
  retry?: () => void | Promise<void>;
}

export function AccountAuthBoundary({
  children,
  state: stateOverride,
  accountState: accountStateOverride,
  retry: retryOverride,
}: AccountAuthBoundaryProps) {
  const xpod = useXpodAuth();
  const state = stateOverride ?? accountStateOverride ?? xpod.account.accountState;
  const retry = retryOverride ?? xpod.account.retry;
  const [dismissed, setDismissed] = useState(false);

  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'submitting') {
    return (
      <AuthSurface mode="modal" title="Sign in to Xpod">
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Signing in…
        </div>
      </AuthSurface>
    );
  }

  if (dismissed) {
    return (
      <Card className="w-full border-border bg-card text-card-foreground">
        <CardHeader><CardTitle>{state.status === 'error' ? 'Account unavailable' : 'Sign in required'}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {state.status === 'error' ? state.message : 'Sign in to view Account-protected Status data.'}
          </p>
          {state.status === 'error' ? (
            <Button type="button" onClick={() => void retry()}>Retry</Button>
          ) : (
            <Button type="button" onClick={() => setDismissed(false)}>Sign in</Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (state.status === 'initializing') {
    return (
      <AuthSurface mode="modal" title="Sign in to Xpod" onClose={() => setDismissed(true)} closeLabel="Close sign in">
        <div role="status" aria-live="polite" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading account
        </div>
      </AuthSurface>
    );
  }

  if (state.status === 'error') {
    return (
      <AuthSurface mode="modal" title="Account unavailable" onClose={() => setDismissed(true)} closeLabel="Close sign in">
        <div className="space-y-4 p-6">
          <p role="alert" className="text-sm text-destructive">{state.message}</p>
          <Button type="button" onClick={() => void retry()}>Retry</Button>
        </div>
      </AuthSurface>
    );
  }

  return (
    <XpodAccountCredentials
      surface="modal"
      onClose={() => setDismissed(true)}
      onAuthenticated={() => setDismissed(false)}
    />
  );
}
