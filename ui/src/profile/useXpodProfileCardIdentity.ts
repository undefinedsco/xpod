import { resolveSolidProfileIdentityFromWebIdDocument } from '@undefineds.co/models/profile';
import { useEffect, useMemo, useState } from 'react';
import type { SanitizedAccountIdentity } from '../context/AuthContextValue';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';

export interface XpodProfileCardIdentity {
  readonly displayName: string;
  readonly username?: string;
  readonly avatarUrl?: string;
  /** Stable profile URL suitable for remembering across desktop restarts. */
  readonly avatarSourceUrl?: string;
  readonly note?: string;
  readonly region?: string;
  readonly webId?: string;
  readonly loading: boolean;
  readonly source: 'account' | 'webid-profile';
}

export function useXpodProfileCardIdentity({
  accountIdentity,
  runtime,
}: {
  accountIdentity?: SanitizedAccountIdentity;
  runtime?: XpodSolidRuntimeValue | null;
}): XpodProfileCardIdentity {
  const runtimeStatus = runtime?.state.status;
  const webId = runtimeStatus === 'authenticated' && runtime
    ? runtime.webId ?? runtime.state.webId
    : accountIdentity?.webId;
  const accountDisplayName = accountIdentity?.displayName;
  const accountUsername = accountIdentity?.username;
  const accountId = accountIdentity?.id;
  const accountWebId = accountIdentity?.webId;
  const authenticatedFetch = runtime?.fetch;
  const fallback = useMemo(() => accountProfileFallback({
    displayName: accountDisplayName,
    username: accountUsername,
    id: accountId,
    webId: accountWebId,
  }, webId), [accountDisplayName, accountId, accountUsername, accountWebId, webId]);
  const identityKey = `${webId ?? ''}\u0000${fallback.displayName}\u0000${fallback.username ?? ''}`;
  const [profileIdentity, setProfileIdentity] = useState<{ key: string; value: XpodProfileCardIdentity }>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchImpl = authenticatedFetch;
    if (runtimeStatus !== 'authenticated' || !fetchImpl || !webId) {
      return;
    }

    let cancelled = false;
    let objectUrl: string | undefined;

    async function loadProfileIdentity(profileFetch: typeof fetch, profileWebId: string) {
      setLoading(true);
      try {
        const resolved = await resolveSolidProfileIdentityFromWebIdDocument({
          info: { webId: profileWebId },
          fetch: profileFetch,
        });
        if (cancelled || !resolved) return;

        const avatar = normalizedHttpUrl(resolved.profile?.avatar);
        let avatarUrl = avatar;
        if (avatar) {
          avatarUrl = await resolveAuthenticatedAvatarUrl(profileFetch, avatar);
          objectUrl = avatarUrl?.startsWith('blob:') ? avatarUrl : undefined;
        }
        if (cancelled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }

        setProfileIdentity({
          key: identityKey,
          value: {
            displayName: resolved.displayName ?? resolved.username ?? fallback.displayName,
            username: resolved.username || fallback.username,
            avatarUrl: avatarUrl ?? fallback.avatarUrl,
            avatarSourceUrl: avatar,
            note: resolved.profile?.note || fallback.note,
            region: resolved.profile?.region || fallback.region,
            webId: resolved.webId || fallback.webId,
            loading: false,
            source: 'webid-profile',
          },
        });
      } catch {
        if (!cancelled) setProfileIdentity(undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadProfileIdentity(fetchImpl, webId);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [authenticatedFetch, fallback, identityKey, runtimeStatus, webId]);

  const effectiveLoading = runtimeStatus === 'authenticated' ? loading : false;
  return runtimeStatus === 'authenticated' && profileIdentity?.key === identityKey
    ? { ...profileIdentity.value, loading: effectiveLoading }
    : { ...fallback, loading: effectiveLoading };
}

function accountProfileFallback(identity: SanitizedAccountIdentity | undefined, webId: string | undefined): XpodProfileCardIdentity {
  const username = identity?.username || usernameFromWebId(webId) || identity?.id;
  return {
    displayName: identity?.displayName || username || identity?.id || 'Xpod account',
    username,
    webId,
    loading: false,
    source: 'account',
  };
}

async function resolveAuthenticatedAvatarUrl(fetchImpl: typeof fetch, avatarUrl: string): Promise<string | undefined> {
  try {
    const response = await fetchImpl(avatarUrl);
    if (!response.ok) return avatarUrl;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch {
    return avatarUrl;
  }
}

function normalizedHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function usernameFromWebId(webId: string | undefined): string | undefined {
  if (!webId) return undefined;
  try {
    const url = new URL(webId);
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.at(0) || url.hostname;
  } catch {
    return undefined;
  }
}
