// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createXpodAiClientCredentialsCapability } from './XpodAiClientCredentials'

const ACCOUNT_BASE_URL = 'https://pod.example'
const WEB_ID = 'https://pod.example/alice/profile/card#me'
const CREDENTIALS_URL = 'https://pod.example/.account/client-credentials/'

describe('createXpodAiClientCredentialsCapability', () => {
  beforeEach(() => {
    document.cookie = 'css-account=account-token'
  })

  it('lists and creates CSS credentials using the account controls endpoint', async () => {
    const calls: Array<{ url: string; method: string; body?: string; authorization: string | null }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      if (url === 'https://pod.example/.account/') {
        return new Response(JSON.stringify({
          controls: { account: { clientCredentials: CREDENTIALS_URL } },
          clientCredentials: {
            'client-1': `${CREDENTIALS_URL}client-1/`,
          },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url === CREDENTIALS_URL && init?.method === 'POST') {
        return new Response(JSON.stringify({
          id: 'client-2',
          secret: 'secret-2',
          resource: `${CREDENTIALS_URL}opaque-resource-2/`,
        }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }) as typeof fetch

    const capability = createXpodAiClientCredentialsCapability({
      accountBaseUrl: ACCOUNT_BASE_URL,
      webId: WEB_ID,
      fetch: fetcher,
    })

    await expect(capability.list()).resolves.toEqual([{
      id: 'client-1',
      resourceUrl: `${CREDENTIALS_URL}client-1/`,
      owner: WEB_ID,
    }])
    await expect(capability.create({ name: 'Codex', webId: WEB_ID })).resolves.toEqual({
      plaintext: 'sk-Y2xpZW50LTI6c2VjcmV0LTI=',
      record: {
        id: 'client-2',
        resourceUrl: `${CREDENTIALS_URL}opaque-resource-2/`,
        owner: WEB_ID,
        name: 'Codex',
      },
    })
    expect(calls).toEqual([
      {
        url: 'https://pod.example/.account/',
        method: 'GET',
        authorization: 'CSS-Account-Token account-token',
      },
      {
        url: CREDENTIALS_URL,
        method: 'POST',
        body: JSON.stringify({ name: 'Codex', webId: WEB_ID }),
        authorization: 'CSS-Account-Token account-token',
      },
    ])
  })

  it('revokes by the resource URL returned by CSS instead of guessing an opaque key path', async () => {
    const resourceUrl = `${CREDENTIALS_URL}client-1/`
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://pod.example/.account/') {
        return new Response(JSON.stringify({
          controls: { account: { clientCredentials: CREDENTIALS_URL } },
          clientCredentials: { 'client-1': resourceUrl },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url === resourceUrl && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`)
    }) as typeof fetch
    const capability = createXpodAiClientCredentialsCapability({
      accountBaseUrl: ACCOUNT_BASE_URL,
      webId: WEB_ID,
      fetch: fetcher,
    })

    await capability.list()
    await expect(capability.revoke('client-1')).resolves.toMatchObject({
      id: 'client-1',
      resourceUrl,
      owner: WEB_ID,
    })
    expect(fetcher).toHaveBeenLastCalledWith(resourceUrl, expect.objectContaining({
      method: 'DELETE',
    }))
  })

  it('falls back to the controls client-credentials collection when account controls omit the listing', async () => {
    const resourceUrl = `${CREDENTIALS_URL}client-3/`
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://pod.example/.account/') {
        return new Response(JSON.stringify({
          controls: { account: { clientCredentials: CREDENTIALS_URL } },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url === CREDENTIALS_URL) {
        return new Response(JSON.stringify({ clientCredentials: { 'client-3': resourceUrl } }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
    const capability = createXpodAiClientCredentialsCapability({
      accountBaseUrl: ACCOUNT_BASE_URL,
      webId: WEB_ID,
      fetch: fetcher,
    })

    await expect(capability.list()).resolves.toEqual([{
      id: 'client-3',
      resourceUrl,
      owner: WEB_ID,
    }])
  })

  it('uses the issuer/account origin when Pod storage lives on another host', async () => {
    const issuerOrigin = 'https://id.example'
    const resourceUrl = `${issuerOrigin}/.account/client-4/`
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `${issuerOrigin}/.account/`) {
        return new Response(JSON.stringify({
          controls: { account: { clientCredentials: `${issuerOrigin}/.account/client-credentials/` } },
          clientCredentials: { 'client-4': resourceUrl },
        }), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected request to ${url}`)
    }) as typeof fetch

    const capability = createXpodAiClientCredentialsCapability({
      accountBaseUrl: issuerOrigin,
      webId: WEB_ID,
      fetch: fetcher,
    })

    await capability.list()
    expect(fetcher).toHaveBeenCalledWith(`${issuerOrigin}/.account/`, expect.anything())
  })

  it('maps every credential returned by the authenticated CSS account collection', async () => {
    const current = `${ACCOUNT_BASE_URL}/.account/client-current/`
    const linked = `${ACCOUNT_BASE_URL}/.account/client-linked/`
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      clientCredentials: {
        'client-current': current,
        'client-linked': linked,
      },
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
    const capability = createXpodAiClientCredentialsCapability({
      accountBaseUrl: ACCOUNT_BASE_URL,
      webId: WEB_ID,
      fetch: fetcher,
    })

    await expect(capability.list()).resolves.toEqual([
      { id: 'client-current', resourceUrl: current, owner: WEB_ID },
      { id: 'client-linked', resourceUrl: linked, owner: WEB_ID },
    ])
  })
})
