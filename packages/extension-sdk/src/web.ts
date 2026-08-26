import type { OpenPodRuntime, SolidSessionRuntime } from '@undefineds.co/solid-sdk';
import { createElement, type ReactElement } from 'react';
import {
  defineAppletLayout as validateAppletLayout,
  type AppletLayoutType,
  AppletLayoutDescriptor,
  SinglePaneAppletLayoutDescriptor,
  ThreePaneAppletLayoutDescriptor,
  TwoPaneAppletLayoutDescriptor,
} from './layout';
import type { AppletManifest, ExtensionManifest } from './manifest';

export { defineAppletLayout } from './layout';
export type { AppletLayoutDescriptor } from './layout';

const validateRawAppletLayout = validateAppletLayout as (descriptor: unknown) => AppletLayoutDescriptor;

export type WebExtensionSessionStatus =
  | 'anonymous'
  | 'authenticating'
  | 'authenticated'
  | 'expired';

export type WebExtensionSolidPodStatus =
  | 'unavailable'
  | 'opening'
  | 'ready'
  | 'error';

export type WebExtensionSolidSession = Readonly<Pick<
  SolidSessionRuntime,
  'fetch' | 'getSnapshot' | 'subscribe'
>>;

export type WebExtensionSolidPod<Database = unknown> =
  | {
    readonly status: 'unavailable';
  }
  | {
    readonly status: 'opening';
  }
  | {
    readonly status: 'ready';
    readonly current: OpenPodRuntime<Database>;
  }
  | {
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
  service: { webId: string; label: string };
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

export interface WebExtensionHostCapabilities {}

export interface WebExtensionHost<Database = unknown> {
  readonly solid: WebExtensionSolidCapability<Database>;
  readonly navigation: WebExtensionNavigationCapability;
  readonly capabilities: WebExtensionHostCapabilities;
}

export interface AppletSlotProps<TController, Database = unknown> {
  controller: TController;
  host: WebExtensionHost<Database>;
}

export type AppletSlot<TController, Database = unknown> =
  {
    bivarianceHack(props: AppletSlotProps<TController, Database>): ReactElement;
  }['bivarianceHack'];

export interface AppletLifecycle<TController, Database = unknown> {
  createController(host: WebExtensionHost<Database>): TController;
  activate?(
    controller: TController,
    host: WebExtensionHost<Database>,
  ): void | (() => void);
}

export interface TwoPaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'two-pane' };
  slots: TwoPaneAppletSlots<TController, Database>;
}

export interface DescriptorTwoPaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'two-pane' };
  layout: {
    descriptor: TwoPaneAppletLayoutDescriptor;
    slots: TwoPaneAppletSlots<TController, Database>;
  };
}

export interface DescriptorSinglePaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'single-pane' };
  layout: {
    descriptor: SinglePaneAppletLayoutDescriptor;
    render: AppletSlot<TController, Database>;
  };
}

export interface DescriptorThreePaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: Omit<AppletManifest, 'layout'> & { layout: 'three-pane' };
  layout: {
    descriptor: ThreePaneAppletLayoutDescriptor;
    slots: ThreePaneAppletSlots<TController, Database>;
  };
}

export type TwoPaneAppletSlots<TController, Database = unknown> = {
  listHeader: AppletSlot<TController, Database>;
  list: AppletSlot<TController, Database>;
  mainHeader: AppletSlot<TController, Database>;
  main: AppletSlot<TController, Database>;
};

export type ThreePaneAppletSlots<TController, Database = unknown> =
  TwoPaneAppletSlots<TController, Database> & {
    context: AppletSlot<TController, Database>;
  };

export interface MountedTwoPaneApplet<TController> {
  layout: 'two-pane';
  controller: TController;
  slots: {
    listHeader: ReactElement;
    list: ReactElement;
    mainHeader: ReactElement;
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
    listHeader: ReactElement;
    list: ReactElement;
    mainHeader: ReactElement;
    main: ReactElement;
    context: ReactElement;
  };
}

export type MountedApplet<TController = unknown> =
  | MountedTwoPaneApplet<TController>
  | MountedSinglePaneApplet<TController>
  | MountedThreePaneApplet<TController>;

