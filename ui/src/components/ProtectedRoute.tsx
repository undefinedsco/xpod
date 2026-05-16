import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { persistReturnTo } from '../utils/returnTo';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowOidcPending?: boolean;
}

export function shouldRedirectToConsent(
  isLoggedIn: boolean,
  hasOidcPending: boolean,
  allowOidcPending: boolean = false,
): boolean {
  return isLoggedIn && hasOidcPending && !allowOidcPending;
}

export function ProtectedRoute({ children, allowOidcPending = false }: ProtectedRouteProps) {
  const { isLoggedIn, hasOidcPending } = useAuth();
  const location = useLocation();
  
  // If logged in and there's an OIDC flow waiting, redirect to consent
  if (shouldRedirectToConsent(isLoggedIn, hasOidcPending, allowOidcPending)) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  
  if (!isLoggedIn) {
    // Save current path so we can return after login
    persistReturnTo(location.pathname + location.search);
    return <Navigate to="/.account/login/password/" replace />;
  }
  return <>{children}</>;
}
