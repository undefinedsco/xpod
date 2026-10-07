import { accountOverviewHref } from '../utils/account-overview-href';
import { useEffect } from 'react';
import { useAuth } from '../context/AuthContextValue';
import { useXpodProfileCardIdentity } from '../profile/useXpodProfileCardIdentity';
import { useXpodSolidRuntime } from '../solid/useXpodSolidRuntime';
import {
  readPendingXpodAccountEmail,
  readRememberedXpodLogin,
  rememberedXpodLoginMatchesActive,
  rememberXpodLogin,
  readXpodAccountRememberChoice,
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
  const rememberAccount = readXpodAccountRememberChoice(account.idpIndex);
  const accountHref = !account.isInitializing ? accountOverviewHref(account.idpIndex) : undefined;
  const issuer = accountHref ? new URL(accountHref).origin : undefined;
  const pendingEmail = issuer ? readPendingXpodAccountEmail(undefined, account.idpIndex) : undefined;
  // An independent WebID login has no evidence for an Account email on another origin.
  const email = rememberAccount === true
    ? pendingEmail ?? (remembered && remembered.issuer === issuer ? remembered.account.email : undefined)
    : undefined;

  useEffect(() => {
    if (!issuer || rememberAccount === false) return;
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
      issuer,
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
    issuer,
    rememberAccount,
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
