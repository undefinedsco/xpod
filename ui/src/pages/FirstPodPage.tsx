import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LoginFailureView,
  LoginRestoringView,
} from '@undefineds.co/shared-ui';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { XpodAuthSurface } from '../auth/XpodAuthSurface';
import { useAuth } from '../context/AuthContextValue';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import {
  createFirstPodAndWaitForBinding,
  deriveFirstPodNameCandidate,
} from '../utils/consent-first-pod';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import {
  lookupProvisionScopedWebIds,
  resolveProvisionScope,
} from '../utils/provision-scope';
import { resolveConsentStorageBindings } from './ConsentPage.utils';
import {
  xpodConsentErrors,
  xpodFirstPodCopy,
  xpodFirstPodErrors,
  xpodRegistrationCopy,
} from '../auth/xpod-account-copy';
import { readPendingXpodAccountEmail } from '../auth/xpod-remembered-login';

function safeStorageError(value: unknown, fallback: string): string {
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
    message.startsWith('Pod name is already taken.')
    || message === xpodRegistrationCopy.choosePodName
    || message === xpodRegistrationCopy.podNameTaken
  ) {
    return message;
  }
  return fallback;
}

type FirstPodStatus =
  | { status: 'checking' | 'creating' | 'waiting' }
  | { status: 'error'; message: string };

function markFirstPodStage(stage: string): void {
  if (import.meta.env.DEV) document.documentElement.dataset.xpodFirstPodStage = stage;
}

