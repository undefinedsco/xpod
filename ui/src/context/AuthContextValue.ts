import { createContext, useContext } from 'react';

export type AccountAuthMode = 'login' | 'register' | 'recovery' | 'reset'

export type AccountAuthState =
  | { status: 'initializing' }
  | { status: 'anonymous'; mode: AccountAuthMode }
  | { status: 'submitting'; mode: AccountAuthMode }
  | { status: 'authenticated' }
  | { status: 'error'; mode: AccountAuthMode; message: string }

export interface Controls {
  password?: { login?: string; create?: string; forgot?: string; reset?: string };
  account?: {
    id?: string;
    username?: string;
    displayName?: string;
    create?: string;
    logout?: string;
    webId?: string;
    pod?: string;
    bindings?: string;
    clientCredentials?: string;
  };
  html?: { password?: { login?: string; register?: string; forgot?: string }; account?: { account?: string } };
  oidc?: { webId?: string; consent?: string; cancel?: string };
  main?: { logins?: string; index?: string };
}

export interface SanitizedAccountIdentity {
  id?: string;
  username?: string;
  displayName?: string;
  webId?: string;
}

export interface AuthContextType {
  controls: Controls | null;
  isInitializing: boolean;
  initError: string | null;
  idpIndex: string;
  isLoggedIn: boolean;
  /** Read the latest Account auth state without relying on a stale render value. */
  isAnonymous?: () => boolean;
  authenticating: boolean;
  hasOidcPending: boolean;
  refetchControls: () => Promise<void>;
  retry: () => Promise<void>;
  logout: () => Promise<void>;
  accountState: AccountAuthState;
  identity?: SanitizedAccountIdentity;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
