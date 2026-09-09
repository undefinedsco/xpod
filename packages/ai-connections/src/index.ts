import type {
  WebExtensionModule,
} from '@undefineds.co/extension-sdk/web'
import { defineApplet } from '@undefineds.co/extension-sdk/web'
import type { AppletManifest } from '@undefineds.co/extension-sdk/manifest'
import { AiConnectionsList } from './AiConnectionsList'
import { AiConnectionsMain } from './AiConnectionsMain'
import { AiConnectionsHeader } from './AiConnectionsHeader'
import { AiConnectionsMainHeader } from './AiConnectionsMainHeader'
import {
  createAiConnectionsController,
  type AiConnectionsController,
} from './controller'
import { aiConnectionManifest } from './manifest'

export * from './ai-connections-client'
export * from './AiClientConfigurationSection'
export * from './AiConnectionsPanel'
export * from './AiGatewayKeysSection'
export * from './AiConnectionsList'
export * from './AiConnectionsMain'
export * from './AiConnectionsHeader'
export * from './AiConnectionsMainHeader'
export * from './AiCustomProviderDialog'
export * from './AiModelEditorDialog'
export * from './controller'
export * from './AiProviderCard'
export * from './AiCredentialPoolSection'
export * from './offering-label'
export * from './AiQuotaCard'
export * from './manifest'
export * from './service-access'

const appletManifest = aiConnectionManifest.contributes.applets[0]! as AppletManifest & { layout: 'two-pane' }

export const aiConnectionApplet = defineApplet<AiConnectionsController>({
  manifest: appletManifest,
  createController: createAiConnectionsController,
  activate(controller) {
    void controller.loadProviders()
  },
  slots: {
    listHeader: AiConnectionsHeader,
    list: AiConnectionsList,
    mainHeader: AiConnectionsMainHeader,
    main: AiConnectionsMain,
  },
})

export const aiConnectionExtension: WebExtensionModule = {
  manifest: aiConnectionManifest,
  applets: {
    [appletManifest.appId]: aiConnectionApplet,
  },
}

export function createAiConnectionsExtension(): WebExtensionModule {
  return aiConnectionExtension
}
