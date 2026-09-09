import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContextValue';
import { resolveSameOriginAccountControlUrl } from '../utils/account-control-url';

/** CSS identity-provider entry. Not the product login controller. */
export function LoginSelectPage() {
  const { controls, isLoggedIn, hasOidcPending } = useAuth();

  if (isLoggedIn) {
    return <Navigate to={hasOidcPending ? '/.account/oidc/consent/' : '/.account/account/'} replace />;
  }

  const advertised = controls?.html?.password?.login || controls?.password?.login;
  const resolved = resolveSameOriginAccountControlUrl(advertised);
  const target = resolved ? new URL(resolved) : new URL('/.account/login/password/', window.location.origin);
  const destination = target.pathname === '/.account/login/'
    ? '/.account/login/password/'
    : `${target.pathname}${target.search}${target.hash}`;
  return <Navigate to={destination} replace />;
}
