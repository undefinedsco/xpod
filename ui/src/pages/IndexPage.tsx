import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { WelcomePage } from './WelcomePage';

export function IndexPage() {
  const { isLoggedIn, hasOidcPending } = useAuth();
  
  // If logged in and there's an OIDC flow waiting, go to consent
  if (isLoggedIn && hasOidcPending) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  
  // If logged in but no OIDC flow, go to dashboard
  if (isLoggedIn) {
    return <Navigate to="/.account/account/" replace />;
  }
  
  // Not logged in, show welcome/login page
  return <WelcomePage />;
}
