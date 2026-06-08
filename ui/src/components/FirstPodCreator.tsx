import { useEffect, useState } from 'react';
import {
  checkFirstPodNameAvailability,
  createFirstPodAndWaitForWebIds,
  deriveFirstPodNameCandidate,
  waitForConsentWebIds,
  type FirstPodNameAvailabilityStatus,
} from '../utils/consent-first-pod';
import { getRegistrationUsernameError, normalizeRegistrationUsername } from '../utils/registration';

interface FirstPodCreatorProps {
  createPodUrl?: string;
  headers: Record<string, string>;
  onCreated: (webIds: string[]) => void | Promise<void>;
  onError: (message: string | null) => void;
  pickWebIdUrl?: string;
  provisionCode?: string;
  webIdCandidates?: Array<string | null | undefined>;
}

interface AvailabilityState {
  message?: string;
  status: FirstPodNameAvailabilityStatus | 'idle' | 'checking' | 'created';
}

export function FirstPodCreator({
  createPodUrl,
  headers,
  onCreated,
  onError,
  pickWebIdUrl,
  provisionCode,
  webIdCandidates = [],
}: FirstPodCreatorProps) {
  const [podName, setPodName] = useState(() => deriveFirstPodNameCandidate(webIdCandidates));
  const [isCreating, setIsCreating] = useState(false);
  const [createdPodName, setCreatedPodName] = useState<string | null>(null);
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'idle' });
  const normalizedName = normalizeRegistrationUsername(podName);
  const nameError = normalizedName ? getRegistrationUsernameError(normalizedName) : undefined;
  const isWaitingForWebId = Boolean(normalizedName && createdPodName === normalizedName);

  useEffect(() => {
    if (!normalizedName) {
      setAvailability({ status: 'idle' });
      return;
    }
    if (isWaitingForWebId) {
      setAvailability({
        status: 'created',
        message: 'Storage was created. Refresh authorization when the WebID is ready.',
      });
      return;
    }
    if (nameError) {
      setAvailability({ status: 'invalid', message: nameError });
      return;
    }

    let cancelled = false;
    setAvailability({ status: 'checking', message: 'Checking Pod name...' });
    const timeout = setTimeout(() => {
      void checkFirstPodNameAvailability({
        provisionCode,
        username: normalizedName,
      }).then((result) => {
        if (!cancelled) {
          setAvailability(result);
        }
      });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [isWaitingForWebId, nameError, normalizedName, provisionCode]);

  const refreshCreatedWebIds = async () => {
    try {
      onError(null);
      setIsCreating(true);
      const webIds = pickWebIdUrl
        ? await waitForConsentWebIds({
          headers,
          pickWebIdUrl,
        })
        : [];
      if (webIds.length > 0) {
        setCreatedPodName(null);
      }
      await onCreated(webIds);
    } catch (err: any) {
      onError(err.message || 'Failed to refresh authorization state');
    } finally {
      setIsCreating(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isWaitingForWebId) {
      await refreshCreatedWebIds();
      return;
    }
    if (nameError) {
      onError(nameError);
      return;
    }
    if (availability.status === 'taken') {
      onError(availability.message || 'This Pod name is already used on this storage.');
      return;
    }
    if (availability.status === 'checking') {
      onError('Please wait for the Pod name check to finish.');
      return;
    }
    if (!createPodUrl) {
      onError('Pod creation endpoint not found. Please reload and try again.');
      return;
    }

    try {
      onError(null);
      setIsCreating(true);
      const webIds = await createFirstPodAndWaitForWebIds({
        createPodUrl,
        headers,
        pickWebIdUrl,
        provisionCode,
        username: normalizedName,
      });
      setCreatedPodName(webIds.length > 0 ? null : normalizedName);
      setPodName(normalizedName);
      await onCreated(webIds);
    } catch (err: any) {
      onError(err.message || 'Failed to create Pod');
    } finally {
      setIsCreating(false);
    }
  };

  const availabilityTone = (() => {
    switch (availability.status) {
      case 'available':
        return 'text-emerald-600';
      case 'taken':
      case 'invalid':
        return 'text-red-600';
      case 'checking':
        return 'text-zinc-500';
      case 'created':
        return 'text-amber-600';
      default:
        return 'text-zinc-400';
    }
  })();
  const submitDisabled = isCreating ||
    availability.status === 'checking' ||
    (!isWaitingForWebId && availability.status === 'taken') ||
    Boolean(nameError);
  const submitLabel = isCreating
    ? isWaitingForWebId ? 'Refreshing...' : 'Creating...'
    : isWaitingForWebId ? 'Refresh authorization' : 'Create storage';

  return (
    <form onSubmit={handleSubmit} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-zinc-700">Create your first storage</p>
        <p className="text-[11px] text-zinc-500 mt-1">
          Choose a short Pod name. After it is created, this authorization will continue here.
        </p>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-zinc-500 mb-1">
          Pod name
        </label>
        <input
          type="text"
          value={podName}
          onChange={(event) => {
            setPodName(normalizeRegistrationUsername(event.target.value));
            onError(null);
          }}
          placeholder="alice"
          disabled={isCreating}
          className="w-full px-3 py-2 bg-white border border-zinc-200 rounded-lg text-sm text-zinc-700 focus:border-[#7C4DFF] focus:outline-none disabled:opacity-60"
          autoComplete="username"
          required
        />
        {availability.message && (
          <p className={`mt-1 text-[11px] ${availabilityTone}`}>
            {availability.message}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={submitDisabled}
        className="w-full py-2.5 bg-[#7C4DFF] hover:bg-[#6B3FE8] text-white rounded-xl text-xs font-medium disabled:opacity-50 transition-colors"
      >
        {submitLabel}
      </button>
    </form>
  );
}
