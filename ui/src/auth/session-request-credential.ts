import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web';

/**
 * The credential this browser session hands to the API for Pod-backed work.
 *
 * The API cannot spend the session's DPoP token - the private key never leaves this browser - so
 * a request that needs the Pod carries a client credential of its own instead. It is created for
 * the current WebID without any user step, kept in memory only, and revoked when the session
 * ends, so nothing usable is left on disk or in the API's own storage.
 */
export interface SessionRequestCredential {
  /** The `Authorization` value to send, creating the credential on first use. */
  authorization(): Promise<string | undefined>;
  /**
   * The `sk-` wrapper itself, for the one request that grants the task layer its own copy. It
   * never travels anywhere else.
   */
  apiKey(): Promise<string | undefined>;
  /** The client id behind the credential, for diagnostics and revocation. */
  clientId(): string | undefined;
  /** Drop and revoke the credential; safe to call when nothing was created. */
  release(): Promise<void>;
}

export interface CreateSessionRequestCredentialOptions {
  capability?: AiClientCredentialsCapability;
  resolveCapability?: () => Promise<AiClientCredentialsCapability | undefined>;
  webId?: string;
  /** Label shown in the account's own credential list. */
  name?: string;
}

export function createSessionRequestCredential(
  options: CreateSessionRequestCredentialOptions,
): SessionRequestCredential {
  let issuingCapability: AiClientCredentialsCapability | undefined;
  const webId = options.webId;
  const name = options.name?.trim() || 'Xpod 会话凭据';
  let created: { apiKey: string; clientId: string; resource: string } | undefined;
  let pending: Promise<typeof created> | undefined;
  let released = false;

  const create = async(): Promise<typeof created> => {
    if (!webId || released) {
      return undefined;
    }
    const capability = options.capability ?? await options.resolveCapability?.();
    if (!capability || released) return undefined;
    issuingCapability = capability;
    const result = await capability.create({ name, webId });
    if (released) {
      // The session ended while the credential was being created: do not keep or return it.
      await capability.revoke({
        clientId: clientIdFromApiKey(result.apiKey),
        resource: result.resource,
        webId,
      }).catch(() => undefined);
      return undefined;
    }
    created = {
      apiKey: result.apiKey,
      clientId: clientIdFromApiKey(result.apiKey),
      resource: result.resource,
    };
    return created;
  };

  const ensure = async(): Promise<typeof created> => {
    if (created) {
      return created;
    }
    pending ??= create().finally(() => {
      pending = undefined;
    });
    return await pending;
  };

  return {
    async authorization() {
      if (released) {
        return undefined;
      }
      const credential = await ensure();
      return !released && credential ? `Bearer ${credential.apiKey}` : undefined;
    },

    async apiKey() {
      if (released) {
        return undefined;
      }
      const credential = await ensure();
      return released ? undefined : credential?.apiKey;
    },

    clientId() {
      return created?.clientId;
    },

    async release() {
      released = true;
      const credential = created;
      created = undefined;
      const capability = issuingCapability;
      if (!credential || !capability || !webId) {
        return;
      }
      await capability.revoke({
        clientId: credential.clientId,
        resource: credential.resource,
        webId,
      });
    },
  };
}

/** `sk-` wrappers are base64(`client_id:client_secret`); only the id is ever read back. */
function clientIdFromApiKey(apiKey: string): string {
  const base64 = apiKey.startsWith('sk-') ? apiKey.slice(3) : apiKey;
  try {
    const decoded = atob(base64);
    const separator = decoded.indexOf(':');
    return separator > 0 ? decoded.slice(0, separator) : '';
  } catch {
    return '';
  }
}

/**
 * Turn "the API could not open the Pod" into "here is the credential for this session".
 *
 * The server decides which calls need a Pod credential: it answers 403
 * `service_access_missing` when the caller's own context has none. That is the moment to prepare
 * the session credential and retry a read once. Mutations are never replayed, which keeps this wrapper out of the business of knowing
 * which routes read a Pod - and keeps Pod traffic, capability calls and other origins untouched.
 *
 * The retry deliberately does not reuse the session transport: a session transport exists to
 * attach the session's own token and overwrites any Authorization header it finds, which would
 * replace the credential with exactly the token the server just said it cannot use.
 */
export function withRequestPodAuthorization(
  fetchImpl: typeof fetch,
  authorization: (() => Promise<string | undefined>) | undefined,
  retryFetch: typeof fetch = fetchImpl,
  gatewayOrigin?: string,
  resolveGatewayUrl?: (url: string) => string,
): typeof fetch {
  if (!authorization) {
    return fetchImpl;
  }
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await fetchImpl(input, init);
    if (!['GET', 'HEAD'].includes(method) || !needsPodAuthorization(input, gatewayOrigin, resolveGatewayUrl) || response.status !== 403 || !await isMissingPodAccess(response)) {
      return response;
    }
    const value = await authorization().catch(() => undefined);
    if (!value) {
      return response;
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('authorization', value);
    headers.delete('dpop');
    return retryFetch(input, { ...init, headers });
  };
}

async function isMissingPodAccess(response: Response): Promise<boolean> {
  try {
    const body = await response.clone().json() as { error?: unknown };
    return body?.error === 'service_access_missing'
      || Boolean(body?.error && typeof body.error === 'object'
        && 'code' in body.error && body.error.code === 'service_access_missing');
  } catch {
    return false;
  }
}

/** Credentials may only be replayed to this Gateway's API, never to Pod resources or other hosts. */
export function needsPodAuthorization(input: RequestInfo | URL, gatewayOrigin?: string, resolveGatewayUrl?: (url: string) => string): boolean {
  if (!gatewayOrigin) return false;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), gatewayOrigin);
    if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)
      || !(url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/'))) return false;
    const origin = new URL(gatewayOrigin).origin;
    if (url.origin === origin) return true;
    if (!resolveGatewayUrl) return false;
    const mapped = new URL(resolveGatewayUrl(url.href));
    return mapped.origin === origin && !mapped.username && !mapped.password
      && mapped.pathname === url.pathname && mapped.search === url.search && mapped.hash === url.hash;
  } catch {
    return false;
  }
}
