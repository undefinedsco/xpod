import { useEffect } from 'react';
import { useAuth } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';
import {
  readPendingXpodAccountEmail,
  readRememberedXpodLogin,
  rememberedXpodLoginMatchesActive,
  rememberXpodLogin,
} from './xpod-remembered-login';
import { XPOD_LOGIN_ROUTE_ID } from './xpod-login-route';

/** Remembers presentation data for a ready WebID/Pod, never session secrets. */
export function XpodRememberedLoginBridge() {
  const account = useAuth();
  const runtime = useXpodSolidRuntime();
  const selectedStorage = runtime.selectedStorage;
  const profile = useXpodProfileCardIdentity({
    accountIdentity: account.identity,
    runtime,
  });
  const webId = runtime.state.status === 'authenticated'
    ? runtime.webId ?? runtime.state.webId
    : undefined;
  const remembered = readRememberedXpodLogin();
  const pendingEmail = readPendingXpodAccountEmail();
  const email = pendingEmail ?? remembered?.account.email;

  useEffect(() => {
    if (!webId || !selectedStorage || !runtime.currentPod) return;
    if (selectedStorage.webId !== webId) return;
    if (runtime.currentPod.webId !== webId || runtime.currentPod.podUrl !== selectedStorage.storageUrl) return;
    if (remembered && !rememberedXpodLoginMatchesActive(remembered, {
      accountIdentity: account.identity,
      accountEmail: pendingEmail,
      webId,
      selectedStorage,
    })) return;
    rememberXpodLogin({
      account: {
        ...(email ? { email } : {}),
        ...(account.identity ?? {}),
        displayName: profile.displayName,
        ...(profile.username ? { username: profile.username } : {}),
        ...(profile.avatarSourceUrl ?? remembered?.account.avatarUrl
          ? { avatarUrl: profile.avatarSourceUrl ?? remembered?.account.avatarUrl }
          : {}),
      },
      webId,
      storageBinding: selectedStorage,
      routeId: XPOD_LOGIN_ROUTE_ID,
    });
  }, [
    account.identity,
    email,
    pendingEmail,
    profile.displayName,
    profile.avatarSourceUrl,
    profile.username,
    remembered,
    runtime.currentPod,
    selectedStorage,
    webId,
  ]);

  return null;
}
