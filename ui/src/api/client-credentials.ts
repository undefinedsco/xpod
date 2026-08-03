import type {
  AiClientCredentialManager,
  AiClientCredentialRecord,
  CreatedAiClientCredential,
} from '@undefineds.co/extension-sdk/web';
import { storedAccountTokenHeaders } from '../utils/account-session';

interface ClientCredentialsResponse {
  clientCredentials?: Record<string, string>;
}

interface CreatedClientCredentialResponse {
  id?: string;
  secret?: string;
  resourceUrl?: string;
  webId?: string;
}

export function encodeClientCredentialsApiKey(clientId: string, clientSecret: string): string {
  return `sk-${btoa(`${clientId}:${clientSecret}`)}`;
}

export function createAccountControlsClientCredentialManager(
  clientCredentialsUrl: string | undefined,
  currentWebId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): AiClientCredentialManager | undefined {
  if (!clientCredentialsUrl || !currentWebId) return undefined;
  const allowedResourceUrls = new Set<string>();
  return {
    available: true,
    accountUrl: '/.account/',
    async list() {
      const response = await fetchImpl(clientCredentialsUrl, {
        method: 'GET',
        headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to list Client Credentials');
      const payload = await response.json() as ClientCredentialsResponse;
      const records = normalizeClientCredentialRecords(payload.clientCredentials)
        .filter((record) => record.webId === currentWebId);
      for (const record of records) allowedResourceUrls.add(record.resourceUrl);
      return records;
    },
    async create(input) {
      if (input.webId !== currentWebId) throw new Error('Cannot create a Client Credential for another WebID');
      const response = await fetchImpl(clientCredentialsUrl, {
        method: 'POST',
        headers: storedAccountTokenHeaders({
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
        credentials: 'include',
        body: JSON.stringify({
          name: input.name,
          webId: input.webId,
        }),
      });
      if (!response.ok) throw new Error('Failed to create Client Credential');
      const payload = await response.json() as CreatedClientCredentialResponse;
      const created = normalizeCreatedClientCredential(payload, input.webId, clientCredentialsUrl);
      allowedResourceUrls.add(created.resourceUrl);
      return created;
    },
    async revoke(resourceUrl) {
      if (!allowedResourceUrls.has(resourceUrl)) {
        throw new Error('Cannot revoke a Client Credential outside the current WebID');
      }
      const response = await fetchImpl(resourceUrl, {
        method: 'DELETE',
        headers: storedAccountTokenHeaders({ Accept: 'application/json' }),
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to revoke Client Credential');
    },
  };
}

function normalizeClientCredentialRecords(value: unknown): AiClientCredentialRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([resourceUrl, webId]) => ({
    id: clientCredentialIdFromUrl(resourceUrl),
    resourceUrl,
    webId: typeof webId === 'string' ? webId : undefined,
  }));
}

function normalizeCreatedClientCredential(
  value: CreatedClientCredentialResponse,
  webId: string,
  clientCredentialsUrl: string,
): CreatedAiClientCredential {
  if (!value.id || !value.secret) {
    throw new Error('Client Credential response did not include the one-time secret');
  }
  const resourceUrl = value.resourceUrl ?? new URL(`${encodeURIComponent(value.id)}/`, clientCredentialsUrl).href;
  return {
    id: value.id,
    resourceUrl,
    webId: value.webId ?? webId,
    clientId: value.id,
    clientSecret: value.secret,
    apiKey: encodeClientCredentialsApiKey(value.id, value.secret),
  };
}

function clientCredentialIdFromUrl(resourceUrl: string): string {
  try {
    const segments = new URL(resourceUrl).pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? resourceUrl;
  } catch {
    return resourceUrl.split('/').filter(Boolean).pop() ?? resourceUrl;
  }
}
