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
  /** The client id behind the credential, for diagnostics and revocation. */
  clientId(): string | undefined;
  /** Drop and revoke the credential; safe to call when nothing was created. */
  release(): Promise<void>;
}

export interface CreateSessionRequestCredentialOptions {
  capability?: AiClientCredentialsCapability;
  webId?: string;
  /** Label shown in the account's own credential list. */
  name?: string;
}

export function createSessionRequestCredential(
  options: CreateSessionRequestCredentialOptions,
): SessionRequestCredential {
  const capability = options.capability;
  const webId = options.webId;
  const name = options.name?.trim() || 'Xpod 会话凭据';
  let created: { apiKey: string; clientId: string; resource: string } | undefined;
  let pending: Promise<typeof created> | undefined;
  let released = false;

  const create = async(): Promise<typeof created> => {
    if (!capability || !webId) {
      return undefined;
    }
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
      return credential ? `Bearer ${credential.apiKey}` : undefined;
    },

    clientId() {
      return created?.clientId;
    },

    async release() {
      released = true;
      const credential = created;
      created = undefined;
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
