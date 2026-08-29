import { useEffect } from 'react';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { useXpodAuth } from './useXpodAuth';
import {
  readPendingXpodAccountEmail,
  readRememberedXpodLogin,
  rememberedXpodLoginMatchesActive,
  rememberXpodLogin,
} from './xpod-remembered-login';
import { XPOD_LOGIN_ROUTE_ID } from './xpod-login-route';

/** Remembers presentation data for a ready WebID/Pod, never session secrets. */
export function XpodRememberedLoginBridge() {
  const { account, runtime, readiness, selectedStorage } = useXpodAuth();
  const profile = useXpodProfileCardIdentity({
    accountIdentity: account.identity,
    runtime,
  });
  const webId = runtime?.state.status === 'authenticated'
    ? runtime.webId ?? runtime.state.webId
    : undefined;
  const remembered = readRememberedXpodLogin();
  const pendingEmail = readPendingXpodAccountEmail();
  const email = pendingEmail ?? remembered?.account.email;

  useEffect(() => {
    if (!readiness.podSettings || !webId || !selectedStorage) return;
    if (selectedStorage.webId !== webId) return;
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
    readiness.podSettings,
    remembered,
    selectedStorage,
    webId,
  ]);

  return null;
}
