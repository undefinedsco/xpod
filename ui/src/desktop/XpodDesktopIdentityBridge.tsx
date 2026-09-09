import { useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContextValue';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';

const MAX_LABEL_CODE_POINTS = 80;
const MAX_IDENTITY_URL_LENGTH = 2_048;

interface XpodDesktopIdentity {
  label: string;
  webId?: string;
  podUrl?: string;
}

export function XpodDesktopIdentityBridge() {
  const account = useAuth();
  const runtime = useXpodSolidRuntime();
  const activeWebId = runtime.state.status === 'authenticated'
    ? runtime.webId ?? runtime.state.webId
    : undefined;
  const activePodUrl = runtime.state.status === 'authenticated'
    ? runtime.currentPod?.podUrl ?? runtime.podUrl ?? runtime.state.podUrl
    : undefined;
  const identity = useMemo(() => projectDesktopIdentity({
    isLoggedIn: account.isLoggedIn,
    displayName: account.identity?.displayName,
    username: account.identity?.username,
    webId: activeWebId,
    podUrl: activePodUrl,
  }), [
    account.identity?.displayName,
    account.identity?.username,
    account.isLoggedIn,
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

  const label = sanitizeLabel(displayName) ?? sanitizeLabel(username) ?? 'Xpod Account';
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
    if (!isCurrentXpodOrigin(url)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function isCurrentXpodOrigin(url: URL): boolean {
  const current = globalThis.window?.location;
  if (!current) return false;
  if (url.origin === current.origin) return true;
  return url.protocol === current.protocol
    && url.port === current.port
    && isLoopbackHostname(url.hostname)
    && isLoopbackHostname(current.hostname);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
