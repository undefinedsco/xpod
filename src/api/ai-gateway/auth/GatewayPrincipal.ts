import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';

export function isInternalInvocationPrincipal(auth: AuthContext | undefined): auth is SolidAuthContext & {
  viaApiKey: true;
  internalInvocation: true;
  scopes: string[];
} {
  return auth?.type === 'solid' && auth.viaApiKey === true && auth.internalInvocation === true;
}
