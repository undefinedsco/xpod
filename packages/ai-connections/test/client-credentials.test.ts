import { describe, expect, it, vi } from 'vitest'
import type { AiClientCredentialsCapability } from '@undefineds.co/extension-sdk/web'
import {
  withAiClientCredentialsGatewayKeys,
  type AiConnectionsClient,
} from '../src/ai-connections-client'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

function baseClient(): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: async () => ({ status: 'missing' }),
    listProviders: async () => [],
    listModels: async () => [],
    listGatewayKeys: async () => [],
    createGatewayKey: async () => {
      throw new Error('unexpected opaque key creation')
    },
    revokeGatewayKey: async () => {
      throw new Error('unexpected opaque key revocation')
    },
    beginConnect: async () => {
      throw new Error('not used')
    },
    connectStatus: async () => {
      throw new Error('not used')
    },
    completeApiKey: async () => {
      throw new Error('not used')
    },
    pollDevice: async () => {
      throw new Error('not used')
    },
    disconnect: async () => undefined,
    createApiKeyCredential: async () => {
      throw new Error('not used')
    },
    updateProviderCredential: async () => {
      throw new Error('not used')
    },
    deleteProviderCredential: async () => undefined,
    testProviderCredential: async () => ({}),
    quota: async () => {
      throw new Error('not used')
    },
    discoverModels: async () => {
      throw new Error('not used')
    },
    saveProviderModel: async () => [],
    deleteProviderModel: async () => [],
  }
}

describe('withAiClientCredentialsGatewayKeys', () => {
  it('projects CSS client credentials as sk-base64 Gateway key methods', async () => {
    const capability: AiClientCredentialsCapability = {
      list: vi.fn(async () => [{
        id: 'client-1',
        resourceUrl: 'https://pod.example/.account/client-credentials/client-1/',
        owner: WEB_ID,
        name: 'Codex',
        createdAt: '2026-08-09T00:00:00.000Z',
      }]),
      create: vi.fn(async (input) => ({
        plaintext: 'sk-Y2xpZW50LTE6c2VjcmV0',
        record: {
          id: 'client-2',
          resourceUrl: 'https://pod.example/.account/client-credentials/client-2/',
          owner: input.webId,
          name: input.name,
        },
      })),
      revoke: vi.fn(async (credentialId) => ({
        id: credentialId,
        resourceUrl: `https://pod.example/.account/client-credentials/${credentialId}/`,
        owner: WEB_ID,
        revokedAt: '2026-08-09T00:01:00.000Z',
      })),
    }
    const client = withAiClientCredentialsGatewayKeys(baseClient(), capability)

    await expect(client.listGatewayKeys()).resolves.toEqual([{
      id: 'client-1',
      owner: WEB_ID,
      scopes: [],
      createdAt: '2026-08-09T00:00:00.000Z',
      name: 'Codex',
    }])

    const created = await client.createGatewayKey({ name: 'New Codex' })
    expect(capability.create).toHaveBeenCalledWith({ name: 'New Codex', webId: WEB_ID })
    expect(created.plaintext).toBe('sk-Y2xpZW50LTE6c2VjcmV0')
    expect(created.record).toMatchObject({
      id: 'client-2',
      owner: WEB_ID,
      scopes: [],
      name: 'New Codex',
    })

    await expect(client.revokeGatewayKey('client-2')).resolves.toMatchObject({
      id: 'client-2',
      revokedAt: '2026-08-09T00:01:00.000Z',
    })
    expect(capability.revoke).toHaveBeenCalledWith('client-2')
  })

  it('does not silently ignore unsupported CSS scopes or expiry', async () => {
    const capability: AiClientCredentialsCapability = {
      list: async () => [],
      create: vi.fn(async () => {
        throw new Error('should not create')
      }),
      revoke: async () => undefined,
    }
    const client = withAiClientCredentialsGatewayKeys(baseClient(), capability)

    await expect(client.createGatewayKey({ scopes: ['models:read'] })).rejects.toThrow(
      'CSS client credentials do not support scopes or expiry',
    )
    await expect(client.createGatewayKey({ expiresAt: '2099-01-01T00:00:00.000Z' })).rejects.toThrow(
      'CSS client credentials do not support scopes or expiry',
    )
    expect(capability.create).not.toHaveBeenCalled()
  })
})
