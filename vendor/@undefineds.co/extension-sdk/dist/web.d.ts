import type { OpenPodRuntime, SolidSessionRuntime } from '@undefineds.co/solid-sdk';
import { type ReactElement } from 'react';
import { type AppletLayoutType, SinglePaneAppletLayoutDescriptor, ThreePaneAppletLayoutDescriptor, TwoPaneAppletLayoutDescriptor } from './layout';
import type { AppletManifest, ExtensionManifest } from './manifest';
export { defineAppletLayout } from './layout';
export type { AppletLayoutDescriptor } from './layout';
export type WebExtensionSessionStatus = 'anonymous' | 'authenticating' | 'authenticated' | 'expired';
export type AiClientId = 'codex' | 'claude-code' | 'pi' | 'codebuddy';
export interface AiClientConfigurationStatus {
    status: 'notConfigured' | 'configured' | 'drifted' | 'unavailable' | 'unverifiable' | 'failedAndRestored';
    message?: string;
}
export interface AiClientConfigurationConfirmation {
    required: boolean;
    token: string;
    targetHash: string;
    message?: string;
}
export interface AiClientConfigurationPlan {
    planId: string;
    client: AiClientId;
    confirmation?: AiClientConfigurationConfirmation;
    changes: Array<{
        target: string;
        action: 'update' | 'createOrUpdate' | 'delete';
        backup: boolean;
    }>;
}
export interface AiClientConfigurationCapability {
    readonly available?: boolean;
    readonly authority?: 'local-filesystem';
    readonly manualInstructions?: string;
    inspect(client: AiClientId): Promise<AiClientConfigurationStatus>;
    plan(input: {
        client: AiClientId;
        endpoint: string;
    }): Promise<AiClientConfigurationPlan>;
    apply(input: {
        client: AiClientId;
        planId: string;
        gatewayKey: string;
        confirmation?: {
            token: string;
            targetHash: string;
        };
    }): Promise<{
        applied: true;
    }>;
    verify(input: {
        client: AiClientId;
        planId: string;
    }): Promise<AiClientConfigurationStatus>;
    restore(client: AiClientId): Promise<AiClientConfigurationStatus>;
}
export type WebExtensionSolidPodStatus = 'unavailable' | 'opening' | 'ready' | 'error';
export type WebExtensionSolidSession = Readonly<Pick<SolidSessionRuntime, 'fetch' | 'getSnapshot' | 'subscribe'>>;
export type WebExtensionSolidPod<Database = unknown> = {
    readonly status: 'unavailable';
} | {
    readonly status: 'opening';
} | {
    readonly status: 'ready';
    readonly current: OpenPodRuntime<Database>;
} | {
    readonly status: 'error';
    readonly error: Error;
};
export interface SolidAgentAccess {
    read?: boolean;
    append?: boolean;
    write?: boolean;
}
export interface SolidServiceAccessResource {
    id: string;
    url: string;
    mediaType: 'text/turtle';
    access: SolidAgentAccess;
}
export interface SolidServiceAccessRequest {
    appletId: string;
    service: {
        webId: string;
        label: string;
    };
    resources: SolidServiceAccessResource[];
}
export interface SolidServiceAccessStatus {
    status: 'granted' | 'missing' | 'permissionDenied' | 'capabilityUnavailable';
    resources: SolidServiceAccessResource[];
    message?: string;
}
export interface SolidPermissionCapability {
    inspectAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus>;
    ensureAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus>;
    revokeAgentAccess(request: SolidServiceAccessRequest): Promise<SolidServiceAccessStatus>;
}
export interface WebExtensionSolidCapability<Database = unknown> {
    readonly session: WebExtensionSolidSession;
    readonly pod: WebExtensionSolidPod<Database>;
    readonly permissions?: SolidPermissionCapability;
    requireLogin(): Promise<void>;
}
export interface WebExtensionNavigationCapability {
    openExternal(url: string): Promise<void>;
}
export interface WebExtensionHostCapabilities {
    aiClientConfiguration?: AiClientConfigurationCapability;
}
export interface WebExtensionHost<Database = unknown> {
    readonly solid: WebExtensionSolidCapability<Database>;
    readonly navigation: WebExtensionNavigationCapability;
    readonly capabilities: WebExtensionHostCapabilities;
}
export interface AppletSlotProps<TController, Database = unknown> {
    controller: TController;
    host: WebExtensionHost<Database>;
}
export type AppletSlot<TController, Database = unknown> = {
    bivarianceHack(props: AppletSlotProps<TController, Database>): ReactElement;
}['bivarianceHack'];
export interface AppletLifecycle<TController, Database = unknown> {
    createController(host: WebExtensionHost<Database>): TController;
    activate?(controller: TController, host: WebExtensionHost<Database>): void | (() => void);
}
export interface TwoPaneAppletModule<TController = unknown, Database = unknown> extends AppletLifecycle<TController, Database> {
    manifest: AppletManifest & {
        layout: 'two-pane';
    };
    slots: TwoPaneAppletSlots<TController, Database>;
}
export interface DescriptorTwoPaneAppletModule<TController = unknown, Database = unknown> extends AppletLifecycle<TController, Database> {
    manifest: AppletManifest & {
        layout: 'two-pane';
    };
    layout: {
        descriptor: TwoPaneAppletLayoutDescriptor;
        slots: TwoPaneAppletSlots<TController, Database>;
    };
}
export interface DescriptorSinglePaneAppletModule<TController = unknown, Database = unknown> extends AppletLifecycle<TController, Database> {
    manifest: AppletManifest & {
        layout: 'single-pane';
    };
    layout: {
        descriptor: SinglePaneAppletLayoutDescriptor;
        render: AppletSlot<TController, Database>;
    };
}
export interface DescriptorThreePaneAppletModule<TController = unknown, Database = unknown> extends AppletLifecycle<TController, Database> {
    manifest: Omit<AppletManifest, 'layout'> & {
        layout: 'three-pane';
    };
    layout: {
        descriptor: ThreePaneAppletLayoutDescriptor;
        slots: ThreePaneAppletSlots<TController, Database>;
    };
}
export type TwoPaneAppletSlots<TController, Database = unknown> = {
    header: AppletSlot<TController, Database>;
    list: AppletSlot<TController, Database>;
    main: AppletSlot<TController, Database>;
};
export type ThreePaneAppletSlots<TController, Database = unknown> = TwoPaneAppletSlots<TController, Database> & {
    context: AppletSlot<TController, Database>;
};
export interface MountedTwoPaneApplet<TController> {
    layout: 'two-pane';
    controller: TController;
    slots: {
        header: ReactElement;
        list: ReactElement;
        main: ReactElement;
    };
}
export interface MountedSinglePaneApplet<TController> {
    layout: 'single-pane';
    controller: TController;
    element: ReactElement;
}
export interface MountedThreePaneApplet<TController> {
    layout: 'three-pane';
    controller: TController;
    contextConfig?: ThreePaneAppletLayoutDescriptor['context'];
    slots: {
        header: ReactElement;
        list: ReactElement;
        main: ReactElement;
        context: ReactElement;
    };
}
export type MountedApplet<TController = unknown> = MountedTwoPaneApplet<TController> | MountedSinglePaneApplet<TController> | MountedThreePaneApplet<TController>;
export declare function defineApplet<TController, Database = unknown>(applet: TwoPaneAppletModule<TController, Database>): TwoPaneAppletModule<TController, Database>;
export declare function defineApplet<TController, Database = unknown>(applet: SinglePaneAppletModule<TController, Database>): SinglePaneAppletModule<TController, Database>;
export declare function defineApplet<TController, Database = unknown>(applet: DescriptorTwoPaneAppletModule<TController, Database>): DescriptorTwoPaneAppletModule<TController, Database>;
export declare function defineApplet<TController, Database = unknown>(applet: DescriptorSinglePaneAppletModule<TController, Database>): DescriptorSinglePaneAppletModule<TController, Database>;
export declare function defineApplet<TController, Database = unknown>(applet: DescriptorThreePaneAppletModule<TController, Database>): DescriptorThreePaneAppletModule<TController, Database>;
export declare function mountTwoPaneApplet<TController, Database = unknown>(applet: TwoPaneAppletModule<TController, Database> | DescriptorTwoPaneAppletModule<TController, Database>, host: WebExtensionHost<Database>): Omit<MountedTwoPaneApplet<TController>, 'layout'>['slots'] & {
    controller: TController;
};
export interface SinglePaneAppletModule<TController = unknown, Database = unknown> extends AppletLifecycle<TController, Database> {
    manifest: AppletManifest & {
        layout: 'single-pane';
    };
    render: AppletSlot<TController, Database>;
}
export type AppletModule<Database = unknown> = SinglePaneAppletModule<unknown, Database> | TwoPaneAppletModule<unknown, Database> | DescriptorSinglePaneAppletModule<unknown, Database> | DescriptorTwoPaneAppletModule<unknown, Database> | DescriptorThreePaneAppletModule<unknown, Database>;
export type WebExtensionAppletManifest = Omit<AppletManifest, 'layout'> & {
    layout: AppletLayoutType;
};
export interface WebExtensionManifest extends Omit<ExtensionManifest, 'contributes'> {
    contributes: Omit<ExtensionManifest['contributes'], 'applets'> & {
        applets: WebExtensionAppletManifest[];
    };
}
export declare function mountApplet<TController, Database = unknown>(applet: TwoPaneAppletModule<TController, Database> | DescriptorTwoPaneAppletModule<TController, Database>, host: WebExtensionHost<Database>): MountedTwoPaneApplet<TController>;
export declare function mountApplet<TController, Database = unknown>(applet: SinglePaneAppletModule<TController, Database> | DescriptorSinglePaneAppletModule<TController, Database>, host: WebExtensionHost<Database>): MountedSinglePaneApplet<TController>;
export declare function mountApplet<TController, Database = unknown>(applet: DescriptorThreePaneAppletModule<TController, Database>, host: WebExtensionHost<Database>): MountedThreePaneApplet<TController>;
export declare function mountApplet<TController, Database = unknown>(applet: SinglePaneAppletModule<TController, Database> | TwoPaneAppletModule<TController, Database> | DescriptorSinglePaneAppletModule<TController, Database> | DescriptorTwoPaneAppletModule<TController, Database> | DescriptorThreePaneAppletModule<TController, Database>, host: WebExtensionHost<Database>): MountedApplet<TController>;
export interface WebExtensionModule<Database = unknown> {
    manifest: WebExtensionManifest;
    applets: Record<string, AppletModule<Database>>;
}
