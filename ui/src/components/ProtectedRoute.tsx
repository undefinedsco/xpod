import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { isLoggedIn, authenticating } = useAuth();
  
  if (authenticating) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  if (!isLoggedIn) {
    return <Navigate to="/.account/login/password/" replace />;
  }
  return <>{children}</>;
}
