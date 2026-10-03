import { getXpodAuthSurfaceHost } from '../auth/xpod-auth-surface-host';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input } from '@undefineds.co/shared-ui';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';
import { WebAccountFailureView, WebAccountRestoringView } from '../auth/WebAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { resolveProvisionCodeForCurrentScope } from '../utils/pod';
import {
  resolveFirstPodCurrentBindings,
  type FirstPodCurrentBindings,
} from '../utils/first-pod-current-bindings';
import {
  FIRST_POD_BINDING_MISSING,
  FIRST_POD_INVENTORY_UNAVAILABLE,
  createFirstPodAndWaitForBinding,
  deriveFirstPodNameCandidate,
} from '../utils/consent-first-pod';
import { getRegistrationUsernameError, normalizeRegistrationUsername } from '../utils/registration';
import {
  clearConsentContinuation,
  confirmConsentInteractionAtAuthority,
  consumeExactConsentContinuation,
  currentInteractionScope,
  isSameConsentContinuation,
  readConsentContinuation,
  resolveAuthoritativeAccountId,
  type ConsentContinuation,
} from '../utils/safe-continuation';
import { scopeAccountUrl } from '../utils/account-interaction-url';
import { xpodFirstPodErrors, xpodRegistrationCopy } from '../auth/xpod-account-copy';
import { fetchOidcCancelRedirectLocation, resolveOidcCancelUrl } from './ConsentPage.utils';

/**
 * Consent's lightweight Pod quick-create
 * (`/.account/interaction/{interaction}/create-pod/`).
 *
 * This is deliberately not the daily management surface: it carries only the one
 * field the pending authorization needs, an explicit submit, and the exits back
 * to the authorization. It reuses the same guarded creation transaction and the
 * shared `Input` primitive as the settings Pod panel, so there is exactly one
 * prepare+POST path.
 *
 * Every step re-reads the authoritative Account id, the page's own interaction
 * scope and the stored task, and the one-time continuation is consumed only when
 * it is still the *very same* window. An Account-capability closure is captured
 * once when a submit starts and reused for the whole prepare/POST/recovery chain:
 * re-binding after an await would silently accept a switched Account as current.
 *
 * Readiness is scoped to the *current* provision target: only a durable binding
 * on that exact root (or one the target's own SP reports through the Account's
 * WebIDs) may resume the authorization. A binding on another root never does,
 * and a failed read fails closed. A plain GET or refresh never creates anything;
 * a task that expired, was cancelled, or belongs to a switched Account is
 * dropped instead of resumed, and the bare legacy deep link with no interaction
 * scope only navigates to Account management.
 */
type FirstPodPhase =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'creating' }
  | { status: 'invalid' }
  | { status: 'error'; message: string };

/** Errors the creation transaction already localises; anything else is replaced. */
const SAFE_CREATE_MESSAGES = new Set([
  FIRST_POD_BINDING_MISSING,
  FIRST_POD_INVENTORY_UNAVAILABLE,
  xpodRegistrationCopy.podNameTaken,
  xpodFirstPodErrors.storageCreateFailed,
]);

