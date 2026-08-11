import { Avatar, AvatarFallback } from '@undefineds.co/shared-ui';
import { Copy, ExternalLink, LogIn, LogOut, UserRound } from 'lucide-react';
import { useContext, useEffect } from 'react';
import { XpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';
import { AuthContext } from '../context/AuthContextValue';
import { clearAccountSessionToken, storedAccountTokenHeaders } from '../utils/account-session';

export function XpodUserCard() {
  const runtime = useContext(XpodSolidRuntimeContext);
  const account = useContext(AuthContext);
  const state = runtime?.state;
  const webId = runtime?.webId ?? state?.webId;
  const podUrl = runtime?.podUrl ?? state?.podUrl;
  const signedIn = state?.status === 'authenticated';
  const switching = state?.status === 'loading';
  const unavailable = state?.status === 'error';
  const accountSignedIn = account?.isLoggedIn ?? false;
  const identity = webId ? identityLabel(webId) : switching ? 'Switching Solid identity…' : unavailable ? 'Identity unavailable' : accountSignedIn ? 'Xpod account' : 'Not signed in';

  useEffect(() => {
    globalThis.xpodDesktop?.setIdentity(signedIn ? { label: identity, webId, podUrl } : null);
  }, [identity, podUrl, signedIn, webId]);

  const copyWebId = () => {
    if (webId) void globalThis.navigator?.clipboard?.writeText(webId);
  };

  const signIn = () => {
    if (runtime?.issuer) void runtime.login(runtime.issuer);
  };

  const signOutAccount = async () => {
    const logoutUrl = account?.controls?.account?.logout;
    if (!logoutUrl) return;
    const response = await fetch(logoutUrl, {
      method: 'POST',
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });
    if (!response.ok) return;
    clearAccountSessionToken();
    await account.refetchControls();
  };

  return (
    <details className="group relative">
      <summary
        aria-label="Current user"
        title={identity}
        className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden"
      >
        <Avatar className="h-8 w-8 rounded-full border border-border bg-background">
          <AvatarFallback className="bg-background text-xs font-semibold text-foreground">
            {webId ? identity.slice(0, 2).toUpperCase() : <UserRound className="h-4 w-4" aria-hidden="true" />}
          </AvatarFallback>
        </Avatar>
      </summary>

      <div className="absolute bottom-12 left-0 z-50 w-72 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl sm:bottom-auto sm:left-12 sm:top-0">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 rounded-full border border-border">
            <AvatarFallback className="text-sm font-semibold">
              {webId ? identity.slice(0, 2).toUpperCase() : <UserRound className="h-5 w-5" aria-hidden="true" />}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{identity}</div>
            <div className="truncate text-xs text-muted-foreground">{webId ?? 'No active Solid identity'}</div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Xpod account</div>
          <div className="mt-1 text-sm font-medium">{accountSignedIn ? 'Signed in' : account?.isInitializing ? 'Restoring account…' : 'Not signed in'}</div>
          <a className="mt-2 inline-flex text-xs font-medium text-primary hover:underline" href={accountSignedIn ? '/.account/' : '/.account/login/password/'}>
            {accountSignedIn ? 'Account settings' : 'Sign in to Xpod'}
          </a>
          {accountSignedIn ? (
            <button type="button" className="mt-2 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => void signOutAccount()}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign out account
            </button>
          ) : null}
        </div>

        <div className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Solid identity</div>

        {switching ? (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3" aria-live="polite">
            <div className="text-sm font-medium">Switching Solid identity…</div>
            <p className="mt-1 text-xs text-muted-foreground">Restoring the Solid session and discovering its Pod.</p>
          </div>
        ) : unavailable ? (
          <div className="mt-4" role="alert">
            <div className="text-sm font-medium">Identity unavailable</div>
            <p className="mt-1 break-words text-xs text-muted-foreground">{state.error.message}</p>
            <button type="button" className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent" onClick={signIn} disabled={!runtime?.issuer}>
              <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : signedIn ? (
          <>
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pod</div>
              <div className="mt-1 break-all text-sm">{podUrl ?? 'Pod discovery pending'}</div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className={`h-2 w-2 rounded-full ${podUrl ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
                {podUrl ? 'Connected' : 'Discovering'}
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              {podUrl ? (
                <a className="inline-flex h-8 items-center rounded-md border border-input px-2.5 text-xs font-medium hover:bg-accent" href={podUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Open Pod
                </a>
              ) : null}
              <button type="button" className="inline-flex h-8 items-center rounded-md border border-input px-2.5 text-xs font-medium hover:bg-accent" onClick={copyWebId}>
                <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Copy WebID
              </button>
            </div>
            <div className="my-3 border-t border-border" />
            <button type="button" className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={signIn} disabled={!runtime?.issuer}>Switch WebID</button>
            <button type="button" className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => void runtime?.logout()}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              Disconnect WebID
            </button>
          </>
        ) : (
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">Connect a Solid identity to manage this Xpod.</p>
            <button type="button" className="mt-3 inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground" onClick={signIn} disabled={!runtime?.issuer}>
              <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign in
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function identityLabel(webId: string): string {
  try {
    const url = new URL(webId);
    const segments = url.pathname.split('/').filter(Boolean);
    const profileIndex = segments.lastIndexOf('profile');
    return (profileIndex > 0 ? segments[profileIndex - 1] : segments[0]) || url.hostname;
  } catch {
    return webId;
  }
}
