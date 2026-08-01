import type {
  WebExtensionModule,
} from '@undefineds.co/extension-sdk/web'
import { defineApplet } from '@undefineds.co/extension-sdk/web'
import type { AppletManifest } from '@undefineds.co/extension-sdk/manifest'
import { AiConnectionList } from './AiConnectionList'
import { AiConnectionMain } from './AiConnectionMain'
import { AiConnectionHeader } from './AiConnectionHeader'
import { AiConnectionMainHeader } from './AiConnectionMainHeader'
import {
  createAiConnectionController,
  type AiConnectionController,
} from './controller'
import { aiConnectionManifest } from './manifest'

export * from './ai-connection-client'
export * from './AiClientConfigurationSection'
export * from './AiConnectionPanel'
export * from './AiConnectionList'
export * from './AiConnectionMain'
export * from './AiConnectionHeader'
export * from './AiConnectionMainHeader'
export * from './controller'
export * from './AiProviderCard'
export * from './AiQuotaCard'
export * from './manifest'

const appletManifest = aiConnectionManifest.contributes.applets[0]! as AppletManifest & { layout: 'two-pane' }

export const aiConnectionApplet = defineApplet<AiConnectionController>({
  manifest: appletManifest,
  createController: createAiConnectionController,
  activate(controller) {
    void controller.ensureServiceAccess()
  },
  slots: {
    listHeader: AiConnectionHeader,
    list: AiConnectionList,
    mainHeader: AiConnectionMainHeader,
    main: AiConnectionMain,
  },
})

export const aiConnectionExtension: WebExtensionModule = {
  manifest: aiConnectionManifest,
  applets: {
    [appletManifest.appId]: aiConnectionApplet,
  },
}

export function createAiConnectionExtension(): WebExtensionModule {
  return aiConnectionExtension
}
