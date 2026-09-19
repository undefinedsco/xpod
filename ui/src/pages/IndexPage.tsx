import { scopeAccountUrl } from '../utils/account-interaction-url';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContextValue';
import { WelcomePage } from './WelcomePage';

export function IndexPage() {
  const { isLoggedIn, hasOidcPending } = useAuth();
  
  // If logged in and there's an OIDC flow waiting, go to consent
  if (isLoggedIn && hasOidcPending) {
    return <Navigate to={scopeAccountUrl("/.account/oidc/consent/")} replace />;
  }
  
  // Account authentication alone does not prove this Xpod has a storage
  // binding — and it must not be required to have one. Land on Account
  // management; Pod creation is an explicit action there (设计第二部 §4.1 / U03).
  if (isLoggedIn) {
    return <Navigate to={scopeAccountUrl("/.account/account/")} replace />;
  }
  
  // Not logged in, show welcome/login page
  return <WelcomePage />;
}
