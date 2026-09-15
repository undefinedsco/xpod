import { scopeAccountUrl } from '../utils/account-interaction-url';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContextValue';
import { resolveSameOriginAccountControlUrl } from '../utils/account-control-url';

/** CSS identity-provider entry. Not the product login controller. */
export function LoginSelectPage() {
  const { controls, isLoggedIn, hasOidcPending } = useAuth();

  if (isLoggedIn) {
    return <Navigate to={hasOidcPending ? scopeAccountUrl('/.account/oidc/consent/') : scopeAccountUrl('/.account/account/')} replace />;
  }

  const advertised = controls?.html?.password?.login || controls?.password?.login;
  const resolved = resolveSameOriginAccountControlUrl(advertised);
  const target = resolved ? new URL(resolved) : new URL(scopeAccountUrl('/.account/login/password/'), window.location.origin);
  const destination = target.pathname === scopeAccountUrl('/.account/login/')
    ? scopeAccountUrl('/.account/login/password/')
    : `${target.pathname}${target.search}${target.hash}`;
  return <Navigate to={scopeAccountUrl(destination)} replace />;
}
