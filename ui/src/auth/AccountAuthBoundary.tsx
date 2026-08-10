import type { AccountAuthState, AccountLoginMethod } from '../../../packages/shared-ui/src';
import { AccountLoginMethodListView, Button, Card, CardContent, CardHeader, CardTitle } from '../../../packages/shared-ui/src';
import type { ReactNode } from 'react';
import { useXpodAuth } from './useXpodAuth';

export interface AccountAuthBoundaryProps {
  children?: ReactNode;
  state?: AccountAuthState;
  accountState?: AccountAuthState;
  startLogin?: () => void | Promise<void>;
  onStartLogin?: () => void | Promise<void>;
  retry?: () => void | Promise<void>;
}

const loginMethod: AccountLoginMethod = {
  id: 'xpod-current-origin',
  label: 'Sign in to Xpod',
  description: 'Continue with this Xpod account',
};

export function AccountAuthBoundary({
  children,
  state: stateOverride,
  accountState: accountStateOverride,
  startLogin: startLoginOverride,
  onStartLogin: onStartLoginOverride,
  retry: retryOverride,
}: AccountAuthBoundaryProps) {
  const xpod = useXpodAuth();
  const state = stateOverride ?? accountStateOverride ?? xpod.account.accountState;
  const startLogin = startLoginOverride ?? onStartLoginOverride ?? (() => xpod.startLogin());
  const retry = retryOverride ?? xpod.account.retry;

  if (state.status === 'authenticated') return <>{children}</>;
  if (state.status === 'initializing') {
    return <div role="status" aria-live="polite" className="p-6 text-sm text-muted-foreground">Loading account</div>;
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

  return (
    <AccountLoginMethodListView
      methods={[loginMethod]}
      pending={state.status === 'submitting'}
      onSelect={() => void startLogin()}
      copy={{
        title: 'Sign in',
        description: 'Use the current Xpod account to continue.',
        methodActionLabel: 'Continue',
      }}
    />
  );
}
