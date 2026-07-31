import { createContext, useContext } from 'react';

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

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
