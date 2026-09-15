import { scopeAccountUrl } from '../utils/account-interaction-url';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { XpodAccountPageSurface } from '../auth/XpodAuthSurface';
import { WebAccountFailureView, WebAccountRestoringView } from '../auth/WebAccountViews';
import { useAuth } from '../context/AuthContextValue';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { resolveCurrentProvisionTarget, resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { waitForCurrentAccountStorageBindings } from '../auth/local-storage-readiness';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import {
  createFirstPodAndWaitForBinding,
  deriveFirstPodNameCandidate,
} from '../utils/consent-first-pod';
import { resolveHostedAccountControlUrl } from '../utils/account-control-url';
import {
  lookupProvisionScopedWebIds,
  resolveProvisionScope,
  storageUrlBelongsToRoot,
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
    || message === xpodFirstPodErrors.cloudRouteUnavailable
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

export function FirstPodPage({ onReady }: { onReady?: () => void } = {}) {
  const { controls, hasOidcPending, idpIndex, identity, refetchControls } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<FirstPodStatus>({ status: 'checking' });
  const [retryCount, setRetryCount] = useState(0);
  const pickWebIdUrl = !onReady && hasOidcPending ? new URL('oidc/pick-webid/', idpIndex).href : undefined;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const oidcPendingStorage = pickWebIdUrl
          ? await loadPendingOidcStorageBindings(pickWebIdUrl)
          : undefined;
        if (cancelled) return;
        if (oidcPendingStorage?.bindings.length) {
          navigate(scopeAccountUrl('/.account/oidc/consent/'), { replace: true });
          return;
        }

        markFirstPodStage('provision-context');
        const provisionTarget = await resolveCurrentProvisionTarget();
        if (cancelled) return;

        const status = oidcPendingStorage
          ? { allWebIds: oidcPendingStorage.webIds, currentStorageWebIds: [], currentBindings: [], durable: false }
          : await loadCurrentStorageWebIds({
            accountBindingsUrl: controls?.account?.bindings,
            accountWebIdUrl: controls?.account?.webId,
            idpIndex,
            provisionCode: provisionTarget.activeProvisionCode,
            provisionStorageRoot: provisionTarget.storageRoot,
          });
        if (cancelled) return;
        if (!oidcPendingStorage && status.currentStorageWebIds.length > 0 && (!onReady || status.durable)) {
          if (onReady) {
            if (!provisionTarget.storageRoot) throw new Error(xpodFirstPodErrors.cloudRouteUnavailable);
            await waitForCurrentAccountStorageBindings({
              controls: { account: { bindings: controls?.account?.bindings } },
            trustedAccountIndex: idpIndex, storageRoot: provisionTarget.storageRoot,
            });
            if (!cancelled) onReady();
          } else navigate(scopeAccountUrl('/.account/account/'), { replace: true });
          return;
        }
        if (provisionTarget.storageRoot && !provisionTarget.activeProvisionCode) {
          throw new Error(xpodFirstPodErrors.cloudRouteUnavailable);
        }

        const currentProvisionCode = await resolveProvisionCodeForCurrentScope(provisionTarget.activeProvisionCode);
        if (cancelled) return;

        // A previous Local prepare may have succeeded before Account commit
        // failed. Retry the same scoped Pod's receipt instead of allocating a
        // new name or waiting forever for a commit that never happened.
        const existingLocalName = onReady && status.currentBindings.length > 0
          ? existingScopedPodName(status.currentBindings, provisionTarget.storageRoot)
          : undefined;
        const podName = existingLocalName ?? (deriveFirstPodNameCandidate([
          controls?.account?.username,
          identity?.username,
          identity?.displayName,
          identity?.webId,
          ...status.allWebIds,
          readPendingXpodAccountEmail(undefined, idpIndex),
        ]) || controls?.account?.username);
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
        if (!onReady && hasOidcPending && bindings.length === 0) {
          setStatus({ status: 'waiting' });
          return;
        }
        if (onReady) {
          if (!provisionTarget.storageRoot) throw new Error(xpodFirstPodErrors.cloudRouteUnavailable);
          setStatus({ status: 'waiting' });
          await waitForCurrentAccountStorageBindings({
            controls: { account: { bindings: controls?.account?.bindings } },
            trustedAccountIndex: idpIndex, storageRoot: provisionTarget.storageRoot,
          });
          if (!cancelled) onReady();
          return;
        }
        await refetchControls();
        if (cancelled) return;
        navigate(hasOidcPending ? scopeAccountUrl('/.account/oidc/consent/') : scopeAccountUrl('/.account/account/'), { replace: true });
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
    onReady,
    pickWebIdUrl,
    refetchControls,
    retryCount,
  ]);

  return (
    <XpodAccountPageSurface title={xpodFirstPodCopy.surfaceTitle}>
      <div className="flex min-h-0 flex-1 flex-col">
        {status.status === 'checking' ? (
          <WebAccountRestoringView label={xpodFirstPodCopy.restoring} />
        ) : status.status === 'creating' || status.status === 'waiting' ? (
          <WebAccountRestoringView label={status.status === 'creating' ? xpodFirstPodCopy.creating : xpodFirstPodCopy.waitingMessage} />
        ) : status.status === 'error' ? (
          <WebAccountFailureView
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
    </XpodAccountPageSurface>
  );
}

async function loadPendingOidcStorageBindings(pickWebIdUrl: string): Promise<{
  bindings: StorageBinding[];
  webIds: string[];
}> {
  markFirstPodStage('pick-webid');
  const response = await fetch(scopeAccountUrl(pickWebIdUrl), {
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
  provisionStorageRoot?: string;
}): Promise<{ allWebIds: string[]; currentStorageWebIds: string[]; currentBindings: StorageBinding[]; durable: boolean }> {
  let entries: StorageBinding[] | undefined;
  if (options.accountBindingsUrl) {
    markFirstPodStage('account-bindings');
    entries = await fetchAccountStorageBindings({
      controls: { account: { bindings: options.accountBindingsUrl } },
      origin: window.location.origin,
      trustedAccountIndex: options.idpIndex,
    });
  }
  const exactDurableWebIds = options.provisionStorageRoot && entries && entries.length > 0
    ? entries
      .filter((entry) => storageUrlBelongsToRoot(entry.storageUrl, options.provisionStorageRoot))
      .map((entry) => entry.webId)
    : [];
  if (exactDurableWebIds.length > 0) {
    return {
      allWebIds: Array.from(new Set(entries!.map((entry) => entry.webId))),
      currentStorageWebIds: Array.from(new Set(exactDurableWebIds)),
      currentBindings: entries!.filter((entry) => storageUrlBelongsToRoot(entry.storageUrl, options.provisionStorageRoot)),
      durable: true,
    };
  }
  const accountWebIds = entries && entries.length > 0
    ? []
    : await fetchAccountWebIds(options.accountWebIdUrl, options.idpIndex);
  const allWebIds = Array.from(new Set([
    ...(entries?.map((entry: StorageBinding) => entry.webId) ?? []),
    ...accountWebIds,
  ]));
  if (options.provisionStorageRoot && !options.provisionCode) {
    return { allWebIds, currentStorageWebIds: [], currentBindings: [], durable: false };
  }
  const scope = resolveProvisionScope(options.provisionCode);
  if (!scope) {
    return { allWebIds, currentStorageWebIds: allWebIds, currentBindings: entries ?? [], durable: Boolean(entries?.length) };
  }
  // A non-empty bindings response is already exact. An empty bindings response
  // only means no durable pair was recorded by this Account control, so read
  // native Account WebIDs as candidates and let the SP-scoped lookup decide
  // whether storage already exists for the active Local provision scope.
  markFirstPodStage('provision-webids');
  const provisionEntries = await lookupProvisionScopedWebIds(fetch, allWebIds, options.provisionCode);
  const currentStorageWebIds = Array.from(new Set((provisionEntries ?? []).map((entry) => entry.webId)));
  return { allWebIds, currentStorageWebIds, currentBindings: provisionEntries ?? [], durable: false };
}

async function fetchAccountWebIds(accountWebIdUrl: string | undefined, idpIndex: string): Promise<string[]> {
  const webIdUrl = await resolveHostedAccountControlUrl(accountWebIdUrl, fetch, idpIndex);
  if (!webIdUrl) {
    throw new Error(xpodFirstPodErrors.checkFailed);
  }
  markFirstPodStage('account-webids');
  const response = await fetch(scopeAccountUrl(webIdUrl), {
    headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
    credentials: 'include',
  }).catch(() => undefined);
  if (!response?.ok) {
    throw new Error(xpodFirstPodErrors.checkFailed);
  }
  const body = await response.json().catch(() => undefined) as { webIdLinks?: unknown } | undefined;
  if (!body?.webIdLinks || typeof body.webIdLinks !== 'object' || Array.isArray(body.webIdLinks)) {
    throw new Error(xpodFirstPodErrors.checkFailed);
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

function existingScopedPodName(bindings: StorageBinding[], storageRoot?: string): string {
  const storageUrls = [...new Set(bindings.map((binding) => binding.storageUrl))];
  if (!storageRoot || storageUrls.length !== 1) throw new Error(xpodFirstPodErrors.checkFailed);
  const storageUrl = storageUrls[0]!;
  if (!storageUrlBelongsToRoot(storageUrl, storageRoot)) throw new Error(xpodFirstPodErrors.checkFailed);
  const rootPath = new URL(storageRoot).pathname.replace(/\/?$/u, '/');
  const segments = new URL(storageUrl).pathname.slice(rootPath.length).split('/').filter(Boolean);
  if (segments.length !== 1) throw new Error(xpodFirstPodErrors.checkFailed);
  return decodeURIComponent(segments[0]!);
}
