import type { AccountAuthState } from '@undefineds.co/shared-ui';
import { AuthSurface, Button, Card, CardContent, CardHeader, CardTitle } from '@undefineds.co/shared-ui';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
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

  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'initializing') {
    return <div role="status" aria-live="polite" className="p-6 text-sm text-muted-foreground">Loading account</div>;
  }
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
  if (state.status === 'error') {
    return (
      <Card className="w-full border-border bg-card text-card-foreground">
        <CardHeader><CardTitle>Account unavailable</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p role="alert" className="text-sm text-destructive">{state.message}</p>
          <Button type="button" onClick={() => void retry()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return <XpodAccountCredentials surface="modal" />;
}
