import type { WebExtensionHost, WebExtensionSolidCapability } from './web';
export interface MockWebExtensionHostOverrides {
    solid?: WebExtensionSolidCapability;
    navigation?: Partial<WebExtensionHost['navigation']>;
    capabilities?: WebExtensionHost['capabilities'];
}
export declare function createMockWebExtensionHost(overrides?: MockWebExtensionHostOverrides): WebExtensionHost;
