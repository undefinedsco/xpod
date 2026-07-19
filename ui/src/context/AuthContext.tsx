import { useState, useEffect, createContext, useContext } from 'react';
import { storedAccountTokenHeaders, clearAccountSessionToken } from '../utils/account-session';

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
  authenticating: boolean;
  hasOidcPending: boolean;
  refetchControls: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function normalizeAccountControlUrl(value: string | undefined, currentOrigin: string | undefined): string | undefined {
  if (!value || !currentOrigin) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.pathname.startsWith('/.account/') && isLoopbackHost(url.hostname)) {
      return `${currentOrigin}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    return value;
  }

  return value;
}

export function normalizeAccountControls(controls: Controls, currentOrigin: string | undefined): Controls {
  return {
    password: controls.password && {
      login: normalizeAccountControlUrl(controls.password.login, currentOrigin),
      create: normalizeAccountControlUrl(controls.password.create, currentOrigin),
      forgot: normalizeAccountControlUrl(controls.password.forgot, currentOrigin),
      reset: normalizeAccountControlUrl(controls.password.reset, currentOrigin),
    },
    account: controls.account && {
      create: normalizeAccountControlUrl(controls.account.create, currentOrigin),
      logout: normalizeAccountControlUrl(controls.account.logout, currentOrigin),
      webId: normalizeAccountControlUrl(controls.account.webId, currentOrigin),
      pod: normalizeAccountControlUrl(controls.account.pod, currentOrigin),
      clientCredentials: normalizeAccountControlUrl(controls.account.clientCredentials, currentOrigin),
    },
    html: controls.html && {
      password: controls.html.password && {
        login: normalizeAccountControlUrl(controls.html.password.login, currentOrigin),
        register: normalizeAccountControlUrl(controls.html.password.register, currentOrigin),
        forgot: normalizeAccountControlUrl(controls.html.password.forgot, currentOrigin),
      },
      account: controls.html.account && {
        account: normalizeAccountControlUrl(controls.html.account.account, currentOrigin),
      },
    },
    oidc: controls.oidc && {
      webId: normalizeAccountControlUrl(controls.oidc.webId, currentOrigin),
      consent: normalizeAccountControlUrl(controls.oidc.consent, currentOrigin),
      cancel: normalizeAccountControlUrl(controls.oidc.cancel, currentOrigin),
    },
    main: controls.main && {
      logins: normalizeAccountControlUrl(controls.main.logins, currentOrigin),
      index: normalizeAccountControlUrl(controls.main.index, currentOrigin),
    },
  };
}

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
  const [hasOidcPending, setHasOidcPending] = useState(false);

  const isLoggedIn = Boolean(controls?.account?.logout);
  const authenticating = isInitializing;

  const checkOidcPending = async (): Promise<boolean> => {
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
  };

  const fetchControls = async () => {
    try {
      const res = await fetch(idpIndex, { headers: storedAccountTokenHeaders(), credentials: 'include' });
      if (res.ok) {
        const json = await res.json();
        
        // If user is logged in, check if there's an OIDC flow waiting BEFORE setting state
        // This ensures hasOidcPending is set before isLoggedIn becomes true
        let pending = false;
        if (json.controls?.account?.logout) {
          pending = await checkOidcPending();
        }
        
        // Set both states together to avoid race condition
        setHasOidcPending(pending);
        setControls(normalizeAccountControls(json.controls || {}, window.location.origin));
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
    <AuthContext.Provider value={{ controls, isInitializing, initError, idpIndex, isLoggedIn, authenticating, hasOidcPending, refetchControls }}>
      {children}
    </AuthContext.Provider>
  );
}
