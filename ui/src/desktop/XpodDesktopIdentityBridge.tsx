import { useEffect, useMemo } from 'react';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';

const MAX_LABEL_CODE_POINTS = 80;
const MAX_IDENTITY_URL_LENGTH = 2_048;

interface XpodDesktopIdentity {
  label: string;
  webId?: string;
  podUrl?: string;
}

export function XpodDesktopIdentityBridge() {
  const runtime = useXpodSolidRuntime();
  const profile = useXpodProfileCardIdentity({ runtime });
  const activeWebId = runtime.state.status === 'authenticated'
    ? runtime.webId ?? runtime.state.webId
    : undefined;
  const activePodUrl = runtime.state.status === 'authenticated'
    ? runtime.currentPod?.podUrl ?? runtime.podUrl ?? runtime.state.podUrl
    : undefined;
  const identity = useMemo(() => projectDesktopIdentity({
    isLoggedIn: runtime.state.status === 'authenticated',
    displayName: profile.displayName,
    username: profile.username,
    webId: activeWebId,
    podUrl: activePodUrl,
  }), [
    profile.displayName,
    profile.username,
    runtime.state.status,
    activePodUrl,
    activeWebId,
  ]);

  useEffect(() => {
    globalThis.xpodDesktop?.setIdentity(identity);
  }, [identity]);

  useEffect(() => () => {
    globalThis.xpodDesktop?.setIdentity(null);
  }, []);

  return null;
}

function projectDesktopIdentity({
  isLoggedIn,
  displayName,
  username,
  webId,
  podUrl,
}: {
  isLoggedIn: boolean;
  displayName?: string;
  username?: string;
  webId?: string;
  podUrl?: string;
}): XpodDesktopIdentity | null {
  if (!isLoggedIn) return null;

  const label = sanitizeLabel(displayName) ?? sanitizeLabel(username) ?? 'WebID';
  const sanitizedWebId = sanitizeCurrentXpodUrl(webId);
  const sanitizedPodUrl = sanitizeCurrentXpodUrl(podUrl);
  return {
    label,
    ...(sanitizedWebId ? { webId: sanitizedWebId } : {}),
    ...(sanitizedPodUrl ? { podUrl: sanitizedPodUrl } : {}),
  };
}

function sanitizeLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const visible = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return isUnsafeLabelCodePoint(codePoint) ? ' ' : character;
  }).join('');
  const compact = visible.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return Array.from(compact).slice(0, MAX_LABEL_CODE_POINTS).join('').trim();
}

function isUnsafeLabelCodePoint(codePoint: number): boolean {
  return codePoint < 0x20
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069);
}

function sanitizeCurrentXpodUrl(value: string | undefined): string | undefined {
  if (!value || value.length > MAX_IDENTITY_URL_LENGTH) return undefined;

  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
