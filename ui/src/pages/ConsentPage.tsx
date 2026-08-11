import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AuthSurface,
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

function safeConsentError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : '';
  if (
    message === 'Choose a storage before approving this authorization.'
    || message === 'This browser cannot keep the selected storage for the callback.'
    || message === 'Authorization completed but no redirect URL received. The application may need to restart the login flow.'
    || message === 'WebID selection could not be completed. Please try again.'
    || message === 'Authorization could not be completed. Please try again.'
    || message.startsWith('Pod name is already taken.')
  ) {
    return message;
  }
  return fallback;
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
  const [error, setError] = useState<string | null>(null);
  const [rememberClient, setRememberClient] = useState(true);
  const [provisionCode, setProvisionCode] = useState<string | undefined>(() => getStoredProvisionCode());
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isCreatingStorage, setIsCreatingStorage] = useState(false);
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
      setStorageSelection({ status: 'error', message: safeConsentError(err, 'Sign-in transaction is invalid.') });
    }
    setPendingTransaction(activeTransaction);

    const currentProvisionCode = await resolveProvisionCodeForCurrentScope(fetch, provisionCode);
    setProvisionCode(currentProvisionCode);

    const consentRes = await fetch(consentUrl, {
      headers: storedAccountTokenHeaders(),
      credentials: 'include',
    });

    if (consentRes.status === 401 || consentRes.status === 403) {
      setError('Please sign in to continue authorization.');
      return [];
    }
    if (!consentRes.ok) {
      await consentRes.json().catch(() => ({}));
      throw new Error('Authorization information could not be loaded. Please try again.');
    }

    const consentData = await consentRes.json().catch(() => ({})) as ConsentResponse;
    if (!consentData.client || typeof consentData.client !== 'object'
      || (typeof consentData.client.client_name !== 'string' && typeof consentData.client.client_id !== 'string')) {
      throw new Error('Authorization client information is unavailable.');
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
      setStorageSelection({ status: 'error', message: 'WebID bindings could not be loaded. Please try again.' });
      return [];
    }

    const pickData = await pickRes.json().catch(() => ({})) as PickWebIdResponse;
    const rawIds = Array.isArray(pickData.webIds)
      ? pickData.webIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const exactBindings = resolveConsentStorageBindings(pickData.entries, rawIds);
    const selectedPendingBinding = activeTransaction?.selectedStorage;
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
        setError(safeConsentError(err, 'Authorization information could not be loaded. Please try again.'));
      })
      .finally(() => setIsLoading(false));
  }, [refreshConsentState]);

  useEffect(() => {
    persistReturnTo(window.location.href);
    (async () => {
      try {
        await refreshConsentState();
      } catch (err: unknown) {
        setError(safeConsentError(err, 'Authorization information could not be loaded. Please try again.'));
      } finally {
        setIsLoading(false);
      }
    })();
  }, [refreshConsentState]);

  // Let the host coordinator clear both auth domains before starting login.
  const handleSwitchAccount = async () => {
    try {
      if (xpodAuth) {
        const result = await xpodAuth.switchAccount(window.location.href);
        if (result && typeof result === 'object' && 'status' in result && result.status !== 'complete') {
          setError('Sign out incomplete. Please try again.');
        }
        return;
      }
      await accountLogout();
      window.location.href = '/.account/login/password/';
    } catch {
      setError('Sign out incomplete. Please try again.');
    }
  };

  const handleGoToSignIn = () => {
    persistReturnTo(window.location.href);
    navigate('/.account/login/password/');
  };

  const handleConsent = async (allow: boolean, selected?: OidcConsentSelection) => {
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
          throw new Error('Choose a storage before approving this authorization.');
        }
        selectedBinding = storageSelection.selected;
        if (!transactionStore) {
          throw new Error('This browser cannot keep the selected storage for the callback.');
        }
        // The transaction is read-only until this exact pair is ready. This
        // update is scoped to the active id and never consumes the record.
        transactionStore.updateSelectedStorage(pendingTransaction.id, selectedBinding);
      } else if (consentBindings.length > 0) {
        if (storageSelection.status !== 'ready') {
          throw new Error('Choose a storage before approving this authorization.');
        }
        selectedBinding = consentBindings.find((binding) =>
          binding.webId === requestedWebId && (!requestedStorageUrl || binding.storageUrl === requestedStorageUrl));
        if (!selectedBinding) {
          throw new Error('Choose a storage before approving this authorization.');
        }
      }

      if (requestedWebId && requestedWebId !== currentWebId) {
        const pickRes = await fetch(pickWebIdUrl, {
          method: 'POST',
          headers: storedAccountTokenHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
          credentials: 'include',
          body: JSON.stringify({ webId: requestedWebId, remember: false })
        });
        const pickJson = await pickRes.json().catch(() => ({})) as PickWebIdResponse;
        if (!pickRes.ok) {
          throw new Error('WebID selection could not be completed. Please try again.');
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
        throw new Error('Authorization could not be completed. Please try again.');
      }

      // Try to get redirect location from response
      const headerLocation = consentRes.headers.get('Location');
      const redirectUrl = consentJson.location || headerLocation;
      
      if (redirectUrl) {
        window.location.assign(redirectUrl);
      } else {
        // No redirect URL - authorization complete but nowhere to go
        // This might happen if the OIDC session was lost
        setError('Authorization completed but no redirect URL received. The application may need to restart the login flow.');
        setIsLoading(false);
      }
    } catch (err: unknown) {
      setError(safeConsentError(err, 'Authorization could not be completed. Please try again.'));
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleCancelConsent = async () => {
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
      setError(safeConsentError(err, 'Authorization cancellation failed. Please try again.'));
    } finally {
      setIsCancelling(false);
    }
  };

  const handleCreateStorage = async () => {
    const createPodUrl = controls?.account?.pod;
    const username = deriveFirstPodNameCandidate([currentWebId]);
    if (!createPodUrl || !username) {
      setError('Pod creation is unavailable until the Account exposes a Pod name.');
      setStorageSelection({ status: 'error', message: 'Storage creation is unavailable.' });
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
      const message = safeConsentError(err, 'Storage could not be created. Please try again.');
      setError(message);
      setStorageSelection({ status: 'error', message });
    } finally {
      setIsCreatingStorage(false);
    }
  };

  const displayWebIds = resolveConsentDisplayWebIds(webIds, currentWebId, Boolean(provisionCode));
  const displayBindings = pendingTransaction?.selectedStorage
    ? consentBindings.filter((binding) => storageBindingKey(binding) === storageBindingKey(pendingTransaction.selectedStorage!))
    : consentBindings;
  const isSubmitting = isAuthorizing || isCancelling || isCreatingStorage;

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
  const showStorageBootstrap = displayBindings.length === 0 && (
    displayWebIds.length === 0
    || storageSelection.status === 'empty'
    || storageSelection.status === 'creating'
    || storageSelection.status === 'waiting_for_binding'
    || storageSelection.status === 'selecting'
    || storageSelection.status === 'conflict'
    || storageSelection.status === 'error'
  );

  return (
    <AuthSurface mode="page" title="Authorize">
      <div className="space-y-4 p-4">
      {!isLoggedIn ? (
        <LoginFailureView
          title="Sign in required"
          description="Sign in to approve this request and choose which WebID to share."
          primaryLabel="Go to sign in"
          onPrimary={handleGoToSignIn}
        />
      ) : error && !clientInfo ? (
        <LoginFailureView
          title="Authorization unavailable"
          description={error}
          primaryLabel="Try again"
          onPrimary={retryConsentLoad}
        />
      ) : error ? (
        <LoginErrorBanner error={error} onDismiss={() => setError(null)} dismissLabel="Dismiss" />
      ) : null}
      {isLoggedIn ? (isLoading ? (
        <LoginRestoringView label="Restoring authorization…" />
      ) : error && !clientInfo ? null : (
        <div className="space-y-4">
          <OidcConsentView
            client={{
              name: clientInfo?.client_name || 'Application',
              description: clientInfo?.client_uri,
            }}
            webIds={displayOptions}
            storageOptions={displayBindings.length > 0 ? displayOptions : []}
            selectedWebIdId={selectedOptionId}
            selectedStorageId={displayBindings.length > 0 ? selectedOptionId : undefined}
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
              title: 'Authorize access',
              description: `${clientInfo?.client_name || 'Application'} requests access to your Account data.`,
              webIdLabel: 'WebID',
              storageLabel: 'Storage',
              rememberClientLabel: 'Remember this client',
              approveLabel: isAuthorizing ? 'Authorizing…' : 'Authorize',
              denyLabel: isCancelling ? 'Denying…' : 'Deny',
              editAccountLabel: 'Edit account',
              switchAccountLabel: 'Use a different account',
            }}
          />
          {showStorageBootstrap ? (
            <StorageBootstrapView
              state={bootstrapState}
              pending={isCreatingStorage}
              onCreate={handleCreateStorage}
              onRetry={handleCreateStorage}
              copy={{
                title: 'Prepare storage',
                description: 'Create a local storage binding before approving access.',
                creationMessage: 'No eligible storage is available yet.',
                waitingMessage: 'Waiting for the storage binding.',
                readyMessage: 'Storage is ready.',
                conflictMessage: 'The selected storage conflicts with this identity.',
                errorMessage: 'Storage could not be prepared.',
                createLabel: 'Create storage',
                continueLabel: 'Continue',
                retryLabel: 'Try again',
                cancelLabel: 'Cancel',
              }}
            />
          ) : null}
        </div>
      )) : null}
      </div>
    </AuthSurface>
  );
}
