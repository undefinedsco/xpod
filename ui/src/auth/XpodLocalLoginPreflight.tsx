import { useContext, useEffect, useRef } from 'react';
import { LoginRestoringView } from '@undefineds.co/shared-ui';
import { AuthContext } from '../context/AuthContextValue';
import { FirstPodPage } from '../pages/FirstPodPage';
import { isManagedLocalProvisionHost } from '../utils/pod';

/** Prepare known Local storage without moving anonymous authentication out of OIDC. */
export function XpodLocalLoginPreflight({ onReady }: { onReady: () => void }) {
  const account = useContext(AuthContext);
  const continued = useRef(false);
  const checking = account?.isInitializing === true;
  const prepareStorage = isManagedLocalProvisionHost() && account?.isLoggedIn === true;
  // A cross-origin Account API token does not establish the IdP's browser
  // session. Anonymous users must register/sign in inside the original OIDC
  // interaction so registration can continue straight to consent.
  useEffect(() => {
    if (!checking && !prepareStorage && !continued.current) {
      continued.current = true;
      onReady();
    }
  }, [checking, prepareStorage, onReady]);

  if (checking || !prepareStorage) return <LoginRestoringView label="正在准备登录…" />;
  return <FirstPodPage onReady={onReady} />;
}
