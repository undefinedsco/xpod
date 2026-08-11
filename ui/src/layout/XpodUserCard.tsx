import {
  Avatar,
  AvatarFallback,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Separator,
} from '@undefineds.co/shared-ui';
import { ArrowLeftRight, Check, CircleAlert, Loader2, LogOut, RefreshCw, Settings2, UserRound } from 'lucide-react';
import { XpodAccountCredentials } from '../auth/XpodAccountCredentials';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { XpodAuthContext } from '../auth/useXpodAuth';
import type { XpodLogoutState } from '../auth/xpod-logout';
import { XpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';

export interface XpodUserCardProps {
  product: 'dashboard' | 'settings';
  switchHref: '/dashboard/overview' | '/settings/models';
}

const emptyLogoutState = { status: 'idle' } as const;
type AccountSwitchPhase = 'idle' | 'logging-out' | 'ready';
type ActiveLogoutState = Extract<XpodLogoutState, { status: 'running' | 'error' }>;

export function XpodUserCard({ product, switchHref }: XpodUserCardProps) {
  const auth = useContext(XpodAuthContext);
  const runtime = useContext(XpodSolidRuntimeContext);
  const [open, setOpen] = useState(accountCardRequestedByUrl);
  const [busy, setBusy] = useState<'logout' | 'switch' | 'retry' | undefined>();
  const [accountSwitchPhase, setAccountSwitchPhase] = useState<AccountSwitchPhase>('idle');
  const [accountSwitchLogoutState, setAccountSwitchLogoutState] = useState<ActiveLogoutState>();
  const logoutState = auth?.logoutState ?? emptyLogoutState;
  const account = auth?.account;
  const isAuthenticated = account?.isLoggedIn === true && account.accountState.status === 'authenticated';
  const accountRestoring = account?.accountState.status === 'initializing' || account?.accountState.status === 'submitting';
  const accountUnavailable = account?.accountState.status === 'error';
  const identity = account?.identity;
  const displayName = identity?.displayName || identity?.username || identity?.id || 'Xpod account';
  const initials = initialsFor(displayName);
  const webId = runtime?.webId ?? (runtime?.state.status === 'authenticated' ? runtime.state.webId : undefined);
  const podUrl = runtime?.selectedStorage?.storageUrl ?? runtime?.podUrl;
  const selectedBinding = runtime?.selectedStorage;
  const currentPod = runtime?.currentPod;
  const podLabel = useMemo(() => podUrl ? podNameFromUrl(podUrl) : undefined, [podUrl]);
  const podReady = runtime?.state.status === 'authenticated'
    && Boolean(webId && podUrl && selectedBinding && currentPod)
    && selectedBinding?.webId === webId
    && sameUrl(selectedBinding?.storageUrl ?? '', podUrl ?? '')
    && currentPod?.webId === webId
    && sameUrl(currentPod?.podUrl ?? '', podUrl ?? '');
  const switchLabel = product === 'dashboard' ? 'Open Settings' : 'Open Dashboard';
  const effectiveLogoutState = accountSwitchPhase === 'logging-out'
    ? accountSwitchLogoutState ?? { status: 'running', account: 'pending', webId: 'pending' } as const
    : accountSwitchLogoutState ?? (logoutState.status === 'running' || logoutState.status === 'error' ? logoutState : undefined);
  const handleCardOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) clearAccountCardRequest();
  };

  const runLogout = async () => {
    if (!auth) return;
    setBusy('logout');
    try {
      const result = await auth.logout();
      if (result.status === 'complete') auth.logoutCoordinator.reset();
    } finally {
      setBusy(undefined);
    }
  };

  const runRetry = async () => {
    if (!auth) return;
    setBusy('retry');
    try {
      if (accountSwitchPhase === 'logging-out') {
        setAccountSwitchLogoutState((state) => state ? {
          status: 'running',
          account: state.account === 'complete' ? 'complete' : 'pending',
          webId: state.webId === 'complete' ? 'complete' : 'pending',
        } : { status: 'running', account: 'pending', webId: 'pending' });
      }
      const result = await auth.retryLogout();
      if (result.status === 'complete') {
        auth.logoutCoordinator.reset();
        if (accountSwitchPhase === 'logging-out') {
          setAccountSwitchLogoutState(undefined);
          setAccountSwitchPhase('ready');
        }
      } else if (accountSwitchPhase === 'logging-out' && isActiveLogoutState(result)) {
        setAccountSwitchLogoutState(result);
      }
    } finally {
      setBusy(undefined);
    }
  };

  const runSwitchAccount = async () => {
    if (!auth) return;
    setBusy('switch');
    setAccountSwitchPhase('logging-out');
    setAccountSwitchLogoutState({ status: 'running', account: 'pending', webId: 'pending' });
    try {
      const result = await auth.logout();
      if (result.status !== 'complete') {
        if (isActiveLogoutState(result)) setAccountSwitchLogoutState(result);
        return;
      }
      auth.logoutCoordinator.reset();
      setAccountSwitchLogoutState(undefined);
      setAccountSwitchPhase('ready');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleCardOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={isAuthenticated ? `Open account menu for ${displayName}` : 'Open account menu'}
          data-testid="xpod-user-card-trigger"
          data-pod-ready={podReady ? 'true' : 'false'}
          className="flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Avatar className="h-8 w-8 rounded-md border border-border bg-muted">
            <AvatarFallback className="rounded-md bg-muted text-xs text-muted-foreground">{initials}</AvatarFallback>
          </Avatar>
          <span className="sr-only">{isAuthenticated ? displayName : 'Not signed in'}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm rounded-md">
        <DialogHeader>
          <DialogTitle>{isAuthenticated ? displayName : 'Xpod account'}</DialogTitle>
          <DialogDescription>
            {isAuthenticated ? 'Account and Pod session' : 'Sign in to use your Xpod workspace'}
          </DialogDescription>
        </DialogHeader>

        {accountSwitchPhase === 'ready' ? (
          <XpodAccountCredentials
            surface="embedded"
            onAuthenticated={() => {
              setAccountSwitchPhase('idle');
              handleCardOpenChange(false);
            }}
          />
        ) : effectiveLogoutState ? (
          <LogoutProgress
            state={effectiveLogoutState}
            busy={busy}
            onRetry={() => void runRetry()}
          />
        ) : !isAuthenticated ? (
          accountUnavailable ? (
            <div className="space-y-4">
              <StatusLine
                icon={<UserRound className="h-4 w-4" aria-hidden="true" />}
                label="Status"
                value="Account unavailable"
              />
              <Button type="button" variant="outline" className="w-full" onClick={() => void account?.retry()} disabled={busy !== undefined}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                Try again
              </Button>
            </div>
          ) : accountRestoring ? (
            <div className="space-y-4">
              <StatusLine
                icon={<UserRound className="h-4 w-4" aria-hidden="true" />}
                label="Status"
                value="Restoring account"
              />
              <Button type="button" className="w-full" disabled>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Restoring account
              </Button>
            </div>
          ) : (
            <XpodAccountCredentials surface="embedded" onAuthenticated={() => handleCardOpenChange(false)} />
          )
        ) : (
          <div className="space-y-4">
            <div className="space-y-3 text-sm">
              <StatusLine icon={<UserRound className="h-4 w-4" aria-hidden="true" />} label="Account" value={identityLabel(identity)} />
              <StatusLine icon={<Check className="h-4 w-4" aria-hidden="true" />} label="WebID" value={webId ?? 'Not connected'} mono />
              <StatusLine icon={<Settings2 className="h-4 w-4" aria-hidden="true" />} label="Pod" value={podUrl ?? 'No Pod selected'} detail={podLabel} mono={Boolean(podUrl)} />
              <StatusLine icon={<Check className="h-4 w-4" aria-hidden="true" />} label="Status" value={runtime?.state.status === 'authenticated' ? 'Connected' : 'Account signed in'} />
            </div>
            <Separator />
            <div className="grid gap-2">
              <Button asChild variant="outline" className="w-full justify-start">
                <a href={switchHref} aria-label={switchLabel}>
                  <ArrowLeftRight className="mr-2 h-4 w-4" aria-hidden="true" />
                  {switchLabel}
                </a>
              </Button>
              <Button type="button" variant="ghost" className="w-full justify-start" onClick={() => void runSwitchAccount()} disabled={busy !== undefined}>
                {busy === 'switch' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                Use a different account
              </Button>
              <Button type="button" variant="ghost" className="w-full justify-start text-destructive hover:text-destructive" onClick={() => void runLogout()} disabled={busy !== undefined}>
                {busy === 'logout' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />}
                Sign out
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => handleCardOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LogoutProgress({
  state,
  busy,
  onRetry,
}: {
  state: Extract<XpodLogoutState, { status: 'running' | 'error' }>;
  busy?: string;
  onRetry: () => void;
}) {
  const isError = state.status === 'error';
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
        {isError ? <CircleAlert className="mt-0.5 h-4 w-4 text-destructive" aria-hidden="true" /> : <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
        <div>
          <p className="font-medium text-foreground">{isError ? 'Sign out incomplete' : 'Signing out'}</p>
          <p className="mt-1 text-muted-foreground">{isError ? 'One session still needs attention.' : 'Clearing Account and WebID sessions.'}</p>
        </div>
      </div>
      <div className="grid gap-2 text-sm">
        <StatusLine label="Account" value={domainLabel(state.account)} />
        <StatusLine label="WebID" value={domainLabel(state.webId)} />
      </div>
      {isError ? (
        <Button type="button" className="w-full" onClick={onRetry} disabled={busy !== undefined}>
          {busy === 'retry' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function StatusLine({
  icon,
  label,
  value,
  detail,
  mono = false,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  detail?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {icon ? <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span> : null}
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={mono ? 'break-all font-mono text-xs text-foreground' : 'truncate text-sm text-foreground'}>{value}</div>
        {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
      </div>
    </div>
  );
}

function identityLabel(identity?: { displayName?: string; username?: string; id?: string }): string {
  return identity?.displayName || identity?.username || identity?.id || 'Signed in';
}

function initialsFor(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase();
  return value.slice(0, 2).toUpperCase() || 'XP';
}

function podNameFromUrl(value: string): string | undefined {
  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);
    return segments.at(-1);
  } catch {
    return undefined;
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function domainLabel(value: 'pending' | 'complete' | 'error'): string {
  if (value === 'complete') return 'Complete';
  if (value === 'error') return 'Needs retry';
  return 'In progress';
}

function isActiveLogoutState(state: XpodLogoutState): state is ActiveLogoutState {
  return state.status === 'running' || state.status === 'error';
}

function accountCardRequestedByUrl(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('account') === 'open';
}

function clearAccountCardRequest(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('account') !== 'open') return;
  url.searchParams.delete('account');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
