import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { persistReturnTo } from '../utils/returnTo';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isLoggedIn, authenticating } = useAuth();
  const location = useLocation();
  
  if (authenticating) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  if (!isLoggedIn) {
    // Save current path so we can return after login
    persistReturnTo(location.pathname + location.search);
    return <Navigate to="/.account/login/password/" replace />;
  }
  return <>{children}</>;
}
