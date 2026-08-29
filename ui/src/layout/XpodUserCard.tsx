import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Separator,
} from '@undefineds.co/shared-ui';
import { CheckCircle2, ChevronRight, Copy, Database, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import {
  clearRememberedXpodLogin,
  readPendingXpodAccountEmail,
  readRememberedXpodLogin,
} from '../auth/xpod-remembered-login';
import { XpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';
import type { SanitizedAccountIdentity } from '../context/AuthContextValue';
import { accountCardPosition } from './account-card-position';
import { accountLoginUrl } from '../auth/AccountAuthBoundary';

export function XpodUserCard() {
  const account = useAuth();
  const runtime = useContext(XpodSolidRuntimeContext);
  const isAuthenticated = account.isLoggedIn && account.accountState.status === 'authenticated';
  const [open, setOpen] = useState(accountCardRequestedByUrl(isAuthenticated));
  const [busy, setBusy] = useState<'logout' | 'switch' | undefined>();
  const [copyFeedback, setCopyFeedback] = useState<'Copied' | 'Copy failed'>();
  const [cardStyle, setCardStyle] = useState<CSSProperties>();
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined);
  const cardId = useId();
  const identity = account.identity;
  const pendingAccountEmail = readPendingXpodAccountEmail();
  const rememberedAccount = readRememberedXpodLogin()?.account;
  const accountIdentity = accountCardIdentityFallback(identity, pendingAccountEmail, rememberedAccount);
  const profile = useXpodProfileCardIdentity({
    accountIdentity: isAuthenticated ? accountIdentity : undefined,
    runtime: isAuthenticated ? runtime : undefined,
  });
  const displayName = profile.displayName;
  const initials = initialsFor(profile.displayName);
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
  const canOpenAccountCard = isAuthenticated;
  const cardOpen = open && canOpenAccountCard;
  const handleCardOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setCardStyle(undefined);
      clearAccountCardRequest();
    }
  }, []);

  useLayoutEffect(() => {
    if (!cardOpen) return;
    const positionCard = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      setCardStyle(accountCardPosition(trigger.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    };
    positionCard();
    window.addEventListener('resize', positionCard);
    window.addEventListener('scroll', positionCard, true);
    window.visualViewport?.addEventListener('resize', positionCard);
    return () => {
      window.removeEventListener('resize', positionCard);
      window.removeEventListener('scroll', positionCard, true);
      window.visualViewport?.removeEventListener('resize', positionCard);
    };
  }, [cardOpen]);

  useEffect(() => {
    if (!canOpenAccountCard) {
      clearAccountCardRequest();
      return;
    }
    if (!cardOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      handleCardOpenChange(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      handleCardOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [canOpenAccountCard, cardOpen, handleCardOpenChange]);

  useEffect(() => {
    if (!cardOpen || !cardStyle) return;
    cardRef.current?.focus({ preventScroll: true });
  }, [cardOpen, cardStyle]);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  const runLogout = async () => {
    setBusy('logout');
    try {
      await account.logout();
      if (account.isAnonymous?.() ?? true) handleCardOpenChange(false);
    } finally {
      setBusy(undefined);
    }
  };

  const runSwitchAccount = async () => {
    setBusy('switch');
    try {
      await account.logout();
      if (!(account.isAnonymous?.() ?? true)) return;
      clearRememberedXpodLogin();
      handleCardOpenChange(false);
      window.location.assign(accountLoginUrl(account.idpIndex));
    } finally {
      setBusy(undefined);
    }
  };

  const copyXpodId = async () => {
    const value = profile.webId ?? accountHandle(profile.username, accountIdentity?.id, webId);
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback('Copied');
    } catch {
      setCopyFeedback('Copy failed');
    }
    if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = window.setTimeout(() => setCopyFeedback(undefined), 1_800);
  };

  // The product auth gate owns every anonymous, restoring and failure state.
  // This rail control only exists inside the authenticated application shell.
  if (!canOpenAccountCard) return null;

  return (
    <div className="relative">
        <button
        ref={triggerRef}
        type="button"
        aria-label={isAuthenticated ? `Open account menu for ${displayName}` : 'Open account menu'}
        aria-expanded={cardOpen}
        aria-controls={cardOpen ? cardId : undefined}
        data-testid="xpod-user-card-trigger"
        data-pod-ready={podReady ? 'true' : 'false'}
        className="flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent focus:outline-none focus:ring-0 focus-visible:bg-accent"
        onClick={() => handleCardOpenChange(!cardOpen)}
      >
        <Avatar className="h-8 w-8 rounded-md border border-border bg-muted">
          {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt={displayName} /> : null}
          <AvatarFallback className="rounded-md bg-muted text-xs text-muted-foreground">{initials}</AvatarFallback>
        </Avatar>
        <span className="sr-only">{isAuthenticated ? displayName : 'Not signed in'}</span>
      </button>
      {cardOpen && typeof document !== 'undefined' ? createPortal((
        <section
          ref={cardRef}
          id={cardId}
          role="region"
          tabIndex={-1}
          aria-label={isAuthenticated ? displayName : 'Xpod account'}
          data-avatar-card="true"
          data-selected-pod-url={podUrl}
          style={cardStyle}
          className={`fixed z-50 overflow-y-auto rounded-xl border border-border/40 bg-card text-card-foreground shadow-xl shadow-black/10 ${cardStyle ? '' : 'invisible'}`}
        >
          <div>
            <div className="flex items-start gap-5 px-6 pb-5 pt-6">
              <Avatar data-testid="xpod-profile-avatar" className="h-20 w-20 shrink-0 rounded-2xl border border-border/50 bg-primary/10 shadow-sm">
                {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt={displayName} /> : null}
                <AvatarFallback className="rounded-2xl bg-primary/10 text-2xl font-bold text-primary">{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 py-0.5">
                <h2 className="truncate text-xl font-bold text-foreground">{displayName}</h2>
                <div className="mt-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                  <span className="shrink-0 opacity-70">Xpod ID</span>
                  <span className="truncate font-mono font-medium">{accountHandle(profile.username, accountIdentity?.id, webId)}</span>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground" aria-label="Copy Xpod ID" onClick={() => void copyXpodId()}>
                    <Copy className="h-3 w-3" aria-hidden="true" />
                  </Button>
                  {copyFeedback ? <span role="status" className="shrink-0 text-xs text-primary">{copyFeedback}</span> : null}
                </div>
                <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <span className={`h-1.5 w-1.5 rounded-full ${podReady ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} aria-hidden="true" />
                  <span>{podReady ? 'Pod connected' : 'Account connected'}</span>
                </div>
              </div>
            </div>

            {profile.note || profile.region ? (
              <div className="px-6 pb-5 text-sm text-muted-foreground">
                {profile.note ? <p className="line-clamp-2 text-foreground/85">{profile.note}</p> : null}
                {profile.region ? <p className="mt-1 text-xs">{profile.region}</p> : null}
              </div>
            ) : null}

            <div className="border-t border-border/40 p-2">
              <Button asChild variant="ghost" className="h-auto min-h-14 w-full justify-start gap-3 px-3 py-2.5 font-normal">
                <a href="/settings/pod" aria-label="Pod settings">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Database className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-foreground">{podDisplayName(podLabel)}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">Personal Pod · {podHost(podUrl)}</span>
                  </span>
                  {podReady ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-label="Pod ready" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </a>
              </Button>
            </div>

            <Separator />
            <div className="p-2">
              <Button type="button" variant="ghost" className="h-10 w-full justify-start px-3 font-normal" onClick={() => void runSwitchAccount()} disabled={busy !== undefined}>
                {busy === 'switch' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
                Switch account
              </Button>
              <Button type="button" variant="ghost" className="h-10 w-full justify-start px-3 font-normal text-destructive hover:text-destructive" onClick={() => void runLogout()} disabled={busy !== undefined}>
                {busy === 'logout' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />}
                Sign out
              </Button>
            </div>
          </div>
        </section>
      ), document.body) : null}
    </div>
  );
}

function accountCardIdentityFallback(
  identity: SanitizedAccountIdentity | undefined,
  pendingEmail: string | undefined,
  rememberedAccount: (SanitizedAccountIdentity & { email?: string }) | undefined,
): SanitizedAccountIdentity | undefined {
  if (identity?.displayName || identity?.username || identity?.id || identity?.webId) return identity;
  const email = pendingEmail || (rememberedAccount && 'email' in rememberedAccount && typeof rememberedAccount.email === 'string'
    ? rememberedAccount.email
    : undefined);
  if (!email && !rememberedAccount) return identity;
  const username = rememberedAccount?.username || usernameFromEmail(email);
  return {
    ...(rememberedAccount ?? {}),
    ...(username ? { username } : {}),
    ...(rememberedAccount?.displayName
      ? { displayName: rememberedAccount.displayName }
      : { displayName: username || email || 'Xpod account' }),
  };
}

function usernameFromEmail(value?: string): string | undefined {
  if (!value) return undefined;
  return value.split('@')[0]?.trim() || undefined;
}

function accountHandle(username?: string, accountId?: string, webId?: string): string {
  const value = username || accountId || usernameFromWebId(webId);
  if (!value) return 'Xpod member';
  return value.startsWith('@') ? value : `@${value}`;
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

function podDisplayName(podName?: string): string {
  return podName ? `${podName} Pod` : 'My Pod';
}

function podHost(value?: string): string {
  if (!value) return 'No Pod connected';
  try {
    return new URL(value).host;
  } catch {
    return 'Pod storage';
  }
}

function usernameFromWebId(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);
    return segments.at(0);
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

function accountCardRequestedByUrl(authenticated: boolean): boolean {
  if (!authenticated) return false;
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
