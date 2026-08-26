import { Session } from '@inrupt/solid-client-authn-node';
import type { SolidAuthContext } from './AuthContext';

export interface SolidSessionLike {
  login(options: {
    clientId: string;
    clientSecret: string;
    oidcIssuer: string;
    tokenType?: 'Bearer' | 'DPoP';
  }): Promise<void>;
  fetch: typeof fetch;
  info: {
    isLoggedIn?: boolean;
    webId?: string;
  };
}

export type SolidSessionFactory = () => SolidSessionLike;

export function createSolidSession(): SolidSessionLike {
  return new Session() as SolidSessionLike;
}

export function deriveOidcIssuerFromEndpoint(endpoint: string): string {
  try {
    return new URL('/', endpoint).toString();
  } catch {
    return endpoint;
  }
}

export function deriveOidcIssuerFromWebId(webId: string): string {
  try {
    return new URL('/', webId).toString();
  } catch {
    return webId;
  }
}

export async function loginWithClientCredentials(
  auth: SolidAuthContext & { clientId: string; clientSecret: string },
  options: {
    sessionFactory?: SolidSessionFactory;
    oidcIssuer?: string;
  } = {},
): Promise<SolidSessionLike> {
  const session = (options.sessionFactory ?? createSolidSession)();
  await session.login({
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    oidcIssuer: options.oidcIssuer ?? auth.oidcIssuer ?? deriveOidcIssuerFromWebId(auth.webId),
    tokenType: 'Bearer',
  });
  if (!session.info.isLoggedIn) {
    throw new Error('Client credentials Solid session login failed');
  }
  return session;
}
