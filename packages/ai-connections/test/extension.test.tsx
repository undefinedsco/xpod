import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { aiConnectionExtension, AiConnectionsPanel, type AiConnectionsClient } from '../src'

const WEB_ID = 'https://pod.example/alice/profile/card#me'

function client(): AiConnectionsClient {
  return {
    webId: WEB_ID,
    apiBase: 'https://pod.example',
    getServiceAccess: async () => ({ status: 'granted' }),
    listProviders: async () => [],
    listModels: async () => [],
    listGatewayKeys: async () => [],
    createGatewayKey: async () => {
      throw new Error('not used')
    },
    revokeGatewayKey: async () => undefined,
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
    quota: async () => {
      throw new Error('not used')
    },
  }
}

describe('AI Connection extension', () => {
  it('publishes one stable applet contribution', () => {
    expect(aiConnectionExtension.manifest.extensionId).toBe(
      'https://undefineds.co/extensions/ai-connections',
    )
    expect(aiConnectionExtension.manifest.contributes.applets).toHaveLength(1)
    expect(aiConnectionExtension.manifest.contributes.applets[0]?.appId).toBe(
      'https://undefineds.co/applets/ai-connections',
    )
  })

  it('can render its management panel without a LinX host', () => {
    const html = renderToStaticMarkup(<AiConnectionsPanel client={client()} />)
    expect(html).toContain('AI Connection')
    expect(html).not.toContain(WEB_ID)
    expect(html).toContain('OpenAI')
    expect(html).not.toContain('DeepSeek')
  })
})
