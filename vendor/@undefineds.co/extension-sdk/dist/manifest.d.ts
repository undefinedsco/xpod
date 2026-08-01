export declare const HOST_CAPABILITY_NAMES: readonly ["navigation.openExternal", "aiClientConfiguration"];
export type HostCapabilityName = (typeof HOST_CAPABILITY_NAMES)[number];
export type AppletLayoutKind = 'single-pane' | 'two-pane';
export interface AppletCommandDeclaration {
    id: string;
    title: string;
}
export interface AppletManifest {
    appId: string;
    name: string;
    entry: string;
    commands: AppletCommandDeclaration[];
    layout: AppletLayoutKind;
}
export interface ExtensionManifest {
    extensionId: string;
    name: string;
    version: string;
    sdkVersion: string;
    contributes: {
        applets: AppletManifest[];
    };
    dataModels: string[];
    hostCapabilities: HostCapabilityName[];
}
export declare function deriveAppletRouteId(manifest: Pick<AppletManifest, 'appId'>): string;
export declare function validateExtensionManifest(value: unknown): ExtensionManifest;