export function defineApplet<TController, Database = unknown>(
  applet: TwoPaneAppletModule<TController, Database>,
): TwoPaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: SinglePaneAppletModule<TController, Database>,
): SinglePaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: DescriptorTwoPaneAppletModule<TController, Database>,
): DescriptorTwoPaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: DescriptorSinglePaneAppletModule<TController, Database>,
): DescriptorSinglePaneAppletModule<TController, Database>;

export function defineApplet<TController, Database = unknown>(
  applet: DescriptorThreePaneAppletModule<TController, Database>,
): DescriptorThreePaneAppletModule<TController, Database>;

export function defineApplet(
  applet: AppletModule,
): AppletModule {
  return applet;
}

export function mountTwoPaneApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): Omit<MountedTwoPaneApplet<TController>, 'layout'>['slots'] & { controller: TController } {
  const mounted = mountResolvedApplet(applet, host);
  if (mounted.layout !== 'two-pane') {
    throw new Error(`Applet manifest declares ${applet.manifest.layout} but no two-pane slots were provided`);
  }

  return {
    controller: mounted.controller,
    listHeader: mounted.slots.listHeader,
    list: mounted.slots.list,
    mainHeader: mounted.slots.mainHeader,
    main: mounted.slots.main,
  };
}

export interface SinglePaneAppletModule<TController = unknown, Database = unknown>
  extends AppletLifecycle<TController, Database> {
  manifest: AppletManifest & { layout: 'single-pane' };
  render: AppletSlot<TController, Database>;
}

export type AppletModule<Database = unknown> =
  | SinglePaneAppletModule<unknown, Database>
  | TwoPaneAppletModule<unknown, Database>
  | DescriptorSinglePaneAppletModule<unknown, Database>
  | DescriptorTwoPaneAppletModule<unknown, Database>
  | DescriptorThreePaneAppletModule<unknown, Database>;

export type WebExtensionAppletManifest =
  Omit<AppletManifest, 'layout'> & { layout: AppletLayoutType };

export interface WebExtensionManifest extends Omit<ExtensionManifest, 'contributes'> {
  contributes: Omit<ExtensionManifest['contributes'], 'applets'> & {
    applets: WebExtensionAppletManifest[];
  };
}

export function mountApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedTwoPaneApplet<TController>;

export function mountApplet<TController, Database = unknown>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedSinglePaneApplet<TController>;

export function mountApplet<TController, Database = unknown>(
  applet: DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedThreePaneApplet<TController>;

export function mountApplet<TController, Database = unknown>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | TwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedApplet<TController>;

export function mountApplet(
  applet: AppletModule,
  host: WebExtensionHost,
): MountedApplet {
  return mountResolvedApplet(applet, host);
}

function mountResolvedApplet<TController, Database>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | TwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
): MountedApplet<TController> {
  const layout = resolveAppletLayout(applet);
  const controller = applet.createController(host);

  if (layout.type === 'single-pane') {
    return {
      layout: 'single-pane',
      controller,
      element: createElement(layout.render, { controller, host }),
    };
  }

  if (layout.type === 'two-pane') {
    return {
      layout: 'two-pane',
      controller,
      slots: {
        listHeader: createElement(layout.slots.listHeader, { controller, host }),
        list: createElement(layout.slots.list, { controller, host }),
        mainHeader: createElement(layout.slots.mainHeader, { controller, host }),
        main: createElement(layout.slots.main, { controller, host }),
      },
    };
  }

  return {
    layout: 'three-pane',
    controller,
    contextConfig: layout.contextConfig,
    slots: {
      listHeader: createElement(layout.slots.listHeader, { controller, host }),
      list: createElement(layout.slots.list, { controller, host }),
      mainHeader: createElement(layout.slots.mainHeader, { controller, host }),
      main: createElement(layout.slots.main, { controller, host }),
      context: createElement(layout.slots.context, { controller, host }),
    },
  };
}