export function FirstPodPage() {
  const { bindAccountCapability, controls, idpIndex, identity } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<FirstPodPhase>({ status: 'checking' });
  const [podName, setPodName] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [cancelling, setCancelling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const submittingRef = useRef(false);

  // The Account id must come from the provider's own account-scoped controls,
  // never from a username/WebID/service address. Without it there is no binding
  // to check, so the page stays on a retryable error and creates nothing.
  const accountId = resolveAuthoritativeAccountId(controls, identity);
  const interaction = currentInteractionScope();

  /** Re-read the authoritative Account id + this page's interaction scope. */
  const currentTask = useCallback((): ConsentContinuation | null => {
    const freshAccountId = resolveAuthoritativeAccountId(controls, identity);
    const freshInteraction = currentInteractionScope();
    if (!freshAccountId || !freshInteraction) return null;
    return readConsentContinuation({ accountId: freshAccountId, interaction: freshInteraction });
  }, [controls, identity]);

  useEffect(() => {
    let cancelled = false;
    const assertAccount = bindAccountCapability?.();

    (async () => {
      setPhase({ status: 'checking' });
      // A bare legacy deep link carries no interaction scope, so there is no
      // task to resume. Hand the user to Account management without reading,
      // looking up or creating anything.
      if (!interaction) {
        navigate(scopeAccountUrl('/.account/account/'), { replace: true });
        return;
      }
      if (!accountId) {
        setPhase({ status: 'error', message: xpodFirstPodErrors.accountIdentityMissing });
        return;
      }
      // The task is only valid for the Account that queued it, for this same
      // pending interaction and for its TTL; expired/cancelled/switched context
      // is rejected here, never resumed.
      const continuation = readConsentContinuation({ accountId, interaction });
      if (cancelled) return;
      if (!continuation) {
        setPhase({ status: 'invalid' });
        return;
      }

      // Only storage for the exact *current* provision target proves this
      // deployment is ready: a durable binding on another root never resumes
      // the authorization, and a failed read fails closed instead of becoming
      // "no storage" (which would allow a duplicate create).
      let readiness: FirstPodCurrentBindings | null = null;
      try {
        readiness = await resolveFirstPodCurrentBindings({ controls, idpIndex });
      } catch {
        readiness = null;
      }
      if (cancelled) return;
      if (!readiness || readiness.status === 'unreadable') {
        setPhase({ status: 'error', message: xpodFirstPodErrors.checkFailed });
        return;
      }
      if (readiness.status === 'ready') {
        // Only navigate when the captured Account capability is still current
        // and the one-time task is still the exact one we loaded.
        try {
          assertAccount?.();
        } catch {
          setPhase({ status: 'invalid' });
          return;
        }
        const consumed = consumeExactConsentContinuation(continuation, { assertCurrent: assertAccount });
        if (!consumed) {
          setPhase({ status: 'invalid' });
          return;
        }
        navigate(consumed.returnTo, { replace: true });
        return;
      }

      setPodName((current) => current || deriveFirstPodNameCandidate([
        controls?.account?.username, identity?.username, identity?.webId,
      ]));
      setPhase({ status: 'ready' });
    })();

    return () => { cancelled = true; };
  }, [accountId, attempt, bindAccountCapability, controls, identity, idpIndex, interaction, navigate]);

  /** Non-destructive exit: keep the one-time task and go back to its consent. */
  const handleReturnToConsent = useCallback(() => {
    const fresh = currentTask();
    const fallback = interaction ? `${interaction}/oidc/consent/` : scopeAccountUrl('/.account/oidc/consent/');
    window.location.assign(fresh?.returnTo ?? fallback);
  }, [currentTask, interaction]);

  /** Destructive exit: cancel the authorization at the server, then clear the task. */
  const handleCancelAuthorization = useCallback(async () => {
    if (cancelling) return;
    const assertAccount = bindAccountCapability?.();
    setCancelling(true);
    setSubmitError(undefined);
    try {
      const redirect = await fetchOidcCancelRedirectLocation({
        cancelUrl: scopeAccountUrl(resolveOidcCancelUrl(controls, idpIndex)),
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      // A cancel that returns after the Account switched must not clear the new
      // session's task or navigate this tab to the old client.
      assertAccount?.();
      clearConsentContinuation();
      window.location.assign(scopeAccountUrl(redirect));
    } catch (err: unknown) {
      // Stay on the page with a retryable message: a failed cancel must not
      // pretend the authorization was cancelled. Server messages can be raw
      // English, so only the safe localised copy is shown; the diagnostic stays
      // available to tests and logs.
      void err;
      setSubmitError(xpodFirstPodErrors.cancelFailed);
      setCancelling(false);
    }
  }, [bindAccountCapability, cancelling, controls, idpIndex]);

  const openOwnDeployment = useCallback(() => {
    // Keep the exact one-time Consent task while opening deployment management.
    // The browser offers the desktop entry; only the native host owns management.
    // Navigation never prepares or creates a Pod.
    window.location.assign(getXpodAuthSurfaceHost() === 'window'
      ? scopeAccountUrl('/.account/manage-pod/')
      : '/settings/pod');
  }, []);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    // A ref, not state: a double click must not start a second create before
    // React re-renders the disabled button.
    if (submittingRef.current) return;
    // Never trust the task rendered at load time: read it fresh before starting.
    const task = currentTask();
    if (!task) {
      setPhase({ status: 'invalid' });
      return;
    }
    // Capture ONE Account-capability closure for the whole run. Re-binding after
    // an await would hand back a closure for whatever session is current then,
    // which is exactly how a switched Account slips through.
    const assertAccount = bindAccountCapability?.();

    const username = normalizeRegistrationUsername(podName);
    const invalid = getRegistrationUsernameError(username);
    if (invalid) {
      setFieldError(invalid);
      return;
    }
    const createPodUrl = controls?.account?.pod;
    if (!createPodUrl) {
      setSubmitError(xpodFirstPodErrors.createEndpointMissing);
      return;
    }

    /**
     * The single guard used across the whole prepare/POST/binding/recovery/consume
     * chain: the captured Account capability must still be current, the
     * authoritative Account/interaction must still be the ones this task belongs
     * to, and the stored task must be the very same, still-valid window. This is
     * also handed to `createFirstPodAndWaitForBinding`, so the transaction itself
     * aborts when any of that changes between its own awaits.
     */
    const assertFresh = () => {
      assertAccount?.();
      const freshAccountId = resolveAuthoritativeAccountId(controls, identity);
      const freshInteraction = currentInteractionScope();
      if (!freshAccountId || !freshInteraction
        || freshAccountId !== task.accountId || freshInteraction !== task.interaction) {
        throw new Error(xpodFirstPodErrors.accountIdentityMissing);
      }
      const current = readConsentContinuation({ accountId: freshAccountId, interaction: freshInteraction });
      if (!current || !isSameConsentContinuation(current, task)) {
        throw new Error(xpodFirstPodErrors.accountIdentityMissing);
      }
    };

    setFieldError(undefined);
    setSubmitError(undefined);
    submittingRef.current = true;
    setPhase({ status: 'creating' });
    try {
      assertFresh();
      // The stored task is not proof the authorization is still live: confirm the
      // exact interaction with the authority before preparing or posting anything.
      // A dead/redirected/foreign interaction must not create a Pod only to return
      // to an authorization that no longer exists.
      const authorizationLive = await confirmConsentInteractionAtAuthority(task, {
        headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
        assertCurrent: assertFresh,
      });
      assertFresh();
      if (!authorizationLive) {
        submittingRef.current = false;
        setSubmitError(xpodFirstPodErrors.authorizationUnavailable);
        setPhase({ status: 'ready' });
        return;
      }
      await createFirstPodAndWaitForBinding({
        assertCurrentAccount: assertFresh,
        createPodUrl,
        headers: storedAccountTokenHeaders(),
        provisionCode: await resolveProvisionCodeForCurrentScope(),
        trustedAccountIndex: idpIndex,
        username,
      });
      assertFresh();
      // Re-read the authority so the return to consent sees the new binding. Only
      // the exact current-target binding proves readiness; a different root or an
      // unreadable answer must not consume the task.
      const created = await resolveFirstPodCurrentBindings({ controls, idpIndex });
      assertFresh();
      if (created.status !== 'ready') {
        submittingRef.current = false;
        setSubmitError(created.status === 'unreadable'
          ? xpodFirstPodErrors.checkFailed
          : FIRST_POD_BINDING_MISSING);
        setPhase({ status: 'ready' });
        return;
      }
      const consumed = consumeExactConsentContinuation(task, { assertCurrent: assertAccount });
      if (!consumed) {
        setPhase({ status: 'invalid' });
        submittingRef.current = false;
        return;
      }
      window.location.assign(consumed.returnTo);
    } catch (err: unknown) {
      submittingRef.current = false;
      if (err instanceof Error && err.message === xpodFirstPodErrors.accountIdentityMissing) {
        // The Account/interaction/task changed mid-flight: never navigate the old
        // client, and never continue the old Account's transaction.
        setPhase({ status: 'invalid' });
        return;
      }
      // An unknown transaction result must not create a duplicate. Re-read the
      // current target, but a failed read must NOT be treated as "no existing
      // Pod": only an exact current-target binding proves the task may resume.
      let existing: FirstPodCurrentBindings | null = null;
      try {
        existing = await resolveFirstPodCurrentBindings({ controls, idpIndex });
      } catch {
        existing = null;
      }
      try {
        assertFresh();
      } catch {
        setPhase({ status: 'invalid' });
        return;
      }
      if (existing?.status === 'ready') {
        const consumed = consumeExactConsentContinuation(task, { assertCurrent: assertAccount });
        if (consumed) {
          window.location.assign(consumed.returnTo);
          return;
        }
      }
      const message = !existing || existing.status === 'unreadable'
        ? FIRST_POD_INVENTORY_UNAVAILABLE
        : err instanceof Error && SAFE_CREATE_MESSAGES.has(err.message)
          ? err.message
          : xpodFirstPodErrors.storageCreateFailed;
      setSubmitError(message);
      setPhase({ status: 'ready' });
    }
  }, [
    bindAccountCapability,
    controls,
    currentTask,
    idpIndex,
    identity,
    podName,
  ]);

  const busy = phase.status === 'creating' || cancelling;

  return (
    <XpodAccountPageSurface title="创建 Pod" presentation="standard">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {phase.status === 'checking' ? (
          <WebAccountRestoringView label="正在准备创建…" />
        ) : phase.status === 'invalid' ? (
          <WebAccountFailureView
            title="创建任务已失效"
            description="这个创建任务已过期、被取消，或账号已经切换。请回到原来的授权页面重新开始。"
            primaryLabel="回到授权"
            onPrimary={handleReturnToConsent}
            secondaryLabel="返回账号"
            onSecondary={() => window.location.assign(scopeAccountUrl('/.account/account/'))}
          />
        ) : phase.status === 'error' ? (
          <WebAccountFailureView
            title="暂时无法准备 Pod"
            description={phase.message}
            primaryLabel="重试"
            onPrimary={() => setAttempt((value) => value + 1)}
            secondaryLabel="回到授权"
            onSecondary={handleReturnToConsent}
          />
        ) : (
          <form data-testid="first-pod-quick-create" onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4">
            <p className="m-0 text-sm leading-[22px] text-muted-foreground">
              有应用正在等待你完成授权。为当前账号创建 Pod 后，会回到原来的授权页面继续。
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-foreground">Pod 名称</span>
              <Input
                name="podName"
                value={podName}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby="first-pod-name-hint"
                onChange={(event) => { setPodName(event.target.value); setFieldError(undefined); }}
                onBlur={() => setFieldError(getRegistrationUsernameError(podName))}
              />
              <span id="first-pod-name-hint" className="text-xs text-muted-foreground">
                {fieldError ?? '小写字母、数字和连字符；Pod 属于当前账号。'}
              </span>
            </label>
            {fieldError ? <p role="alert" className="text-[13px] text-destructive">{fieldError}</p> : null}
            {submitError ? <p role="alert" className="text-[13px] text-destructive">{submitError}</p> : null}
            <div className="flex flex-col gap-2">
              <Button type="submit" disabled={busy}>
                {phase.status === 'creating' ? '正在创建…' : '创建 Pod 并继续授权'}
              </Button>
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={handleReturnToConsent}>
                  返回授权
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => void handleCancelAuthorization()}>
                  {cancelling ? '正在取消…' : '取消授权'}
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={openOwnDeployment}>
                  使用自己的部署
                </Button>
              </div>
              <p className="m-0 text-center text-xs text-muted-foreground">
                想把自己的电脑或服务器作为 Pod 存储位置？选择“使用自己的部署”打开完整的部署管理，配置完成后可以回到这里继续授权。
              </p>
            </div>
          </form>
        )}
      </div>
    </XpodAccountPageSurface>
  );
}
