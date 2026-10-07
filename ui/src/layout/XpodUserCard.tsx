import { accountOverviewHref } from '../utils/account-overview-href';
import { resolveAuthoritativeAccountId } from '../utils/safe-continuation';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Separator,
  StatusLine,
  cn,
} from '@undefineds.co/shared-ui';
import { CheckCircle2, ChevronRight, Copy, Database, ExternalLink, Loader2, LogIn, LogOut, RefreshCw, UserRound } from 'lucide-react';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import {
  clearRememberedXpodLogin,
  readPendingXpodAccountEmail,
  readRememberedXpodLogin,
} from '../auth/xpod-remembered-login';
import type { SanitizedAccountIdentity } from '../context/AuthContextValue';
import { XpodSolidRuntimeContext } from '../solid/XpodSolidRuntime';
import { logoutXpodProduct } from '../auth/xpod-product-logout';
import { XPOD_DEFAULT_RETURN_PATH } from '../routes/canonical-routes';
import { accountCardPosition } from './account-card-position';

export function XpodUserCard() {
  const account = useAuth();
  const runtime = useContext(XpodSolidRuntimeContext);
  const accountAuthenticated = account.isLoggedIn && account.accountState.status === 'authenticated';
  const webIdAuthenticated = runtime?.state.status === 'authenticated' && Boolean(runtime.webId ?? runtime.state.webId);
  const isAuthenticated = accountAuthenticated || webIdAuthenticated;
  const [open, setOpen] = useState(accountCardRequestedByUrl(isAuthenticated));
  const [busy, setBusy] = useState<'logout' | 'switch' | undefined>();
  const [copyFeedback, setCopyFeedback] = useState<'已复制' | '复制失败'>();
  const [cardStyle, setCardStyle] = useState<CSSProperties>();
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copyFeedbackTimerRef = useRef<number | undefined>(undefined);
  const cardId = useId();
  const identity = account.identity;
  const accountHref = accountOverviewHref(account.idpIndex);
  const issuer = !account.isInitializing && accountHref ? new URL(accountHref).origin : undefined;
  const pendingAccountEmail = issuer ? readPendingXpodAccountEmail(undefined, account.idpIndex) : undefined;
  const remembered = readRememberedXpodLogin();
  const accountId = resolveAuthoritativeAccountId(account.controls, identity);
  const rememberedAccount = issuer && remembered?.issuer === issuer && accountId && remembered.account.id === accountId
    ? remembered.account
    : undefined;
  const accountIdentity = accountAuthenticated
    ? accountCardIdentityFallback(identity, pendingAccountEmail, rememberedAccount)
    : undefined;
  const profile = useXpodProfileCardIdentity({
    accountIdentity,
    runtime: webIdAuthenticated ? runtime : undefined,
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
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setCardStyle(accountCardPosition(trigger.getBoundingClientRect(), window.innerWidth, window.innerHeight, rootFontSize));
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
    handleCardOpenChange(false);
    try {
      await logoutXpodProduct(account, runtime);
      if (account.isAnonymous?.() ?? true) handleCardOpenChange(false);
    } catch {
      // The product operation boundary retains the failure and retry.
    } finally {
      setBusy(undefined);
    }
  };

  const runSwitchAccount = async () => {
    setBusy('switch');
    handleCardOpenChange(false);
    try {
      await logoutXpodProduct(account, runtime, { onComplete: () => {
        clearRememberedXpodLogin();
        // The operation retains this destination if the card unmounts before
        // a failed Account cleanup is retried from the product boundary.
        // Switching accounts re-enters the product the way opening it does.
        const destination = new URL(XPOD_DEFAULT_RETURN_PATH, window.location.origin);
        destination.searchParams.set('xpod-login', 'switch');
        window.location.assign(destination);
      } });
      handleCardOpenChange(false);
    } catch {
      // The product operation boundary retains the failure and retry.
    } finally {
      setBusy(undefined);
    }
  };

  const copyXpodId = async () => {
    const value = profile.webId ?? webId;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback('已复制');
    } catch {
      setCopyFeedback('复制失败');
    }
    if (copyFeedbackTimerRef.current !== undefined) window.clearTimeout(copyFeedbackTimerRef.current);
    copyFeedbackTimerRef.current = window.setTimeout(() => setCopyFeedback(undefined), 1_800);
  };

  if (!canOpenAccountCard) return <a href={XPOD_DEFAULT_RETURN_PATH} aria-label="登录" title="登录" className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"><LogIn size={20} aria-hidden="true" /></a>;

  return (
    <div className="relative">
        <button
        ref={triggerRef}
        type="button"
        aria-label={isAuthenticated ? `打开 ${displayName} 的个人卡片` : '个人卡片'}
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
          className={`fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border/40 bg-card text-card-foreground shadow-xl shadow-black/10 ${cardStyle ? '' : 'invisible'}`}
        >
          <div className="min-h-0 overflow-y-auto">
            <div className="flex flex-wrap items-start gap-5 px-6 pb-5 pt-6">
              <Avatar data-testid="xpod-profile-avatar" className="h-20 w-20 shrink-0 rounded-2xl border border-border/50 bg-primary/10 shadow-sm">
                {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt={displayName} /> : null}
                <AvatarFallback className="rounded-2xl bg-primary/10 text-2xl font-bold text-primary">{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-[1_1_10rem] py-0.5">
                <h2 className="truncate text-xl font-bold text-foreground">{displayName}</h2>
                <div className="mt-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                  <span className="shrink-0 opacity-70">WebID</span>
                  <span className="truncate font-mono font-medium">{profile.webId ?? webId}</span>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground" aria-label="复制 WebID" onClick={() => void copyXpodId()}>
                    <Copy className="h-3 w-3" aria-hidden="true" />
                  </Button>
                  {copyFeedback ? <span role="status" className="shrink-0 text-xs text-primary">{copyFeedback}</span> : null}
                </div>
                <StatusLine
                  tone={podReady ? 'success' : 'neutral'}
                  dotSize="sm"
                  className={cn(
                    'mt-2.5 gap-1.5 rounded-full px-2 py-1 text-xs font-medium',
                    podReady ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {podReady ? 'Pod 已就绪' : 'WebID 已登录'}
                </StatusLine>
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
                <a href="/pod/models" aria-label="Pod">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Database className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-foreground">{podDisplayName(podLabel)}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{podHost(podUrl)} · {podReady ? '已就绪' : '尚未就绪'}</span>
                  </span>
                  {podReady ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-label="Pod 已就绪" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                </a>
              </Button>
            </div>

          </div>
          <Separator className="shrink-0" />
          <div className="shrink-0 p-2">
            {accountHref ? (
              <Button asChild variant="ghost" className="h-10 w-full justify-start px-3 font-normal">
                <a href={accountHref} target="_blank" rel="noopener noreferrer">
                  <UserRound className="mr-2 h-4 w-4" aria-hidden="true" />
                  管理账号
                  <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </Button>
            ) : null}
            <Button type="button" variant="ghost" className="h-10 w-full justify-start px-3 font-normal" onClick={() => void runSwitchAccount()} disabled={busy !== undefined}>
              {busy === 'switch' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />}
              切换 WebID
            </Button>
            <Button type="button" variant="ghost" className="h-10 w-full justify-start px-3 font-normal text-destructive hover:text-destructive" onClick={() => void runLogout()} disabled={busy !== undefined}>
              {busy === 'logout' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />}
              退出
            </Button>
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
  if (identity?.displayName || identity?.username) return identity;
  const email = pendingEmail || (rememberedAccount && 'email' in rememberedAccount && typeof rememberedAccount.email === 'string'
    ? rememberedAccount.email
    : undefined);
  if (!email && !rememberedAccount) return identity;
  const username = rememberedAccount?.username || usernameFromEmail(email);
  return {
    ...(rememberedAccount ?? {}),
    ...(identity ?? {}),
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
  return podName ? `${podName} Pod` : '我的 Pod';
}

function podHost(value?: string): string {
  if (!value) return '未连接 Pod';
  try {
    return new URL(value).host;
  } catch {
    return 'Pod';
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