export function FirstPodPage() {
  const { controls, hasOidcPending, idpIndex, identity, refetchControls } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<FirstPodStatus>({ status: 'checking' });
  const [retryCount, setRetryCount] = useState(0);
  const pickWebIdUrl = hasOidcPending ? new URL('oidc/pick-webid/', idpIndex).href : undefined;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const oidcPendingStorage = pickWebIdUrl
          ? await loadPendingOidcStorageBindings(pickWebIdUrl)
          : undefined;
        if (cancelled) return;
        if (oidcPendingStorage?.bindings.length) {
          navigate('/.account/oidc/consent/', { replace: true });
          return;
        }

        markFirstPodStage('provision-status');
        const currentProvisionCode = await resolveProvisionCodeForCurrentScope(fetch);
        if (cancelled) return;

        const status = oidcPendingStorage
          ? { allWebIds: oidcPendingStorage.webIds, currentStorageWebIds: [] }
          : await loadCurrentStorageWebIds({
            accountBindingsUrl: controls?.account?.bindings,
            accountWebIdUrl: controls?.account?.webId,
            idpIndex,
            provisionCode: currentProvisionCode,
          });
        if (cancelled) return;
        if (!oidcPendingStorage && status.currentStorageWebIds.length > 0) {
          navigate('/.account/account/', { replace: true });
          return;
        }

        const podName = deriveFirstPodNameCandidate([
          controls?.account?.username,
          identity?.username,
          identity?.displayName,
          identity?.webId,
          ...status.allWebIds,
          readPendingXpodAccountEmail(undefined, idpIndex),
        ]) || controls?.account?.username;
        const createPodUrl = controls?.account?.pod;
        if (!podName) {
          throw new Error(xpodFirstPodErrors.accountIdentityMissing);
        }
        if (!createPodUrl) {
          throw new Error(xpodFirstPodErrors.createEndpointMissing);
        }

        setStatus({ status: 'creating' });
        markFirstPodStage('create-pod');
        const bindings = await createFirstPodAndWaitForBinding({
          createPodUrl,
          headers: storedAccountTokenHeaders(),
          pickWebIdUrl,
          provisionCode: currentProvisionCode,
          trustedAccountIndex: idpIndex,
          username: podName,
        });
        if (cancelled) return;
        if (hasOidcPending && bindings.length === 0) {
          setStatus({ status: 'waiting' });
          return;
        }
        await refetchControls();
        if (cancelled) return;
        navigate(hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/', { replace: true });
      } catch (err: unknown) {
        if (!cancelled) {
          if (import.meta.env.DEV) document.documentElement.dataset.xpodFirstPodError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          const message = safeStorageError(err, xpodFirstPodErrors.checkFailed);
          setStatus({ status: 'error', message });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [
    controls?.account?.bindings,
    controls?.account?.pod,
    controls?.account?.username,
    controls?.account?.webId,
    hasOidcPending,
    identity?.displayName,
    identity?.username,
    identity?.webId,
    idpIndex,
    navigate,
    pickWebIdUrl,
    refetchControls,
    retryCount,
  ]);

  return (
    <XpodAuthSurface mode="page" title={xpodFirstPodCopy.surfaceTitle}>
      <div className="flex min-h-0 flex-1 flex-col">
        {status.status === 'checking' ? (
          <LoginRestoringView label={xpodFirstPodCopy.restoring} />
        ) : status.status === 'creating' || status.status === 'waiting' ? (
          <LoginRestoringView label={status.status === 'creating' ? xpodFirstPodCopy.creating : xpodFirstPodCopy.waitingMessage} />
        ) : status.status === 'error' ? (
          <LoginFailureView
            title={xpodFirstPodCopy.unavailableTitle}
            description={status.message}
            primaryLabel={xpodFirstPodCopy.retryLabel}
            onPrimary={() => {
              setStatus({ status: 'checking' });
              setRetryCount((value) => value + 1);
            }}
          />
        ) : null}
      </div>
    </XpodAuthSurface>
  );
}

async function loadPendingOidcStorageBindings(pickWebIdUrl: string): Promise<{
  bindings: StorageBinding[];
  webIds: string[];
}> {
  markFirstPodStage('pick-webid');
  const response = await fetch(pickWebIdUrl, {
    headers: storedAccountTokenHeaders(),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(xpodConsentErrors.bindingsFailed);
  }

  const data = await response.json().catch(() => undefined) as {
    entries?: unknown;
    webIds?: unknown;
  } | undefined;
  if (!data || !Array.isArray(data.entries)) {
    throw new Error(xpodConsentErrors.bindingsFailed);
  }
  if (data.entries.length > 0) {
    for (const entry of data.entries) {
      if (resolveConsentStorageBindings([entry]).length !== 1) {
        throw new Error(xpodConsentErrors.bindingsFailed);
      }
    }
  }
  const webIds = Array.isArray(data.webIds)
    ? data.webIds.filter((webId): webId is string => typeof webId === 'string' && webId.length > 0)
    : [];
  return {
    bindings: resolveConsentStorageBindings(data.entries, webIds),
    webIds,
  };
}

async function loadCurrentStorageWebIds(options: {
  accountBindingsUrl?: string;
  accountWebIdUrl?: string;
  idpIndex: string;
  provisionCode?: string;
}): Promise<{ allWebIds: string[]; currentStorageWebIds: string[] }> {
  let entries: StorageBinding[] | undefined;
  if (options.accountBindingsUrl) {
    markFirstPodStage('account-bindings');
    entries = await fetchAccountStorageBindings({
      controls: { account: { bindings: options.accountBindingsUrl } },
      origin: window.location.origin,
      trustedAccountIndex: options.idpIndex,
    });
  }
  const accountWebIds = entries
    ? []
    : await fetchAccountWebIds(options.accountWebIdUrl, options.idpIndex);
  const allWebIds = Array.from(new Set([
    ...(entries?.map((entry: StorageBinding) => entry.webId) ?? []),
    ...accountWebIds,
  ]));
  const scope = resolveProvisionScope(options.provisionCode);
  if (!scope) {
    return { allWebIds, currentStorageWebIds: allWebIds };
  }
  // Account bindings are recorded in the IdP's own identifier space, so they
  // can never match the SP provision scope root. Whether a WebID already has
  // storage on this SP must be answered by the SP itself.
  markFirstPodStage('provision-webids');
  const provisionEntries = await lookupProvisionScopedWebIds(fetch, allWebIds, options.provisionCode);
  const currentStorageWebIds = Array.from(new Set((provisionEntries ?? []).map((entry) => entry.webId)));
  return { allWebIds, currentStorageWebIds };
}

async function fetchAccountWebIds(accountWebIdUrl: string | undefined, idpIndex: string): Promise<string[]> {
  const webIdUrl = await resolveHostedAccountControlUrl(accountWebIdUrl, fetch, idpIndex);
  if (!webIdUrl) return [];
  markFirstPodStage('account-webids');
  const response = await fetch(webIdUrl, {
    headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
    credentials: 'include',
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => undefined) as { webIdLinks?: unknown } | undefined;
  if (!body?.webIdLinks || typeof body.webIdLinks !== 'object' || Array.isArray(body.webIdLinks)) {
    return [];
  }
  return Object.keys(body.webIdLinks).filter((webId) => {
    try {
      const url = new URL(webId);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}