type ResolvedAppletLayout<TController, Database> =
  | {
    type: 'single-pane';
    render: AppletSlot<TController, Database>;
  }
  | {
    type: 'two-pane';
    slots: TwoPaneAppletSlots<TController, Database>;
  }
  | {
    type: 'three-pane';
    contextConfig?: ThreePaneAppletLayoutDescriptor['context'];
    slots: ThreePaneAppletSlots<TController, Database>;
  };

function resolveAppletLayout<TController, Database>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | TwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
): ResolvedAppletLayout<TController, Database> {
  if ('layout' in applet) {
    const descriptorLayout = requireDescriptorLayout(applet.layout);
    const descriptor = validateRawAppletLayout(descriptorLayout.descriptor);
    const descriptorType = descriptor.type;
    if (applet.manifest.layout !== descriptorType) {
      throw new Error(
        `Applet manifest layout ${applet.manifest.layout} does not match descriptor layout ${descriptorType}`,
      );
    }

    if (descriptorType === 'single-pane') {
      if (!('render' in descriptorLayout)) {
        throw new Error('Applet descriptor single-pane render must be a function');
      }
      assertSlotFunction(descriptorLayout.render, 'Applet descriptor single-pane render');
      return {
        type: 'single-pane',
        render: descriptorLayout.render as AppletSlot<TController, Database>,
      };
    }

    if (!('slots' in descriptorLayout)) {
      throw new Error(`Applet descriptor declares ${descriptorType} but no slots were provided`);
    }

    if (descriptorType === 'two-pane') {
      assertTwoPaneSlots(descriptorLayout.slots, 'Applet descriptor two-pane');
      return {
        type: 'two-pane',
        slots: descriptorLayout.slots as TwoPaneAppletSlots<TController, Database>,
      };
    }

    assertThreePaneSlots(descriptorLayout.slots, 'Applet descriptor three-pane');

    return {
      type: 'three-pane',
      contextConfig: descriptor.context,
      slots: descriptorLayout.slots as ThreePaneAppletSlots<TController, Database>,
    };
  }

  if (applet.manifest.layout === 'single-pane') {
    if (!('render' in applet)) {
      throw new Error('Applet manifest declares single-pane but no single-pane renderer was provided');
    }
    assertSlotFunction(applet.render, 'Applet single-pane render');
    return {
      type: 'single-pane',
      render: applet.render,
    };
  }

  if (applet.manifest.layout === 'two-pane' && 'slots' in applet) {
    assertTwoPaneSlots(applet.slots, 'Applet two-pane');
    return {
      type: 'two-pane',
      slots: applet.slots,
    };
  }

  throw new Error(`Applet manifest declares ${applet.manifest.layout} but no supported applet layout was provided`);
}

function assertTwoPaneSlots<TController, Database>(
  slots: unknown,
  label: string,
): asserts slots is TwoPaneAppletSlots<TController, Database> {
  assertSlotContainer(slots, label);
  assertSlotFunction(slots.listHeader, `${label} slot listHeader`);
  assertSlotFunction(slots.list, `${label} slot list`);
  assertSlotFunction(slots.mainHeader, `${label} slot mainHeader`);
  assertSlotFunction(slots.main, `${label} slot main`);
}

function assertThreePaneSlots<TController, Database>(
  slots: unknown,
  label: string,
): asserts slots is ThreePaneAppletSlots<TController, Database> {
  assertTwoPaneSlots(slots, label);
  assertSlotFunction((slots as Record<string, unknown>).context, `${label} slot context`);
}

function assertSlotContainer(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} slots must be an object`);
  }
}

function assertSlotFunction(
  value: unknown,
  label: string,
): asserts value is AppletSlot<unknown> {
  if (typeof value !== 'function') {
    throw new Error(`${label} must be a function`);
  }
}

function requireDescriptorLayout(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Applet descriptor layout must be an object');
  }
  if (!('descriptor' in value) || value.descriptor === undefined) {
    throw new Error('Applet descriptor required');
  }
  return value;
}

export interface WebExtensionModule<Database = unknown> {
  manifest: WebExtensionManifest;
  applets: Record<string, AppletModule<Database>>;
}
