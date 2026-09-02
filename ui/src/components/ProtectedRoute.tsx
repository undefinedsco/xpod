import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContextValue';
import { persistReturnTo } from '../utils/returnTo';
import { shouldRedirectToConsent } from './ProtectedRoute.utils';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowOidcPending?: boolean;
}

export function ProtectedRoute({ children, allowOidcPending = false }: ProtectedRouteProps) {
  const { controls, isLoggedIn, hasOidcPending } = useAuth();
  const location = useLocation();
  
  // If logged in and there's an OIDC flow waiting, redirect to consent
  if (shouldRedirectToConsent(isLoggedIn, hasOidcPending, allowOidcPending)) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  
  if (!isLoggedIn) {
    // Save current path so we can return after login
    persistReturnTo(location.pathname + location.search);
    const loginControl = controls?.html?.password?.login || controls?.password?.login || '/.account/login/password/';
    return <Navigate to={loginControl} replace />;
  }
  return <>{children}</>;
}
