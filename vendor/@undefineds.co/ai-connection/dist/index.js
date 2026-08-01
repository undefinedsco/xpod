import { defineApplet } from '@undefineds.co/extension-sdk/web';
import { AiConnectionList } from './AiConnectionList.js';
import { AiConnectionMain } from './AiConnectionMain.js';
import { AiConnectionHeader } from './AiConnectionHeader.js';
import { createAiConnectionController, } from './controller.js';
import { aiConnectionManifest } from './manifest.js';
export * from './ai-connection-client.js';
export * from './AiClientConfigurationSection.js';
export * from './AiConnectionPanel.js';
export * from './AiConnectionList.js';
export * from './AiConnectionMain.js';
export * from './AiConnectionHeader.js';
export * from './controller.js';
export * from './AiProviderCard.js';
export * from './AiQuotaCard.js';
export * from './manifest.js';
const appletManifest = aiConnectionManifest.contributes.applets[0];
export const aiConnectionApplet = defineApplet({
    manifest: appletManifest,
    createController: createAiConnectionController,
    activate(controller) {
        void controller.ensureServiceAccess();
    },
    slots: {
        header: AiConnectionHeader,
        list: AiConnectionList,
        main: AiConnectionMain,
    },
});
export const aiConnectionExtension = {
    manifest: aiConnectionManifest,
    applets: {
        [appletManifest.appId]: aiConnectionApplet,
    },
};
export function createAiConnectionExtension() {
    return aiConnectionExtension;
}
