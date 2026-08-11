import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AuthSurface,
  Input,
  Label,
  LoginErrorBanner,
  LoginRestoringView,
  StorageBootstrapView,
  type StorageBootstrapState,
} from '@undefineds.co/shared-ui';
import type { StorageBinding } from '@undefineds.co/solid-sdk';
import { useAuth } from '../context/AuthContextValue';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { getStoredProvisionCode, resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';
import {
  createFirstPodAndWaitForBinding,
  createFirstPodAndWaitForWebIds,
  deriveFirstPodNameCandidate,
} from '../utils/consent-first-pod';
import { getRegistrationUsernameError, normalizeRegistrationUsername } from '../utils/registration';

function safeStorageError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : '';
  if (message.startsWith('Pod name is already taken.') || message === 'Choose a Pod name.') {
    return message;
  }
  return fallback;
}

export function FirstPodPage() {
  const { controls, hasOidcPending, refetchControls } = useAuth();
  const navigate = useNavigate();
  const [isChecking, setIsChecking] = useState(true);
  const [needsFirstPod, setNeedsFirstPod] = useState(false);
  const [podName, setPodName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [provisionCode, setProvisionCode] = useState<string | undefined>(() => getStoredProvisionCode());
  const [bootstrapState, setBootstrapState] = useState<StorageBootstrapState>('waiting');
  const [pending, setPending] = useState(false);
  const pickWebIdUrl = hasOidcPending ? '/.account/oidc/pick-webid/' : undefined;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const currentProvisionCode = await resolveProvisionCodeForCurrentScope(fetch, provisionCode);
        if (cancelled) return;
        setProvisionCode(currentProvisionCode);
        const status = await loadCurrentStorageWebIds({ accountBindingsUrl: controls?.account?.bindings });
        if (cancelled) return;
        setPodName((current) => current || deriveFirstPodNameCandidate(status.allWebIds) || controls?.account?.username || 'pod');
        if (status.currentStorageWebIds.length > 0) {
          navigate(hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/', { replace: true });
          return;
        }
        setNeedsFirstPod(true);
        setBootstrapState('creation');
      } catch (err: unknown) {
        if (!cancelled) {
          const message = safeStorageError(err, 'Storage state could not be checked. Please try again.');
          setError(message);
          setBootstrapState({ status: 'error', message });
          setNeedsFirstPod(true);
        }
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    })();

    return () => { cancelled = true; };
  }, [controls?.account?.bindings, controls?.account?.username, hasOidcPending, navigate, provisionCode]);

  const normalizedName = normalizeRegistrationUsername(podName);
  const podNameError = useMemo(() => normalizedName ? getRegistrationUsernameError(normalizedName) : 'Choose a Pod name.', [normalizedName]);
  const bootstrapHasError = typeof bootstrapState === 'object' && bootstrapState.status === 'error';

  const createStorage = async () => {
    if (pending) return;
    if (podNameError) {
      setError(podNameError);
      setBootstrapState({ status: 'error', message: podNameError });
      return;
    }
    const createPodUrl = controls?.account?.pod;
    if (!createPodUrl) {
      const message = 'Pod creation endpoint not found. Please reload and try again.';
      setError(message);
      setBootstrapState({ status: 'error', message });
      return;
    }

    try {
      setPending(true);
      setError(null);
      setBootstrapState('creating');
      if (hasOidcPending) {
        const bindings = await createFirstPodAndWaitForBinding({
          createPodUrl,
          headers: storedAccountTokenHeaders(),
          pickWebIdUrl,
          provisionCode,
          username: normalizedName,
        });
        if (bindings.length === 0) {
          setBootstrapState('waiting_for_binding');
          return;
        }
      } else {
        await createFirstPodAndWaitForWebIds({
          createPodUrl,
          headers: storedAccountTokenHeaders(),
          provisionCode,
          username: normalizedName,
        });
      }
      setBootstrapState('ready');
    } catch (err: unknown) {
      const message = safeStorageError(err, 'Storage could not be created. Please try again.');
      setError(message);
      setBootstrapState({ status: 'error', message });
    } finally {
      setPending(false);
    }
  };

  const continueStorage = async () => {
    await refetchControls();
    navigate(hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/', { replace: true });
  };

  return (
    <AuthSurface mode="page" title="Prepare storage">
      <div className="space-y-4 p-4">
        {error ? <LoginErrorBanner error={error} onDismiss={() => setError(null)} dismissLabel="Dismiss" /> : null}
        {isChecking ? (
          <LoginRestoringView label="Restoring storage…" />
        ) : needsFirstPod ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="first-pod-name">Pod name</Label>
              <Input
                id="first-pod-name"
                autoComplete="username"
                value={podName}
                disabled={pending}
                onChange={(event) => {
                  setPodName(normalizeRegistrationUsername(event.currentTarget.value));
                  setError(null);
                  setBootstrapState('creation');
                }}
                aria-invalid={podNameError ? true : undefined}
              />
              {podNameError ? <p role="alert" className="text-sm text-destructive">{podNameError}</p> : null}
            </div>
            <StorageBootstrapView
              state={bootstrapState}
              pending={pending}
              onCreate={createStorage}
              onContinue={bootstrapState === 'ready' ? continueStorage : undefined}
              onRetry={bootstrapHasError ? createStorage : undefined}
              copy={{
                title: 'Create your first storage',
                description: 'Set up this space before entering the dashboard.',
                creationMessage: 'No storage is linked to this Account yet.',
                waitingMessage: 'Waiting for the WebID/storage binding.',
                readyMessage: 'Storage is ready.',
                conflictMessage: 'The selected storage conflicts with this identity.',
                errorMessage: error || 'Storage could not be prepared.',
                createLabel: 'Create storage',
                continueLabel: 'Continue',
                retryLabel: 'Try again',
                cancelLabel: 'Cancel',
              }}
            />
          </>
        ) : null}
      </div>
    </AuthSurface>
  );
}

async function loadCurrentStorageWebIds(options: {
  accountBindingsUrl?: string;
}): Promise<{ allWebIds: string[]; currentStorageWebIds: string[] }> {
  if (!options.accountBindingsUrl) return { allWebIds: [], currentStorageWebIds: [] };
  const entries = await fetchAccountStorageBindings({
    controls: { account: { bindings: options.accountBindingsUrl } },
    origin: window.location.origin,
  });
  const allWebIds = Array.from(new Set(entries.map((entry: StorageBinding) => entry.webId)));
  return { allWebIds, currentStorageWebIds: allWebIds };
}
