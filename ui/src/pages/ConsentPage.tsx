import { scopeAccountUrl } from '../utils/account-interaction-url';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
} from '@undefineds.co/shared-ui';
import type { StorageBinding, WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';
import type { WebAccountConsentOption, WebAccountConsentSelection } from '../auth/WebAccountViews';
import { WebAccountConsentView, WebAccountErrorBanner, WebAccountFailureView, WebAccountRestoringView } from '../auth/WebAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { consumeReturnTo, persistReturnTo } from '../utils/returnTo';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { getStoredProvisionCode, resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { FirstPodReadinessError } from '../utils/consent-first-pod';
import {
  createXpodLoginTransactionStore,
  type XpodLoginTransactionStore,
} from '../auth/xpod-login-transaction';
import {
  reconcileXpodStorageSelection,
  storageBindingKey,
  type XpodStorageSelectionState,
} from '../auth/xpod-storage-selection';
import {
  consentResponseError,
  fetchOidcCancelRedirectLocation,
  resolveConsentDisplayWebIds,
  resolveConsentStorageBindings,
  resolveOidcCancelUrl,
} from './ConsentPage.utils';
import {
  xpodConsentCopy,
  xpodConsentErrors,
  xpodFirstPodErrors,
  xpodRegistrationCopy,
} from '../auth/xpod-account-copy';

interface ConsentClientInfo {
  client_id?: string;
  client_name?: string;
  client_uri?: string;
}

interface ConsentResponse {
  client?: ConsentClientInfo;
  location?: string;
  webId?: string;
}

interface PickWebIdResponse {
  resumeWebId?: unknown;
  location?: string;
  message?: string;
  webIds?: unknown;
  entries?: unknown;
}

interface ParsedPickWebIdResponse {
  exactBindings: StorageBinding[];
  rawIds: string[];
  hasExplicitEmptyEntries: boolean;
}

function safeConsentError(value: unknown, fallback: string): string {
  if (value instanceof FirstPodReadinessError) return value.message;
  const message = value instanceof Error ? value.message : '';
  if (message === 'Invalid OIDC interaction'
    || message === 'This action can only be performed as part of an OIDC authentication flow.'
    || message === xpodConsentErrors.expiredInteraction) {
    return xpodConsentErrors.expiredInteraction;
  }
  if (
    message === 'fetch failed'
    || message.includes('Failed to fetch')
    || message.includes('Cloud storage is not ready')
    || message.includes('provision_refresh_failed')
    || message.includes('provision_refresh_unavailable')
  ) {
    return xpodFirstPodErrors.cloudRouteUnavailable;
  }
  if (
    message === xpodConsentErrors.chooseStorage
    || message === xpodConsentErrors.cannotPersistStorage
    || message === xpodConsentErrors.missingRedirect
    || message === xpodConsentErrors.webIdSelectionFailed
    || message === xpodConsentErrors.authorizationFailed
    || message === xpodConsentErrors.bindingsFailed
    || message === xpodRegistrationCopy.podNameTaken
    || message.startsWith('Pod name is already taken.')
  ) {
    return message;
  }
  return fallback;
}

function parsePickWebIdResponse(data: PickWebIdResponse): ParsedPickWebIdResponse {
  if (!Array.isArray(data.entries)) {
    throw new Error(xpodConsentErrors.bindingsFailed);
  }

  const rawIds = Array.isArray(data.webIds)
    ? data.webIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    : [];
  for (const entry of data.entries) {
    if (resolveConsentStorageBindings([entry]).length !== 1) {
      throw new Error(xpodConsentErrors.bindingsFailed);
    }
  }

  return {
    exactBindings: resolveConsentStorageBindings(data.entries, rawIds),
    rawIds,
    hasExplicitEmptyEntries: data.entries.length === 0,
  };
}

export function ConsentPage() {
  const { idpIndex, isLoggedIn, isAnonymous, controls, logout: accountLogout, refetchControls } = useAuth();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [clientInfo, setClientInfo] = useState<ConsentClientInfo | null>(null);
  const [currentWebId, setCurrentWebId] = useState<string | null>(null);
  const [webIds, setWebIds] = useState<string[]>([]);
  const [consentBindings, setConsentBindings] = useState<StorageBinding[]>([]);
  const [selectedStorageUrl, setSelectedStorageUrl] = useState('');
  const [storageSelection, setStorageSelection] = useState<XpodStorageSelectionState>({ status: 'loading' });
  const [pendingTransaction, setPendingTransaction] = useState<WebIdLoginTransaction>();
  const [selectedWebId, setSelectedWebId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<'load' | 'authorize' | 'cancel' | 'switch' | 'return'>('load');
  const [rememberClient, setRememberClient] = useState(true);
  const [provisionCode, setProvisionCode] = useState<string | undefined>(() => getStoredProvisionCode());
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const [isReturning, setIsReturning] = useState(false);
  const missingOwnerBinding = useRef<string | undefined>(undefined);
  const resumeAttemptedRef = useRef(false);
  const entryBindingScope = useRef<{ transactionId?: string; binding?: StorageBinding } | undefined>(undefined);
  const [entryBinding, setEntryBinding] = useState<StorageBinding>();
  const [resumeState, setResumeState] = useState<'idle' | 'pending' | 'failed'>('idle');
  const transactionStore = useMemo<XpodLoginTransactionStore | undefined>(() => {
    try {
      return createXpodLoginTransactionStore({
        origin: window.location.origin,
        storage: window.sessionStorage,
      });
    } catch {
      return undefined;
    }
  }, []);

  const consentUrl = `${idpIndex}oidc/consent/`;
  const pickWebIdUrl = `${idpIndex}oidc/pick-webid/`;
  const cancelUrl = resolveOidcCancelUrl(controls, idpIndex);

  const refreshConsentState = useCallback(async (preferredBinding?: StorageBinding): Promise<string[]> => {
    let activeTransaction: WebIdLoginTransaction | undefined;
    try {
      activeTransaction = transactionStore?.readSinglePending();
    } catch (err: unknown) {
      setPendingTransaction(undefined);
      setStorageSelection({ status: 'error', message: safeConsentError(err, xpodConsentErrors.invalidTransaction) });
    }
    setPendingTransaction(activeTransaction);
    if (!entryBindingScope.current || entryBindingScope.current.transactionId !== activeTransaction?.id) {
      // Keep the application's entry constraint separate from a selection the
      // user saves before submitting. A failed submission must remain editable.
      entryBindingScope.current = { transactionId: activeTransaction?.id, binding: activeTransaction?.selectedStorage };
      setEntryBinding(activeTransaction?.selectedStorage);
    }

    const consentRes = await fetch(scopeAccountUrl(consentUrl), {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });

    if (consentRes.status === 401 || consentRes.status === 403) {
      await refetchControls().catch(() => undefined);
      setError(xpodConsentErrors.signInRequired);
      return [];
    }
    if (!consentRes.ok) {
      throw consentResponseError(await consentRes.json().catch(() => ({})), xpodConsentErrors.loadFailed);
    }

    const consentData = await consentRes.json().catch(() => ({})) as ConsentResponse;
    if (!consentData.client || typeof consentData.client !== 'object'
      || (typeof consentData.client.client_name !== 'string' && typeof consentData.client.client_id !== 'string')) {
      throw new Error(xpodConsentErrors.clientUnavailable);
    }
    setClientInfo(consentData.client);
    setCurrentWebId(consentData.webId || null);

    const pickRes = await fetch(scopeAccountUrl(pickWebIdUrl), {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });
    if (!pickRes.ok) {
      const pickError = consentResponseError(await pickRes.json().catch(() => ({})), xpodConsentErrors.bindingsFailed);
      if (pickError.message === xpodConsentErrors.expiredInteraction) throw pickError;
      if ([401, 403, 404].includes(pickRes.status)) {
        const account = await refetchControls().catch(() => undefined);
        if (account?.status === 'anonymous') {
          setError(xpodConsentErrors.signInRequired);
          return [];
        }
      }
      setWebIds([]);
      setConsentBindings([]);
      setSelectedWebId('');
      setStorageSelection({ status: 'error', message: xpodConsentErrors.bindingsFailed });
      return [];
    }

    const pickData = await pickRes.json().catch(() => ({})) as PickWebIdResponse;
    const { exactBindings, rawIds, hasExplicitEmptyEntries } = parsePickWebIdResponse(pickData);
    if (exactBindings.length === 0 && hasExplicitEmptyEntries) {
      const currentProvisionCode = await resolveProvisionCodeForCurrentScope(provisionCode);
      setProvisionCode(currentProvisionCode);
    }
    const selectedPendingBinding = entryBindingScope.current.binding
      ?? (exactBindings.length === 1 ? exactBindings[0] : undefined);
    if (activeTransaction && !activeTransaction.selectedStorage && selectedPendingBinding && transactionStore) {
      // A product login that began before Account bindings were loaded can
      // still be one-path when the Account owns exactly one exact binding.
      // Persist that unambiguous pair before rendering consent so neither the
      // UI nor callback needs an implicit first-Pod guess.
      transactionStore.updateSelectedStorage(activeTransaction.id, selectedPendingBinding);
      activeTransaction = { ...activeTransaction, selectedStorage: selectedPendingBinding };
      setPendingTransaction(activeTransaction);
    }
    const eligibleBindings = selectedPendingBinding
      ? exactBindings.filter((binding) => storageBindingKey(binding) === storageBindingKey(selectedPendingBinding))
      : exactBindings;
    const selection: XpodStorageSelectionState = entryBindingScope.current.binding && eligibleBindings.length === 0
      ? { status: 'conflict', message: xpodConsentErrors.bindingUnavailable }
      : reconcileXpodStorageSelection({ bindings: eligibleBindings, remembered: preferredBinding });
    setConsentBindings(exactBindings);
    if (exactBindings.length === 0 && missingOwnerBinding.current) {
      setError(missingOwnerBinding.current);
      setStorageSelection({ status: 'error', message: missingOwnerBinding.current });
    } else {
      missingOwnerBinding.current = undefined;
      setStorageSelection(selection);
    }

    // Keep the legacy IDs for old CSS responses, but never derive a storage
    // URL from those IDs. Canonical consent always renders exact bindings.
    const ids = exactBindings.length > 0
      ? Array.from(new Set(exactBindings.map((entry) => entry.webId)))
      : rawIds;
    setWebIds(ids);
    if (selection.status === 'ready') {
      setSelectedWebId(selection.selected.webId);
      setSelectedStorageUrl(selection.selected.storageUrl);
    } else if (consentData.webId && ids.includes(consentData.webId)) {
      setSelectedWebId(consentData.webId);
      setSelectedStorageUrl('');
    } else if (ids.length > 0) {
      setSelectedWebId(selection.status === 'selecting' || ids.length > 1 ? '' : ids.at(0) ?? '');
      setSelectedStorageUrl('');
    } else {
      setSelectedWebId('');
      setSelectedStorageUrl('');
    }

    // The server offers this only for a remembered grant in the login phase.
    // Verify its WebID against the loaded, scoped owned binding; the hint must
    // never create a binding or choose among multiple identities or Pods.
    if (isLoggedIn && typeof pickData.resumeWebId === 'string'
      && exactBindings.length === 1
      && selection.status === 'ready'
      && selection.selected.webId === pickData.resumeWebId
      && !resumeAttemptedRef.current) {
      resumeAttemptedRef.current = true;
      setResumeState('pending');
      try {
        const response = await fetch(scopeAccountUrl(pickWebIdUrl), {
          method: 'POST',
          headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
          credentials: 'include',
          redirect: 'manual',
          body: JSON.stringify({ webId: pickData.resumeWebId, remember: true }),
        });
        const result = await response.json().catch(() => ({})) as PickWebIdResponse;
        if (!response.ok) throw consentResponseError(result, xpodConsentErrors.webIdSelectionFailed);
        const location = typeof result.location === 'string' ? result.location.trim() : '';
        if (!location) throw new Error(xpodConsentErrors.missingRedirect);
        // Resume at the top level: the IdP may return a code immediately, or
        // request real consent for additional scopes. Never fetch that chain
        // or approve consent on behalf of the user.
        window.location.assign(scopeAccountUrl(location));
      } catch (err: unknown) {
        setResumeState('failed');
        throw err;
      }
    }

    return ids;
  }, [consentUrl, isLoggedIn, pickWebIdUrl, provisionCode, refetchControls, transactionStore]);

  const retryConsentLoad = useCallback((allowResume = true) => {
    resumeAttemptedRef.current = !allowResume;
    setResumeState('idle');
    setFailedAction('load');
    setIsLoading(true);
    setError(null);
    void refreshConsentState(storageSelection.status === 'ready' ? storageSelection.selected : undefined)
      .catch((err: unknown) => {
        setError(safeConsentError(err, xpodConsentErrors.loadFailed));
      })
      .finally(() => setIsLoading(false));
  }, [refreshConsentState, storageSelection]);

  useEffect(() => {
    persistReturnTo(window.location.href);
    (async () => {
      try {
        await refreshConsentState();
      } catch (err: unknown) {
        setError(safeConsentError(err, xpodConsentErrors.loadFailed));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [refreshConsentState]);

  // Account switching is owned by CSS. WebID logout is a separate Solid action.
  const handleSwitchAccount = async () => {
    setIsSwitchingAccount(true);
    try {
      await accountLogout();
      // `logout()` reports a failed CSS revocation by settling with an error
      // Account state instead of rejecting, so the switch must confirm the
      // session is actually anonymous before it leaves this page. Otherwise a
      // 5xx or offline logout would silently keep the previous Account alive.
      if (isAnonymous && !isAnonymous()) {
        throw new Error('Account sign-out did not complete');
      }
      navigate(scopeAccountUrl('/.account/login/password/'));
    } catch {
      setFailedAction('switch');
      setError(xpodConsentErrors.signOutIncomplete);
    } finally {
      setIsSwitchingAccount(false);
    }
  };

  const handleGoToSignIn = () => {
    persistReturnTo(window.location.href);
    navigate(scopeAccountUrl('/.account/login/password/'));
  };

  const handleReturn = async () => {
    if (window.xpodDesktop?.cancelLogin) {
      setIsReturning(true);
      try {
        await window.xpodDesktop.cancelLogin();
      } catch {
        setFailedAction('return');
        setError(error === xpodConsentErrors.expiredInteraction ? error : xpodConsentErrors.returnFailed);
      } finally {
        setIsReturning(false);
      }
      return;
    }
    // A failed/expired interaction has no trusted client return address.
    // Leave its scoped route without replaying it through browser history.
    consumeReturnTo();
    window.location.assign(new URL('/.account/', window.location.origin).href);
  };

  const handleBackToConsent = () => {
    resumeAttemptedRef.current = true;
    setResumeState('idle');
    setError(null);
  };

  const handleCancelConsent = useCallback(async () => {
    try {
      setIsCancelling(true);
      const redirectUrl = await fetchOidcCancelRedirectLocation({
        cancelUrl: scopeAccountUrl(cancelUrl),
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      // The client callback still needs this transaction's original returnTo.
      // The IdP has cancelled authorization; the callback owns local cleanup.
      window.location.href = scopeAccountUrl(redirectUrl);
    } catch (err: unknown) {
      setFailedAction('cancel');
      setError(safeConsentError(err, xpodConsentErrors.cancelFailed));
    } finally {
      setIsCancelling(false);
    }
  }, [cancelUrl]);

  const handleConsent = useCallback(async (allow: boolean, selected?: WebAccountConsentSelection) => {
    if (!allow) {
      await handleCancelConsent();
      return;
    }

    try {
      setIsAuthorizing(true);
      setError(null);

      let selectedBinding: StorageBinding | undefined;
      let requestedWebId = selectedWebId;
      let requestedStorageUrl = selectedStorageUrl;
      if (selected) {
        const selectedPair = consentBindings.find((binding) =>
          storageBindingKey(binding) === selected.webIdId || storageBindingKey(binding) === selected.storageId,
        );
        if (selectedPair) {
          requestedWebId = selectedPair.webId;
          requestedStorageUrl = selectedPair.storageUrl;
          setSelectedWebId(selectedPair.webId);
          setSelectedStorageUrl(selectedPair.storageUrl);
        }
      }
      if (pendingTransaction) {
        if (storageSelection.status !== 'ready') {
          throw new Error(xpodConsentErrors.chooseStorage);
        }
        selectedBinding = storageSelection.selected;
        if (!transactionStore) {
          throw new Error(xpodConsentErrors.cannotPersistStorage);
        }
        // The transaction is read-only until this exact pair is ready. This
        // update is scoped to the active id and never consumes the record.
        transactionStore.updateSelectedStorage(pendingTransaction.id, selectedBinding);
      } else if (consentBindings.length > 0) {
        if (storageSelection.status !== 'ready') {
          throw new Error(xpodConsentErrors.chooseStorage);
        }
        selectedBinding = consentBindings.find((binding) =>
          binding.webId === requestedWebId && (!requestedStorageUrl || binding.storageUrl === requestedStorageUrl));
        if (!selectedBinding) {
          throw new Error(xpodConsentErrors.chooseStorage);
        }
      }

      if (requestedWebId && requestedWebId !== currentWebId) {
        const pickRes = await fetch(scopeAccountUrl(pickWebIdUrl), {
          method: 'POST',
          headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
          credentials: 'include',
          redirect: 'manual',
          body: JSON.stringify({ webId: requestedWebId, remember: true })
        });
        const pickJson = await pickRes.json().catch(() => ({})) as PickWebIdResponse;
        if (!pickRes.ok) {
          throw consentResponseError(pickJson, xpodConsentErrors.webIdSelectionFailed);
        }
        const location = typeof pickJson.location === 'string' ? pickJson.location.trim() : '';
        if (!location) throw new Error(xpodConsentErrors.missingRedirect);
        // Native resume may redirect straight to the SDK code callback or
        // open a new consent interaction. Both belong to document navigation;
        // fetching the redirect chain can fail CORS before the SDK handles it.
        window.location.assign(scopeAccountUrl(location));
        return;
      }

      const consentRes = await fetch(scopeAccountUrl(consentUrl), {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        redirect: 'manual',
        body: JSON.stringify({ remember: rememberClient })
      });
      const consentJson = await consentRes.json().catch(() => ({})) as ConsentResponse & { message?: string };
      if (!consentRes.ok) {
        throw consentResponseError(consentJson, xpodConsentErrors.authorizationFailed);
      }

      // Try to get redirect location from response
      const headerLocation = consentRes.headers.get('Location');
      const redirectUrl = consentJson.location || headerLocation;
      
      if (redirectUrl) {
        window.location.assign(scopeAccountUrl(redirectUrl));
      } else {
        // No redirect URL - authorization complete but nowhere to go
        // This might happen if the OIDC session was lost
        setError(xpodConsentErrors.missingRedirect);
        setFailedAction('authorize');
        setIsLoading(false);
      }
    } catch (err: unknown) {
      setFailedAction('authorize');
      setError(safeConsentError(err, xpodConsentErrors.authorizationFailed));
    } finally {
      setIsAuthorizing(false);
    }
  }, [
    consentBindings,
    consentUrl,
    currentWebId,
    handleCancelConsent,
    pendingTransaction,
    pickWebIdUrl,
    rememberClient,
    selectedStorageUrl,
    selectedWebId,
    storageSelection,
    transactionStore,
  ]);



  const displayWebIds = resolveConsentDisplayWebIds(webIds, currentWebId, Boolean(provisionCode));
  const displayBindings = entryBinding
    ? consentBindings.filter((binding) => storageBindingKey(binding) === storageBindingKey(entryBinding))
    : consentBindings;
  // 授权流程不代用户创建 Pod（设计第二部分 §4.1 / U06）：缺 Pod 时说明原因并给出去向，
  // 绝不在授权页发起 prepare 或创建请求。
  const showNoPodStorage = Boolean(
    !isLoading
    && !error
    && clientInfo
    && displayBindings.length === 0
    && storageSelection.status === 'empty',
  );
  const isSubmitting = isAuthorizing || isCancelling || isSwitchingAccount || isReturning;
  const hasStorageConflict = storageSelection.status === 'conflict';

  const displayOptions: WebAccountConsentOption[] = displayBindings.length > 0
    ? displayBindings.map((binding) => ({
      id: storageBindingKey(binding),
      label: binding.label ?? `${binding.webId} · ${binding.storageUrl}`,
      webId: binding.webId,
      storageUrl: binding.storageUrl,
    }))
    : displayWebIds.map((webId) => ({ id: webId, label: webId, webId }));
  const selectedBinding = displayBindings.find((binding) => binding.webId === selectedWebId && binding.storageUrl === selectedStorageUrl)
    ?? displayBindings.find((binding) => binding.webId === selectedWebId);
  const selectedOptionId = displayBindings.length > 1 && storageSelection.status !== 'ready'
    ? ''
    : selectedBinding
      ? storageBindingKey(selectedBinding)
      : selectedWebId;
  // 只有"冲突/绑定异常"仍走存储引导视图；"完全没有 Pod"由 showNoPodStorage 处理，
  // 不再进入创建流程（设计第二部分 §4.1 / U06）。
  const showStorageBootstrap = hasStorageConflict
    || (displayBindings.length === 0 && storageSelection.status === 'error');

  // 保留原 interaction 与返回地址：建好 Pod 回到这里后会重新读取权威绑定与服务健康。
  // 目标是统一的 Pod 管理页（设计第二部分 §4.1 / U08+U09）；该页由 Account 边界准入，
  // 零 Pod 时也可达，因此不再回退到 Account 页。
  const handleGoToPodManagement = () => {
    persistReturnTo(window.location.href);
    navigate('/settings/pod');
  };

  const interactionExpired = error === xpodConsentErrors.expiredInteraction;
  const needsSignIn = !isLoggedIn || error === xpodConsentErrors.signInRequired;
  const showFailure = Boolean(error && (
    interactionExpired || failedAction !== 'load' || resumeState === 'failed' || !clientInfo
  ));
  const canReturnToConsent = Boolean(clientInfo && displayOptions.length > 0 && !interactionExpired && !needsSignIn);
  const returnLabel = window.xpodDesktop?.cancelLogin ? '返回应用' : '返回账号';
  const retryFailure = () => {
    if (failedAction === 'cancel') void handleCancelConsent();
    else if (failedAction === 'switch') void handleSwitchAccount();
    else if (failedAction === 'return') void handleReturn();
    else retryConsentLoad(failedAction !== 'authorize');
  };

  return (
    <XpodAccountPageSurface title={xpodConsentCopy.surfaceTitle} presentation="compact">
      <div className="space-y-4">
      {interactionExpired ? (
        <WebAccountFailureView
          title="授权请求已失效"
          description={error}
          primaryLabel={failedAction === 'return' ? '重试返回' : returnLabel}
          onPrimary={() => void handleReturn()}
          pending={isSubmitting}
        />
      ) : needsSignIn && !(error && failedAction !== 'load') ? (
        <WebAccountFailureView
          title={xpodConsentCopy.signInRequiredTitle}
          description={xpodConsentCopy.signInRequiredDescription}
          primaryLabel={xpodConsentCopy.goToSignIn}
          onPrimary={handleGoToSignIn}
          secondaryLabel={returnLabel}
          onSecondary={() => void handleReturn()}
          pending={isSubmitting}
        />
      ) : showFailure ? (
        <WebAccountFailureView
          title={xpodConsentCopy.unavailableTitle}
          description={error}
          primaryLabel={failedAction === 'cancel' ? '重试取消' : failedAction === 'return' ? '重试返回' : xpodConsentCopy.tryAgain}
          onPrimary={retryFailure}
          secondaryLabel={canReturnToConsent ? '返回授权' : returnLabel}
          onSecondary={canReturnToConsent ? handleBackToConsent : () => void handleReturn()}
          pending={isSubmitting || isLoading}
        />
      ) : error && !showStorageBootstrap ? (
        <WebAccountErrorBanner error={error} onDismiss={() => setError(null)} dismissLabel={xpodConsentCopy.dismiss} />
      ) : null}
      {(showFailure || needsSignIn) && !interactionExpired ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="ghost" disabled={isSubmitting || isLoading}
            onClick={() => void handleCancelConsent()}>
            {isCancelling ? '正在取消…' : '取消授权'}
          </Button>
          {isLoggedIn ? (
            <Button type="button" variant="ghost" disabled={isSubmitting || isLoading}
              onClick={() => void handleSwitchAccount()}>{xpodConsentCopy.switchAccountLabel}</Button>
          ) : null}
          {canReturnToConsent && window.xpodDesktop?.cancelLogin ? (
            <Button type="button" variant="ghost" disabled={isSubmitting || isLoading}
              onClick={() => void handleReturn()}>{returnLabel}</Button>
          ) : null}
        </div>
      ) : null}
      {!needsSignIn && !interactionExpired ? (isLoading || resumeState === 'pending' ? (
        <WebAccountRestoringView label={xpodConsentCopy.restoring} />
      ) : showNoPodStorage ? (
        <WebAccountFailureView
          title={xpodConsentCopy.missingPodTitle}
          description={xpodConsentCopy.missingPodDescription}
          primaryLabel={xpodConsentCopy.goToPodManagementLabel}
          onPrimary={handleGoToPodManagement}
          secondaryLabel={xpodConsentCopy.denyLabel}
          onSecondary={() => void handleCancelConsent()}
          pending={isSubmitting}
        />
      ) : showFailure ? null : (
        <div className="space-y-4">
          {!showStorageBootstrap ? (
            <WebAccountConsentView
              client={{
                name: clientInfo?.client_name || xpodConsentCopy.applicationFallback,
                description: clientInfo?.client_uri,
              }}
              webIds={displayOptions}
              storageOptions={[]}
              selectedWebIdId={selectedOptionId}
              showIdentitySelection={displayBindings.length > 1}
              rememberClient={rememberClient}
              onWebIdChange={(optionId) => {
                const binding = displayBindings.find((candidate) => storageBindingKey(candidate) === optionId);
                if (binding) {
                  setSelectedWebId(binding.webId);
                  setSelectedStorageUrl(binding.storageUrl);
                  setStorageSelection({ status: 'ready', selected: binding });
                } else {
                  setSelectedWebId(optionId);
                  setSelectedStorageUrl('');
                }
              }}
              onStorageChange={(optionId) => {
                const binding = displayBindings.find((candidate) => storageBindingKey(candidate) === optionId);
                if (binding) {
                  setSelectedWebId(binding.webId);
                  setSelectedStorageUrl(binding.storageUrl);
                  setStorageSelection({ status: 'ready', selected: binding });
                }
              }}
              onRememberClientChange={setRememberClient}
              onApprove={(selection) => void handleConsent(true, selection)}
              onDeny={() => void handleConsent(false)}
              onEditAccount={async () => {
                persistReturnTo(window.location.href);
                navigate(scopeAccountUrl('/.account/account/'));
              }}
              onSwitchAccount={handleSwitchAccount}
              pending={isSubmitting}
              copy={{
                description: xpodConsentCopy.description(clientInfo?.client_name || xpodConsentCopy.applicationFallback),
                webIdLabel: displayBindings.length > 1 ? xpodConsentCopy.bindingLabel : xpodConsentCopy.webIdLabel,
                storageLabel: xpodConsentCopy.storageLabel,
                rememberClientLabel: xpodConsentCopy.rememberClientLabel,
                approveLabel: isAuthorizing ? xpodConsentCopy.approvingLabel : xpodConsentCopy.approveLabel,
                denyLabel: isCancelling ? xpodConsentCopy.denyingLabel : xpodConsentCopy.denyLabel,
                editAccountLabel: xpodConsentCopy.editAccountLabel,
                switchAccountLabel: xpodConsentCopy.switchAccountLabel,
              }}
            />
          ) : null}
          {showStorageBootstrap ? (
            // 冲突/绑定异常只给"重试"与"切换账号"（设计第一部分 C7、第二部分 §4.1 / U06）：
            // 授权页不提供任何创建动作，创建只在 Pod 管理页由用户显式发起。
            <WebAccountFailureView
              title={hasStorageConflict ? xpodConsentCopy.conflictMessage : xpodConsentCopy.unavailableTitle}
              description={storageSelection.status === 'conflict' || storageSelection.status === 'error'
                ? storageSelection.message
                : error}
              primaryLabel={xpodConsentCopy.retryLabel}
              onPrimary={() => retryConsentLoad(true)}
              secondaryLabel={xpodConsentCopy.switchAccountLabel}
              onSecondary={handleSwitchAccount}
              pending={isSubmitting}
            />
          ) : null}
        </div>
      )) : null}
      </div>
    </XpodAccountPageSurface>
  );
}
