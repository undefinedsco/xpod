import { useCallback, useEffect, useState } from 'react';
import { storedAccountTokenHeaders, clearAccountSessionToken } from '../utils/account-session';
import { AuthContext, type Controls } from './AuthContextValue';

interface ControlsResponse {
  controls?: Controls;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Pure SPA mode: No server-side injection.
  // We assume the IDP index is always at '/.account/' relative to the domain root.
  const idpIndex = '/.account/';
  
  const [controls, setControls] = useState<Controls | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);
  const [hasOidcPending, setHasOidcPending] = useState(false);

  const isLoggedIn = Boolean(controls?.account?.logout);
  const authenticating = isInitializing;

  const checkOidcPending = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/.account/oidc/consent/', {
        headers: storedAccountTokenHeaders(),
        credentials: 'include',
      });
      // If we get 200 and valid client info, there's an OIDC flow waiting
      if (res.ok) {
        const data = await res.json();
        return Boolean(data.client);
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const fetchControls = useCallback(async () => {
    try {
      const res = await fetch(idpIndex, { headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        const json = await res.json().catch(() => ({})) as ControlsResponse;
        
        // If user is logged in, check if there's an OIDC flow waiting BEFORE setting state
        // This ensures hasOidcPending is set before isLoggedIn becomes true
        let pending = false;
        if (json.controls?.account?.logout) {
          pending = await checkOidcPending();
        }
        
        // Set both states together to avoid race condition
        setHasOidcPending(pending);
        setControls(json.controls || {});
      } else {
        if (res.status === 401 || res.status === 403) {
          clearAccountSessionToken();
          setHasOidcPending(false);
          setControls({});
          return;
        }
        // If we get a 404 or other error, it might mean we are not at the right place
        // or the server is down. For now, we set an error.
        setInitError(`Failed to load configuration (Status: ${res.status})`);
      }
    } catch {
      setInitError('Network error: Could not connect to authentication server');
    }
  }, [checkOidcPending, idpIndex]);

  useEffect(() => {
    (async () => {
      await fetchControls();
      setIsInitializing(false);
    })();
  }, [fetchControls]);

  const refetchControls = useCallback(async () => {
    await fetchControls();
  }, [fetchControls]);

  return (
    <AuthContext.Provider value={{ controls, isInitializing, initError, idpIndex, isLoggedIn, authenticating, hasOidcPending, refetchControls }}>
      {children}
    </AuthContext.Provider>
  );
}
