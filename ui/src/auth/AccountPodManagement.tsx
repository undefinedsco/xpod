import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@undefineds.co/shared-ui';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { useAuth } from '../context/AuthContextValue';
import { fetchAccountStorageBindings } from './account-storage-bindings';
import { createFirstPodAndWaitForBinding, deriveFirstPodNameCandidate, type FirstPodCreationStage } from '../utils/consent-first-pod';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { resolveProvisionCodeForCurrentScope } from '../utils/pod';
import {
  clearConsentContinuation, confirmConsentInteractionAtAuthority, consumeConfirmedConsentContinuation,
  consumeManagementContinuation, isAccountReturnTo, readConfirmedConsentContinuation,
  readManagementContinuation, resolveAuthoritativeAccountId, type ConsentContinuation, type ManagementContinuation,
} from '../utils/safe-continuation';
import { fetchOidcCancelRedirectLocation, resolveOidcCancelUrl } from '../pages/ConsentPage.utils';

function interactionScopedCancelUrl(
  interaction: string,
  controls: Parameters<typeof resolveOidcCancelUrl>[0],
  idpIndex: string,
): string {
  const resolved = resolveOidcCancelUrl(controls, idpIndex);
  let suffix = '/oidc/cancel/';
  try {
    const url = new URL(resolved, window.location.origin);
    if (url.origin === window.location.origin) {
      const stripped = url.pathname.replace(/^\/\.account(?:\/interaction\/[^/]+)?/u, '');
      if (stripped.startsWith('/')) suffix = stripped.endsWith('/') ? stripped : `${stripped}/`;
    }
  } catch { /* keep the canonical suffix */ }
  return `${interaction}${suffix}`;
}


const CREATE_STAGE_COPY: Record<FirstPodCreationStage, string> = {
  submitting: '正在提交创建请求…',
  submitted: '请求已提交，正在读取结果…',
  'binding-confirmed': '身份绑定已确认…',
};

/** 阶段文案：没有阶段的旧调用回退为"正在创建…"。 */
function createStageLabel(stage: FirstPodCreationStage | null): string {
  return stage ? CREATE_STAGE_COPY[stage] : '正在创建…';
}

