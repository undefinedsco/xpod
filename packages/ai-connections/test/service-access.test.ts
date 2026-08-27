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

  it('accepts providerDefinitions only as a member container', () => {
    const value = descriptor({
      resources: [{
        id: 'providerDefinitions',
        url: 'https://pod.example/alice/settings/providers/',
        mediaType: 'text/turtle',
        members: true,
        access: { read: true, append: true, write: true },
      }],
    })

    expect(parseAiConnectionsServiceAccess(value, CURRENT_POD_URL).resources[0]?.members).toBe(true)
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
    ['providerDefinitions without members', {
      resources: [{
        id: 'providerDefinitions',
        url: 'https://pod.example/alice/settings/providers/',
        mediaType: 'text/turtle',
        access: { read: true, append: true, write: true },
      }],
    }],
    ['non-container resource declaring members', {
      resources: [{
        id: 'providerCredentials',
        url: 'https://pod.example/alice/settings/credentials.ttl',
        mediaType: 'text/turtle',
        members: true,
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
