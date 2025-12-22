import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { WelcomePage } from './WelcomePage';

export function IndexPage() {
  const { isLoggedIn, authenticating } = useAuth();
  
  if (authenticating) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }
  return <WelcomePage />;
}