export function AccountPodManagement() {
  const account = useAuth();
  const [bindings, setBindings] = useState<StorageBinding[] | null>(null);
  const [listError, setListError] = useState('');
  const [podName, setPodName] = useState('');
  const [creating, setCreating] = useState(false);
  // §5.2 第 6 步：创建过程如实分阶段显示，不合并成一个模糊的"进行中"
  const [createStage, setCreateStage] = useState<FirstPodCreationStage | null>(null);
  const [createError, setCreateError] = useState('');
  const [createNotice, setCreateNotice] = useState('');
  const [consentResume, setConsentResume] = useState<ConsentContinuation | null>(null);
  const [managementResume, setManagementResume] = useState<ManagementContinuation | null>(null);
  const [resumeError, setResumeError] = useState('');
  const [resuming, setResuming] = useState(false);
  const consentCapabilityRef = useRef<(() => void) | undefined>(undefined);
  const managementCapabilityRef = useRef<(() => void) | undefined>(undefined);

  const controls = account.controls;
  const idpIndex = account.idpIndex;
  const accountFetch = account.accountFetch;
  // Account controls retain their verified actor. Local preparation and public
  // resources keep the existing transport; a Pod-create helper spans both.
  const managementFetch = useCallback<typeof fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const authority = new URL(idpIndex, window.location.origin);
    return accountFetch && url.origin === authority.origin && url.pathname.startsWith('/.account/')
      ? accountFetch(input instanceof Request ? input : url.href, init)
      : fetch(input, init);
  }, [accountFetch, idpIndex]);
  const accountId = resolveAuthoritativeAccountId(controls, account.identity);
  const bindAccountCapability = account.bindAccountCapability;
  const loadBindings = useCallback(async () => {
    setListError('');
    try {
      const assertCurrent = bindAccountCapability?.();
      assertCurrent?.();
      const nextBindings = await fetchAccountStorageBindings({
        controls, origin: window.location.origin, trustedAccountIndex: idpIndex, fetchImpl: accountFetch,
      });
      assertCurrent?.();
      setBindings(nextBindings);
    } catch {
      setBindings(null);
      setListError('暂时无法读取存储绑定，请重试。');
    }
  }, [accountFetch, bindAccountCapability, controls, idpIndex]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void loadBindings(); });
    return () => { cancelled = true; };
  }, [loadBindings]);

  // Resume context: only a genuinely pending authorization — confirmed against
  // the server for this Account — continues that exact task. A daily visit only
  // offers the Account return address; a stale consent task is never resumed.
  //
  // The Account-capability closure is captured together with the confirmed
  // record: a later click must prove the *same* session is still current, not
  // re-bind whatever session happens to be active when the user clicks.
  useEffect(() => {
    // Without a current authoritative Account no continuation can be resumed.
    // The captured capabilities are dropped here, and the banners are derived
    // from `accountId` in render, so a missing or switched Account hides them
    // immediately without a synchronous setState inside the effect body.
    consentCapabilityRef.current = undefined;
    managementCapabilityRef.current = undefined;
    if (!accountId) return;
    let cancelled = false;
    const assertAccount = bindAccountCapability?.();
    void (async () => {
      let confirmed: ConsentContinuation | null = null;
      try {
        confirmed = await readConfirmedConsentContinuation(
          { accountId },
          { assertCurrent: assertAccount, fetch: managementFetch },
        );
      } catch {
        confirmed = null;
      }
      if (cancelled) return;
      consentCapabilityRef.current = confirmed ? assertAccount : undefined;
      const management = confirmed ? null : readManagementContinuation({ accountId });
      managementCapabilityRef.current = management ? assertAccount : undefined;
      setConsentResume(confirmed);
      setManagementResume(management);
    })();
    return () => { cancelled = true; };
  }, [accountId, bindAccountCapability, managementFetch]);

  /**
   * Drop the resume banner when the captured session is no longer the current
   * one. Returns the captured capability so the async step can re-assert it after
   * every await.
   */
  const assertResumeSession = useCallback((
    expectedAccountId: string,
    assertAccount: (() => void) | undefined,
  ): (() => void) | null => {
    const currentAccountId = resolveAuthoritativeAccountId(controls, account.identity);
    if (!assertAccount || currentAccountId !== expectedAccountId) return null;
    try {
      assertAccount();
    } catch {
      return null;
    }
    return assertAccount;
  }, [account.identity, controls]);

  const resumeAuthorization = useCallback(async () => {
    if (!consentResume || resuming) return;
    const assertAccount = assertResumeSession(consentResume.accountId, consentCapabilityRef.current);
    if (!assertAccount) {
      setConsentResume(null);
      setResumeError('这个授权任务已失效，请回到应用重新发起。');
      return;
    }
    setResuming(true);
    setResumeError('');
    try {
      // Re-confirm with the server at click time: the interaction may have been
      // cancelled since the banner was confirmed on load.
      const confirmed = await confirmConsentInteractionAtAuthority(consentResume, {
        headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
        fetch: managementFetch,
        assertCurrent: assertAccount,
      });
      const consumed = confirmed
        ? consumeConfirmedConsentContinuation(consentResume, { accountId: consentResume.accountId }, { assertCurrent: assertAccount })
        : null;
      if (!consumed) {
        clearConsentContinuation();
        setConsentResume(null);
        setResumeError('这个授权任务已失效，请回到应用重新发起。');
        setResuming(false);
        return;
      }
      window.location.assign(consumed.returnTo);
    } catch {
      setConsentResume(null);
      setResumeError('这个授权任务已失效，请回到应用重新发起。');
      setResuming(false);
    }
  }, [assertResumeSession, consentResume, managementFetch, resuming]);

  const cancelAuthorization = useCallback(async () => {
    if (!consentResume || resuming) return;
    const assertAccount = assertResumeSession(consentResume.accountId, consentCapabilityRef.current);
    if (!assertAccount) {
      setConsentResume(null);
      setResumeError('这个授权任务已失效，请回到应用重新发起。');
      return;
    }
    setResuming(true);
    setResumeError('');
    try {
      const redirect = await fetchOidcCancelRedirectLocation({
        // Rebuild from the confirmed interaction, whether the advertised
        // control is unscoped or already includes an interaction UID.
        cancelUrl: interactionScopedCancelUrl(consentResume.interaction, controls, idpIndex),
        fetchImpl: managementFetch,
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      assertAccount();
      clearConsentContinuation();
      window.location.assign(redirect);
    } catch (error: unknown) {
      // Server messages can be raw English; keep the safe localised copy and
      // leave the diagnostic to tests/logs.
      void error;
      setResumeError('取消授权失败，请重试。');
      setResuming(false);
    }
  }, [assertResumeSession, consentResume, controls, idpIndex, managementFetch, resuming]);

  const returnToAccount = useCallback(() => {
    if (!managementResume || resuming) return;
    const assertAccount = assertResumeSession(managementResume.accountId, managementCapabilityRef.current);
    if (!assertAccount) {
      setManagementResume(null);
      return;
    }
    const consumed = consumeManagementContinuation({ accountId: managementResume.accountId });
    if (!consumed || !isAccountReturnTo(consumed.returnTo)) {
      setManagementResume(null);
      return;
    }
    window.location.assign(consumed.returnTo);
  }, [assertResumeSession, managementResume, resuming]);

  const suggestedName = useMemo(() => deriveFirstPodNameCandidate([
    account.identity?.webId,
    account.identity?.username,
    controls?.account?.username,
  ]), [account.identity?.webId, account.identity?.username, controls?.account?.username]);

  const createPod = async (event: React.FormEvent) => {
    event.preventDefault();
    const createPodUrl = controls?.account?.pod;
    const username = (podName.trim() || suggestedName || '').trim();
    if (creating) return;
    if (!createPodUrl) { setCreateError('当前部署没有公布创建存储空间的入口。'); return; }
    if (!username) { setCreateError('无法从当前账号推断 Pod 名称，请手动填写。'); return; }
    const assertAccount = account.bindAccountCapability?.();
    setCreating(true); setCreateStage(null); setCreateError(''); setCreateNotice('');
    try {
      await createFirstPodAndWaitForBinding({
        assertCurrentAccount: assertAccount,
        fetchImpl: managementFetch,
        createPodUrl,
        headers: storedAccountTokenHeaders(),
        provisionCode: await resolveProvisionCodeForCurrentScope(),
        trustedAccountIndex: idpIndex,
        username,
        onStage: setCreateStage,
      });
      assertAccount?.();
      setPodName('');
      setCreateNotice('存储空间已创建。');
      await loadBindings();
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : '无法创建存储空间，请重试。');
    } finally {
      setCreating(false);
      setCreateStage(null);
    }
  };

  // A continuation belongs only to the Account that confirmed it. Deriving the
  // visible banner from the current authoritative Account id makes a switched or
  // absent Account hide the task immediately, without clearing state in an effect.
  const activeConsentResume = consentResume && consentResume.accountId === accountId ? consentResume : null;
  const activeManagementResume = managementResume && managementResume.accountId === accountId ? managementResume : null;

  return <>
    {activeConsentResume ? (
      <div role="status" data-testid="consent-resume-banner" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/10 p-3">
        <div className="text-sm">
          <div className="font-medium text-foreground">有应用正在等待你的授权</div>
          <div className="text-xs text-muted-foreground">完成这里的操作后可以回到原来的授权继续。</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={resuming} onClick={resumeAuthorization}>回到授权</Button>
          <Button type="button" variant="outline" disabled={resuming} onClick={() => void cancelAuthorization()}>取消授权</Button>
        </div>
      </div>
    ) : activeManagementResume ? (
      <div role="status" data-testid="management-resume-banner" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <div className="text-sm font-medium text-foreground">完成管理后可以回到账号页。</div>
        <Button type="button" variant="outline" onClick={returnToAccount}>返回账号</Button>
      </div>
    ) : null}
    {resumeError ? <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{resumeError}</div> : null}
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">属于当前账号的存储空间</div>
        {/* §7.2：空间详情聚合用量入口 */}
        <a className="text-sm text-primary underline-offset-4 hover:underline" href="/pod/data">
          查看用量
        </a>
      </div>
      {listError ? <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{listError}</div> : null}
      {bindings === null && !listError ? <div role="status" className="text-sm text-muted-foreground">正在读取…</div> : null}
      {bindings?.length === 0 ? (
        <div role="status" className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
          这个账号还没有任何存储空间。创建后即可用它授权应用访问。
        </div>
      ) : null}
      {bindings && bindings.length > 0 ? (
        <ul className="space-y-2">
          {bindings.map((binding) => (
            <li key={`${binding.webId}|${binding.storageUrl}`} className="rounded-lg border border-border p-3 text-sm">
              <div className="break-all font-medium">{binding.storageUrl}</div>
              <div className="mt-1 break-all text-xs text-muted-foreground">{binding.webId}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>

    <form onSubmit={createPod} className="space-y-2 rounded-lg border border-border p-3">
      <label className="block text-sm font-medium" htmlFor="pod-management-name">创建存储空间</label>
      <p className="text-xs text-muted-foreground">创建是一次显式操作：不会因为登录或授权而自动发生。</p>
      <div className="flex flex-wrap gap-2">
        <input
          id="pod-management-name"
          className="h-10 min-w-48 flex-1 rounded-md border border-input bg-background px-3"
          value={podName}
          placeholder={suggestedName || 'my-pod'}
          disabled={creating}
          onChange={(event) => setPodName(event.currentTarget.value)}
        />
        <Button type="submit" disabled={creating}>
          {creating ? createStageLabel(createStage) : '创建'}
        </Button>
      </div>
      {createError ? <div role="alert" className="text-sm text-destructive">{createError}</div> : null}
      {createNotice ? <div role="status" className="text-sm text-muted-foreground">{createNotice}</div> : null}
    </form>
  </>;
}
