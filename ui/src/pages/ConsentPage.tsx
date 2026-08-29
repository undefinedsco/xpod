import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AuthSurface,
  Input,
  Label,
  LoginErrorBanner,
  LoginFailureView,
  LoginRestoringView,
  OidcConsentView,
  StorageBootstrapView,
  type OidcConsentOption,
  type OidcConsentSelection,
  type StorageBootstrapState,
} from '@undefineds.co/shared-ui';
import type { StorageBinding, WebIdLoginTransaction } from '@undefineds.co/solid-sdk';
import { useAuth } from '../context/AuthContextValue';
import { XpodAuthContext } from '../auth/useXpodAuth';
import { readPendingXpodAccountEmail } from '../auth/xpod-remembered-login';
import { persistReturnTo } from '../utils/returnTo';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { getStoredProvisionCode, resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { createFirstPodAndWaitForBinding, deriveFirstPodNameCandidate } from '../utils/consent-first-pod';
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
  const message = value instanceof Error ? value.message : '';
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

function isSameOriginXpodTransaction(transaction: WebIdLoginTransaction | undefined): transaction is WebIdLoginTransaction {
  if (!transaction?.selectedStorage) return false;
  try {
    const origin = window.location.origin;
    return new URL(transaction.route.identityProvider.url).origin === origin
      && new URL(transaction.route.storageProvider?.url ?? '').origin === origin
      && new URL(transaction.selectedStorage.webId).origin === origin
      && new URL(transaction.selectedStorage.storageUrl).origin === origin;
  } catch {
    return false;
  }
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
  const { idpIndex, isLoggedIn, controls, logout: accountLogout } = useAuth();
  const xpodAuth = useContext(XpodAuthContext);
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
  const [podName, setPodName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rememberClient, setRememberClient] = useState(true);
  const [provisionCode, setProvisionCode] = useState<string | undefined>(() => getStoredProvisionCode());
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCreatingStorage, setIsCreatingStorage] = useState(false);
  const [autoProvisionAttempted, setAutoProvisionAttempted] = useState(false);
  const [autoConsentAttempted, setAutoConsentAttempted] = useState(false);
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

  const refreshConsentState = useCallback(async (): Promise<string[]> => {
    let activeTransaction: WebIdLoginTransaction | undefined;
    try {
      activeTransaction = transactionStore?.readSinglePending();
    } catch (err: unknown) {
      setPendingTransaction(undefined);
      setStorageSelection({ status: 'error', message: safeConsentError(err, xpodConsentErrors.invalidTransaction) });
    }
    setPendingTransaction(activeTransaction);

    const consentRes = await fetch(consentUrl, {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });

    if (consentRes.status === 401 || consentRes.status === 403) {
      setError(xpodConsentErrors.signInRequired);
      return [];
    }
    if (!consentRes.ok) {
      await consentRes.json().catch(() => ({}));
      throw new Error(xpodConsentErrors.loadFailed);
    }

    const consentData = await consentRes.json().catch(() => ({})) as ConsentResponse;
    if (!consentData.client || typeof consentData.client !== 'object'
      || (typeof consentData.client.client_name !== 'string' && typeof consentData.client.client_id !== 'string')) {
      throw new Error(xpodConsentErrors.clientUnavailable);
    }
    setClientInfo(consentData.client);
    setCurrentWebId(consentData.webId || null);

    const pickRes = await fetch(pickWebIdUrl, {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });
    if (!pickRes.ok) {
      setWebIds([]);
      setConsentBindings([]);
      setSelectedWebId('');
      setStorageSelection({ status: 'error', message: xpodConsentErrors.bindingsFailed });
      return [];
    }

    const pickData = await pickRes.json().catch(() => ({})) as PickWebIdResponse;
    const { exactBindings, rawIds, hasExplicitEmptyEntries } = parsePickWebIdResponse(pickData);
    if (exactBindings.length === 0 && hasExplicitEmptyEntries) {
      const currentProvisionCode = await resolveProvisionCodeForCurrentScope(fetch, provisionCode);
      setProvisionCode(currentProvisionCode);
    }
    const selectedPendingBinding = activeTransaction?.selectedStorage
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
    const selection = reconcileXpodStorageSelection({ bindings: eligibleBindings });
    setConsentBindings(exactBindings);
    setStorageSelection(selection);

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

    return ids;
  }, [consentUrl, pickWebIdUrl, provisionCode, transactionStore]);

  const retryConsentLoad = useCallback(() => {
    setIsLoading(true);
    setError(null);
    void refreshConsentState()
      .catch((err: unknown) => {
        setError(safeConsentError(err, xpodConsentErrors.loadFailed));
      })
      .finally(() => setIsLoading(false));
  }, [refreshConsentState]);

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

  // Let the host coordinator clear both auth domains before starting login.
  const handleSwitchAccount = async () => {
    try {
      if (xpodAuth) {
        const result = await xpodAuth.switchAccount();
        if (result && typeof result === 'object' && 'status' in result && result.status !== 'complete') {
          setError(xpodConsentErrors.signOutIncomplete);
        }
        return;
      }
      await accountLogout();
      window.location.href = '/.account/login/password/';
    } catch {
      setError(xpodConsentErrors.signOutIncomplete);
    }
  };

  const handleGoToSignIn = () => {
    persistReturnTo(window.location.href);
    navigate('/.account/login/password/');
  };

  const handleCancelConsent = useCallback(async () => {
    try {
      setIsCancelling(true);
      setError(null);
      const redirectUrl = await fetchOidcCancelRedirectLocation({
        cancelUrl,
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      });
      if (pendingTransaction && transactionStore) {
        transactionStore.cancel(pendingTransaction.id);
        setPendingTransaction(undefined);
      }
      window.location.href = redirectUrl;
    } catch (err: unknown) {
      setError(safeConsentError(err, xpodConsentErrors.cancelFailed));
    } finally {
      setIsCancelling(false);
    }
  }, [cancelUrl, pendingTransaction, transactionStore]);

  const handleConsent = useCallback(async (allow: boolean, selected?: OidcConsentSelection) => {
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
        const pickRes = await fetch(pickWebIdUrl, {
          method: 'POST',
          headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ webId: requestedWebId, remember: true })
        });
        const pickJson = await pickRes.json().catch(() => ({})) as PickWebIdResponse;
        if (!pickRes.ok) {
          throw new Error(xpodConsentErrors.webIdSelectionFailed);
        }
        if (pickJson.location) {
          await fetch(pickJson.location, { credentials: 'include' });
        }
      }

      const consentRes = await fetch(consentUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ remember: rememberClient })
      });
      const consentJson = await consentRes.json().catch(() => ({})) as ConsentResponse & { message?: string };
      if (!consentRes.ok) {
        throw new Error(xpodConsentErrors.authorizationFailed);
      }

      // Try to get redirect location from response
      const headerLocation = consentRes.headers.get('Location');
      const redirectUrl = consentJson.location || headerLocation;
      
      if (redirectUrl) {
        window.location.assign(redirectUrl);
      } else {
        // No redirect URL - authorization complete but nowhere to go
        // This might happen if the OIDC session was lost
        setError(xpodConsentErrors.missingRedirect);
        setIsLoading(false);
      }
    } catch (err: unknown) {
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

  const handleCreateStorage = useCallback(async () => {
    const createPodUrl = controls?.account?.pod;
    const username = deriveFirstPodNameCandidate([
      currentWebId,
      controls?.account?.username,
      readPendingXpodAccountEmail(),
    ])
      || controls?.account?.username
      || podName.trim();
    if (!createPodUrl || !username) {
      setError(xpodConsentErrors.choosePodName);
      setStorageSelection({ status: 'error', message: xpodConsentErrors.storageCreationUnavailable });
      return;
    }

    try {
      setIsCreatingStorage(true);
      setError(null);
      setStorageSelection({ status: 'creating' });
      const bindings = await createFirstPodAndWaitForBinding({
        createPodUrl,
        headers: storedAccountTokenHeaders(),
        pickWebIdUrl,
        provisionCode,
        username,
      });
      setConsentBindings(bindings);
      setWebIds(Array.from(new Set(bindings.map((binding) => binding.webId))));
      const nextSelection = reconcileXpodStorageSelection({ bindings });
      setStorageSelection(nextSelection);
      if (nextSelection.status === 'ready') {
        setSelectedWebId(nextSelection.selected.webId);
        setSelectedStorageUrl(nextSelection.selected.storageUrl);
      }
    } catch (err: unknown) {
      const message = safeConsentError(err, xpodConsentErrors.storageCreateFailed);
      setError(message);
      setStorageSelection({ status: 'error', message });
    } finally {
      setIsCreatingStorage(false);
    }
  }, [controls?.account?.pod, controls?.account?.username, currentWebId, pickWebIdUrl, podName, provisionCode]);

  const displayWebIds = resolveConsentDisplayWebIds(webIds, currentWebId, Boolean(provisionCode));
  const displayBindings = pendingTransaction?.selectedStorage
    ? consentBindings.filter((binding) => storageBindingKey(binding) === storageBindingKey(pendingTransaction.selectedStorage!))
    : consentBindings;
  const selectedReadyBinding = storageSelection.status === 'ready' ? storageSelection.selected : undefined;
  const shouldAutoSubmitConsent = Boolean(
    isSameOriginXpodTransaction(pendingTransaction)
    && !isLoading
    && !error
    && consentBindings.length === 1
    && displayBindings.length === 1
    && selectedReadyBinding
    && storageBindingKey(displayBindings[0]!) === storageBindingKey(selectedReadyBinding),
  );
  const derivedPodName = deriveFirstPodNameCandidate([
    currentWebId,
    controls?.account?.username,
    readPendingXpodAccountEmail(),
  ]);
  const showPodNameInput = displayBindings.length === 0 && !derivedPodName && !controls?.account?.username;
  const shouldAutoProvisionStorage = Boolean(
    !isLoading
    && !error
    && clientInfo
    && displayBindings.length === 0
    && storageSelection.status === 'empty'
    && controls?.account?.pod
    && (derivedPodName || controls?.account?.username),
  );
  const isSubmitting = isAuthorizing || isCancelling || isCreatingStorage;
  // Suppress the manual approval surface as soon as this is a validated
  // one-path Xpod transaction. React effects run after paint, so waiting for
  // the POST attempt here would flash a second Authorize button for one frame.
  const isAutoConsentFlow = shouldAutoSubmitConsent;
  const hasStorageConflict = storageSelection.status === 'conflict';

  const displayOptions: OidcConsentOption[] = displayBindings.length > 0
    ? displayBindings.map((binding) => ({
      id: storageBindingKey(binding),
      label: binding.webId,
      webId: binding.webId,
      storageUrl: binding.storageUrl,
    }))
    : displayWebIds.map((webId) => ({ id: webId, label: webId, webId }));
  const selectedBinding = displayBindings.find((binding) => binding.webId === selectedWebId && binding.storageUrl === selectedStorageUrl)
    ?? displayBindings.find((binding) => binding.webId === selectedWebId);
  const selectedOptionId = selectedBinding ? storageBindingKey(selectedBinding) : selectedWebId;
  const bootstrapState: StorageBootstrapState = storageSelection.status === 'loading'
    ? 'waiting'
    : storageSelection.status === 'empty'
      ? 'creation'
      : storageSelection.status === 'creating'
        ? 'creating'
      : storageSelection.status === 'waiting_for_binding'
          ? 'waiting_for_binding'
          : storageSelection.status === 'selecting'
            ? 'waiting_for_binding'
          : storageSelection.status === 'ready'
            ? 'ready'
            : storageSelection.status === 'conflict'
              ? { status: 'conflict', message: storageSelection.message }
              : { status: 'error', message: storageSelection.message };
  const showStorageBootstrap = hasStorageConflict || (displayBindings.length === 0 && (
    displayWebIds.length === 0
    || storageSelection.status === 'empty'
    || storageSelection.status === 'creating'
    || storageSelection.status === 'waiting_for_binding'
    || storageSelection.status === 'selecting'
    || storageSelection.status === 'error'
  ));

  useEffect(() => {
    if (!shouldAutoProvisionStorage || autoProvisionAttempted || isCreatingStorage) return;
    queueMicrotask(() => {
      setAutoProvisionAttempted(true);
      void handleCreateStorage();
    });
  }, [autoProvisionAttempted, handleCreateStorage, isCreatingStorage, shouldAutoProvisionStorage]);

  useEffect(() => {
    if (!shouldAutoSubmitConsent || autoConsentAttempted || isSubmitting) return;
    const optionId = storageBindingKey(selectedReadyBinding!);
    queueMicrotask(() => {
      setAutoConsentAttempted(true);
      void handleConsent(true, { webIdId: optionId, storageId: optionId, rememberClient });
    });
  }, [autoConsentAttempted, handleConsent, isSubmitting, rememberClient, selectedReadyBinding, shouldAutoSubmitConsent]);

  return (
    <AuthSurface mode="page" title={xpodConsentCopy.surfaceTitle}>
      <div className="space-y-4 p-4">
      {!isLoggedIn ? (
        <LoginFailureView
          title={xpodConsentCopy.signInRequiredTitle}
          description={xpodConsentCopy.signInRequiredDescription}
          primaryLabel={xpodConsentCopy.goToSignIn}
          onPrimary={handleGoToSignIn}
        />
      ) : error && !clientInfo ? (
        <LoginFailureView
          title={xpodConsentCopy.unavailableTitle}
          description={error}
          primaryLabel={xpodConsentCopy.tryAgain}
          onPrimary={retryConsentLoad}
        />
      ) : error ? (
        <LoginErrorBanner error={error} onDismiss={() => setError(null)} dismissLabel={xpodConsentCopy.dismiss} />
      ) : null}
      {isLoggedIn ? (isLoading ? (
        <LoginRestoringView label={xpodConsentCopy.restoring} />
      ) : shouldAutoProvisionStorage || isCreatingStorage ? (
        <LoginRestoringView label={xpodConsentCopy.waitingMessage} />
      ) : error && !clientInfo ? null : (
        <div className="space-y-4">
          {!hasStorageConflict && !isAutoConsentFlow ? (
            <OidcConsentView
              client={{
                name: clientInfo?.client_name || xpodConsentCopy.applicationFallback,
                description: clientInfo?.client_uri,
              }}
              webIds={displayOptions}
              storageOptions={displayBindings.length > 0 ? displayOptions : []}
              selectedWebIdId={selectedOptionId}
              selectedStorageId={displayBindings.length > 0 ? selectedOptionId : undefined}
              showIdentitySelection={false}
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
                navigate('/.account/account/');
              }}
              onSwitchAccount={handleSwitchAccount}
              pending={isSubmitting}
              copy={{
                title: xpodConsentCopy.title,
                description: xpodConsentCopy.description(clientInfo?.client_name || xpodConsentCopy.applicationFallback),
                webIdLabel: xpodConsentCopy.webIdLabel,
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
            <>
              {showPodNameInput ? (
                <div className="space-y-2">
                  <Label htmlFor="consent-pod-name">{xpodConsentCopy.podNameLabel}</Label>
                  <Input
                    id="consent-pod-name"
                    autoComplete="username"
                    value={podName}
                    disabled={isCreatingStorage}
                    onChange={(event) => setPodName(event.currentTarget.value)}
                  />
                </div>
              ) : null}
              <StorageBootstrapView
                state={bootstrapState}
                pending={isCreatingStorage}
                onCreate={handleCreateStorage}
                onRetry={hasStorageConflict ? retryConsentLoad : handleCreateStorage}
                copy={{
                  title: xpodConsentCopy.prepareTitle,
                  description: xpodConsentCopy.prepareDescription,
                  creationMessage: xpodConsentCopy.creationMessage,
                  waitingMessage: xpodConsentCopy.waitingMessage,
                  readyMessage: xpodConsentCopy.readyMessage,
                  conflictMessage: xpodConsentCopy.conflictMessage,
                  errorMessage: xpodConsentCopy.errorMessage,
                  createLabel: xpodConsentCopy.createLabel,
                  continueLabel: xpodConsentCopy.continueLabel,
                  retryLabel: xpodConsentCopy.retryLabel,
                  cancelLabel: xpodConsentCopy.cancelLabel,
                }}
              />
            </>
          ) : null}
        </div>
      )) : null}
      </div>
    </AuthSurface>
  );
}
