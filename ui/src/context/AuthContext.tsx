import { useState, useEffect, createContext, useContext } from 'react';

export interface Controls {
  password?: { login?: string; create?: string; forgot?: string; reset?: string };
  account?: { create?: string; logout?: string; webId?: string; pod?: string; clientCredentials?: string };
  html?: { password?: { login?: string; register?: string; forgot?: string }; account?: { account?: string } };
  oidc?: { webId?: string; consent?: string; cancel?: string };
  main?: { logins?: string; index?: string };
}

export interface AuthContextType {
  controls: Controls | null;
  isInitializing: boolean;
  initError: string | null;
  idpIndex: string;
  isLoggedIn: boolean;
  refetchControls: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Pure SPA mode: No server-side injection.
  // We assume the IDP index is always at '/.account/' relative to the domain root.
  const idpIndex = '/.account/';
  
  const [controls, setControls] = useState<Controls | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  const isLoggedIn = Boolean(controls?.account?.logout);

  const fetchControls = async () => {
    try {
      const res = await fetch(idpIndex, { headers: { Accept: 'application/json' }, credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        setControls(json.controls || {});
      } else {
        // If we get a 404 or other error, it might mean we are not at the right place
        // or the server is down. For now, we set an error.
        setInitError(`Failed to load configuration (Status: ${res.status})`);
      }
    } catch (e) {
      setInitError('Network error: Could not connect to authentication server');
    }
  };

  useEffect(() => {
    (async () => {
      await fetchControls();
      setIsInitializing(false);
    })();
  }, [idpIndex]);

  const refetchControls = async () => {
    await fetchControls();
  };

  return (
    <AuthContext.Provider value={{ controls, isInitializing, initError, idpIndex, isLoggedIn, refetchControls }}>
      {children}
    </AuthContext.Provider>
  );
}
