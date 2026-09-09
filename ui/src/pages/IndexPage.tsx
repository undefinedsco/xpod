import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContextValue';
import { WelcomePage } from './WelcomePage';

export function IndexPage() {
  const { isLoggedIn, hasOidcPending } = useAuth();
  
  // If logged in and there's an OIDC flow waiting, go to consent
  if (isLoggedIn && hasOidcPending) {
    return <Navigate to="/.account/oidc/consent/" replace />;
  }
  
  // Account authentication alone does not prove this Xpod has a storage
  // binding. The bootstrap route checks the current SP and immediately
  // forwards established users to the Account dashboard.
  if (isLoggedIn) {
    return <Navigate to="/.account/create-pod/" replace />;
  }
  
  // Not logged in, show welcome/login page
  return <WelcomePage />;
}
