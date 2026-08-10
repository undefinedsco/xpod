import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HardDrive, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContextValue';
import { CardWrapper } from '../components/CardWrapper';
import { FirstPodCreator } from '../components/FirstPodCreator';
import { storedAccountTokenHeaders } from '../utils/account-session';
import { messageFromError } from '../utils/errors';
import { getStoredProvisionCode, resolveProvisionCodeForCurrentScope } from '../utils/pod';
import { fetchAccountStorageBindings } from '../auth/account-storage-bindings';

export function FirstPodPage() {
  const { controls, hasOidcPending, refetchControls } = useAuth();
  const navigate = useNavigate();
  const [isChecking, setIsChecking] = useState(true);
  const [needsFirstPod, setNeedsFirstPod] = useState(false);
  const [webIdCandidates, setWebIdCandidates] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [provisionCode, setProvisionCode] = useState<string | undefined>(() => getStoredProvisionCode());
  const pickWebIdUrl = hasOidcPending ? '/.account/oidc/pick-webid/' : undefined;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const currentProvisionCode = await resolveProvisionCodeForCurrentScope(fetch, provisionCode);
        if (cancelled) {
          return;
        }
        setProvisionCode(currentProvisionCode);
        const status = await loadCurrentStorageWebIds({
          accountBindingsUrl: controls?.account?.bindings,
        });
        if (cancelled) {
          return;
        }
        setWebIdCandidates(status.allWebIds);
        if (status.currentStorageWebIds.length > 0) {
          navigate(hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/', { replace: true });
          return;
        }
        setNeedsFirstPod(true);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(messageFromError(err, 'Failed to check storage state'));
          setNeedsFirstPod(true);
        }
      } finally {
        if (!cancelled) {
          setIsChecking(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [controls?.account?.bindings, hasOidcPending, navigate, provisionCode]);

  return (
    <CardWrapper
      title="Create storage"
      subtitle="Set up this space before entering the dashboard"
      icon={HardDrive}
    >
      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-red-600 text-[11px]">
          <AlertCircle className="w-4 h-4 inline mr-2" />{error}
        </div>
      )}

      {isChecking && (
        <div className="flex justify-center py-6">
          <Loader2 className="w-6 h-6 animate-spin text-[#7C4DFF]" />
        </div>
      )}

      {!isChecking && needsFirstPod && (
        <FirstPodCreator
          createPodUrl={controls?.account?.pod}
          headers={storedAccountTokenHeaders()}
          onCreated={async (webIds) => {
            if (hasOidcPending && webIds.length === 0) {
              setError('Storage was created. Click Refresh authorization when the WebID is ready.');
              return;
            }
            await refetchControls();
            navigate(hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/', { replace: true });
          }}
          onBindingCreated={async (bindings) => {
            if (hasOidcPending && bindings.length === 0) {
              setError('Storage was created. Click Refresh authorization when the WebID is ready.');
              return;
            }
            await refetchControls();
            navigate(hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/', { replace: true });
          }}
          onError={setError}
          pickWebIdUrl={pickWebIdUrl}
          provisionCode={provisionCode}
          webIdCandidates={webIdCandidates}
        />
      )}
    </CardWrapper>
  );
}

async function loadCurrentStorageWebIds(options: {
  accountBindingsUrl?: string;
}): Promise<{ allWebIds: string[]; currentStorageWebIds: string[] }> {
  if (!options.accountBindingsUrl) {
    return { allWebIds: [], currentStorageWebIds: [] };
  }
  const entries = await fetchAccountStorageBindings({
    controls: { account: { bindings: options.accountBindingsUrl } },
    origin: window.location.origin,
  });
  const allWebIds = Array.from(new Set(entries.map((entry) => entry.webId)));
  return {
    allWebIds,
    currentStorageWebIds: allWebIds,
  };
}
