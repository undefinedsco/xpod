import type {
  AiClientCredentialRecord,
  AiClientCredentialsCapability,
  CreatedAiClientCredential,
} from '@undefineds.co/extension-sdk/web'
import { storedAccountTokenHeaders } from '../utils/account-session'

interface CreateXpodAiClientCredentialsCapabilityInput {
  accountBaseUrl?: string
  webId: string
  fetch?: typeof fetch
}

interface AccountControlsResponse {
  controls?: {
    account?: {
      clientCredentials?: string
    }
  }
  clientCredentials?: Record<string, unknown>
}

interface CreatedCredentialResponse {
  id?: unknown
  secret?: unknown
  resource?: unknown
}

/**
 * Adapt the CSS account client-credentials endpoint into an Applet host
 * capability. Account credentials are deliberately kept separate from the
 * Solid DPoP session: CSS account endpoints accept the short-lived account
 * token that the shared account/login UI already stores.
 */
export function createXpodAiClientCredentialsCapability({
  accountBaseUrl,
  webId,
  fetch: fetchImpl = globalThis.fetch,
}: CreateXpodAiClientCredentialsCapabilityInput): AiClientCredentialsCapability {
  const resolvedAccountBaseUrl = accountBaseUrl
    ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
  if (!resolvedAccountBaseUrl) {
    throw new Error('CSS account issuer is unavailable')
  }
  const accountUrl = new URL('/.account/', resolvedAccountBaseUrl).toString()
  let credentialsUrl: string | undefined
  const knownCredentials = new Map<string, AiClientCredentialRecord>()

  const request = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = storedAccountTokenHeaders({
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...Object.fromEntries(new Headers(init.headers).entries()),
    })
    return fetchImpl(input, {
      ...init,
      credentials: 'include',
      headers,
    })
  }

  const readAccount = async (): Promise<AccountControlsResponse> => {
    const response = await request(accountUrl)
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error('Unable to access the CSS account client credentials')
    }
    return payload as AccountControlsResponse
  }

  const resolveCredentialsUrl = async (): Promise<string> => {
    if (credentialsUrl) return credentialsUrl
    const payload = await readAccount()
    const configured = payload.controls?.account?.clientCredentials
    credentialsUrl = configured
      ? new URL(configured, accountUrl).toString()
      : new URL('client-credentials/', accountUrl).toString()
    return credentialsUrl
  }

  const list = async (): Promise<AiClientCredentialRecord[]> => {
    const payload = await readAccount()
    const configured = payload.controls?.account?.clientCredentials
    credentialsUrl = configured
      ? new URL(configured, accountUrl).toString()
      : credentialsUrl ?? new URL('client-credentials/', accountUrl).toString()
    const credentialPayload = payload.clientCredentials
      ? payload
      : await readCredentialsCollection(credentialsUrl)
    knownCredentials.clear()
    // CSS returns { [clientLabel]: resourceUrl }. The collection is scoped by
    // the authenticated account; it does not repeat each credential's WebID.
    for (const [clientId, value] of Object.entries(credentialPayload.clientCredentials ?? {})) {
      if (typeof value !== 'string' || !value) continue
      const record = {
        id: clientId,
        resourceUrl: new URL(value, accountUrl).toString(),
        owner: webId,
      }
      knownCredentials.set(record.id, record)
    }
    return [...knownCredentials.values()]
  }

  const create = async (input: { name?: string; webId: string }): Promise<CreatedAiClientCredential> => {
    if (input.webId !== webId) {
      throw new Error('CSS client credentials must belong to the current WebID')
    }
    const endpoint = await resolveCredentialsUrl()
    const response = await request(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        ...(input.name ? { name: input.name } : {}),
        webId,
      }),
    })
    const payload = await readJson(response) as CreatedCredentialResponse
    if (!response.ok || typeof payload.id !== 'string' || !payload.id ||
      typeof payload.secret !== 'string' || !payload.secret) {
      throw new Error('CSS account did not return a client credential')
    }
    const record: AiClientCredentialRecord = {
      id: payload.id,
      resourceUrl: typeof payload.resource === 'string' && payload.resource
        ? new URL(payload.resource, accountUrl).toString()
        : new URL(`${encodeURIComponent(payload.id)}/`, endpoint).toString(),
      owner: webId,
      ...(input.name ? { name: input.name } : {}),
    }
    knownCredentials.set(record.id, record)
    return {
      plaintext: encodeClientCredentialsApiKey(payload.id, payload.secret),
      record,
    }
  }

  const revoke = async (credentialId: string): Promise<AiClientCredentialRecord | undefined> => {
    let record = knownCredentials.get(credentialId)
    if (!record) {
      record = (await list()).find((candidate) => candidate.id === credentialId)
    }
    if (!record) return undefined
    const response = await request(record.resourceUrl, { method: 'DELETE' })
    await readJson(response)
    if (!response.ok) {
      throw new Error('Unable to revoke the CSS client credential')
    }
    knownCredentials.delete(credentialId)
    return {
      ...record,
      revokedAt: new Date().toISOString(),
    }
  }

  async function readCredentialsCollection(endpoint: string): Promise<AccountControlsResponse> {
    const response = await request(endpoint)
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error('Unable to list the CSS account client credentials')
    }
    return payload as AccountControlsResponse
  }

  return { list, create, revoke }
}

export function encodeClientCredentialsApiKey(clientId: string, clientSecret: string): string {
  const encoded = globalThis.btoa(`${clientId}:${clientSecret}`)
  return `sk-${encoded}`
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.arrayBuffer().catch(() => undefined)
    return {}
  }
  return response.json().catch(() => ({}))
}
