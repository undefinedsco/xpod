import {
  EVENTS,
  getSessionFromStorage,
  refreshSession,
  type SessionTokenSet,
} from '@inrupt/solid-client-authn-node';
import {
  getOAuthCredentials,
  saveCredentials,
  type OidcOAuthSecrets,
  type StoredCredentials,
} from './credentials-store';
import { createOidcSessionStorage } from './oidc-session-storage';

const TOKEN_EXPIRY_SKEW_MS = 60_000;

export async function getOidcAccessToken(
  credentials: StoredCredentials,
  options: { forceRefresh?: boolean } = {},
): Promise<string | null> {
  const secrets = getOAuthCredentials(credentials);
  if (!secrets) return null;

  if (!options.forceRefresh && isUsableAccessToken(secrets)) {
    return secrets.oidcAccessToken;
  }

  return refreshStoredOidcSession(credentials, secrets);
}

function isUsableAccessToken(secrets: OidcOAuthSecrets): boolean {
  if (!secrets.oidcAccessToken) return false;
  const expiresAt = new Date(secrets.oidcExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
}

async function refreshStoredOidcSession(
  credentials: StoredCredentials,
  secrets: OidcOAuthSecrets,
): Promise<string | null> {
  const storage = createOidcSessionStorage();
  const sessionId = await resolveStoredOidcSessionId(storage, credentials.webId, credentials.url);
  if (!sessionId) return null;

  const session = await getSessionFromStorage(sessionId, {
    storage,
    refreshSession: false,
  });
  if (!session) return null;

  let refreshedTokenSet: SessionTokenSet | null = null;
  session.events.on(EVENTS.NEW_TOKENS, (tokenSet) => {
    refreshedTokenSet = tokenSet;
  });

  await refreshSession(session, { storage });

  const nextTokenSet = refreshedTokenSet as SessionTokenSet | null;
  if (!nextTokenSet?.accessToken) return null;

  secrets.oidcRefreshToken = nextTokenSet.refreshToken ?? secrets.oidcRefreshToken;
  secrets.oidcAccessToken = nextTokenSet.accessToken;
  secrets.oidcExpiresAt = nextTokenSet.expiresAt
    ? new Date(nextTokenSet.expiresAt * 1000).toISOString()
    : secrets.oidcExpiresAt;
  secrets.oidcClientId = nextTokenSet.clientId ?? secrets.oidcClientId;

  saveCredentials({
    url: credentials.url,
    webId: session.info.webId ?? credentials.webId,
    authType: 'oidc_oauth',
    secrets,
  });

  return nextTokenSet.accessToken;
}

async function resolveStoredOidcSessionId(
  storage: ReturnType<typeof createOidcSessionStorage>,
  webId: string,
  issuerUrl: string,
): Promise<string | null> {
  const raw = await storage.get('solidClientAuthn:registeredSessions');
  if (!raw) return null;

  let sessionIds: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      sessionIds = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    return null;
  }

  const normalizedIssuer = issuerUrl.replace(/\/+$/u, '');
  for (const sessionId of [...sessionIds].reverse()) {
    const stored = await storage.get(`solidClientAuthenticationUser:${sessionId}`);
    if (!stored) continue;

    try {
      const parsed = JSON.parse(stored) as { webId?: string; issuer?: string; dpop?: string | boolean };
      const sessionWebId = typeof parsed.webId === 'string' ? parsed.webId : null;
      const sessionIssuer = typeof parsed.issuer === 'string' ? parsed.issuer.replace(/\/+$/u, '') : null;
      const sessionUsesDpop = parsed.dpop === true || parsed.dpop === 'true';
      if (sessionWebId === webId && sessionIssuer === normalizedIssuer && !sessionUsesDpop) {
        return sessionId;
      }
    } catch {
      continue;
    }
  }

  return null;
}
