import { validateExtensionManifest } from '@undefineds.co/extension-sdk/manifest'

export const aiConnectionManifest = validateExtensionManifest({
  extensionId: 'https://undefineds.co/extensions/ai-connection',
  name: 'AI Connection',
  version: '0.1.0',
  sdkVersion: '1',
  contributes: {
    applets: [{
      appId: 'https://undefineds.co/applets/ai-connection',
      name: 'AI Connection',
      entry: '.',
      commands: [],
      layout: 'two-pane',
    }],
  },
  dataModels: [],
  hostCapabilities: ['navigation.openExternal', 'aiClientConfiguration'],
})
