import { describe, expect, it } from 'vitest'
import { parseAiConnectionsServiceAccess } from '../src/service-access'

const CURRENT_POD_URL = 'https://pod.example/alice/'

function descriptor(patch: Record<string, unknown> = {}) {
  return {
    appletId: 'co.undefineds.ai-connections',
    service: {
      webId: 'https://id.example/xpod/profile/card#me',
      label: 'Xpod AI Connection',
    },
    resources: [{
      id: 'providerCredentials',
      url: 'https://pod.example/alice/settings/credentials.ttl',
      mediaType: 'text/turtle',
      access: { read: true, append: true, write: true },
    }],
    ...patch,
  }
}

describe('parseAiConnectionsServiceAccess', () => {
  it('accepts the expected applet and exact current-Pod resources', () => {
    expect(parseAiConnectionsServiceAccess(descriptor(), CURRENT_POD_URL))
      .toMatchObject({
        appletId: 'co.undefineds.ai-connections',
        service: {
          webId: 'https://id.example/xpod/profile/card#me',
          label: 'Xpod AI Connection',
        },
        resources: [{
          id: 'providerCredentials',
          url: 'https://pod.example/alice/settings/credentials.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        }],
      })
  })

  it('accepts the complete backend descriptor including gateway access keys', () => {
    expect(parseAiConnectionsServiceAccess(descriptor({
      resources: [
        {
          id: 'providerCredentials',
          url: 'https://pod.example/alice/settings/credentials.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        },
        {
          id: 'providerDefinitions',
          url: 'https://pod.example/alice/settings/providers/__service_access__.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        },
        {
          id: 'gatewayAccessKeys',
          url: 'https://pod.example/alice/.data/ai/gateway/access-keys.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        },
        {
          id: 'quotaSnapshots',
          url: 'https://pod.example/alice/.data/ai/gateway/quota.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        },
      ],
    }), CURRENT_POD_URL).resources.map((resource) => resource.id)).toEqual([
      'providerCredentials',
      'providerDefinitions',
      'gatewayAccessKeys',
      'quotaSnapshots',
    ])
  })

  it('accepts provider-specific documents advertised by the service descriptor', () => {
    expect(parseAiConnectionsServiceAccess(descriptor({
      resources: [{
        id: 'providerDocument:openai-api-platform',
        url: 'https://pod.example/alice/settings/providers/openai-api-platform.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }), CURRENT_POD_URL).resources).toEqual([{
      id: 'providerDocument:openai-api-platform',
      url: 'https://pod.example/alice/settings/providers/openai-api-platform.ttl',
      mediaType: 'text/turtle',
      access: { read: true, append: true, write: true },
    }])
  })

  it.each(['zhipu', 'custom'])('accepts the %s provider document used by the provider pool', (provider) => {
    expect(parseAiConnectionsServiceAccess(descriptor({
      resources: [{
        id: `providerDocument:${provider}`,
        url: `https://pod.example/alice/settings/providers/${provider}.ttl`,
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }), CURRENT_POD_URL).resources[0]?.id).toBe(`providerDocument:${provider}`)
  })

  it.each([
    ['wrong applet', { appletId: 'evil.applet' }],
    ['non-http service WebID', { service: { webId: 'urn:xpod:service', label: 'Xpod AI Connection' } }],
    ['foreign resource', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://evil.example/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['known resource wrong document', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/providers/openai.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['prefix-confused resource', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice-evil/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['malformed percent escape', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/%',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['encoded slash', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings%2fcredentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['encoded backslash', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings%5ccredentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['decoded dot segment', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/./credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['decoded dot-dot segment', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/../credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['decoded backslash', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings\\credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['control access', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true, controlWrite: true },
      }],
    }],
    ['string access flag', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: 'true', append: true, write: true },
      }],
    }],
    ['incomplete access', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true },
      }],
    }],
    ['unknown resource id', {
      resources: [{
        id: 'unknownResource',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['unknown provider document id', {
      resources: [{
        id: 'providerDocument:unknown',
        url: 'https://pod.example/alice/settings/providers/unknown.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['provider document wrong document', {
      resources: [{
        id: 'providerDocument:openai-api-platform',
        url: 'https://pod.example/alice/settings/providers/openai.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['provider container secret document', {
      resources: [{
        id: 'providerDocument:openai-api-platform',
        url: 'https://pod.example/alice/settings/providers/secret.ttl',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['duplicate resource id', {
      resources: [
        {
          id: 'providerCredentials',
          url: 'https://pod.example/alice/settings/credentials.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        },
        {
          id: 'providerCredentials',
          url: 'https://pod.example/alice/settings/providers.ttl',
          mediaType: 'text/turtle',
          access: { read: true, append: true, write: true },
        },
      ],
    }],
  ])('rejects %s', (_name, patch) => {
    expect(() => parseAiConnectionsServiceAccess(descriptor(patch), CURRENT_POD_URL))
      .toThrow()
  })
})
