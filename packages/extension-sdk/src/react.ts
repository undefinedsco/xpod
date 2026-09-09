import { useEffect, useMemo } from 'react';
import {
  mountApplet,
  type DescriptorSinglePaneAppletModule,
  type DescriptorThreePaneAppletModule,
  type DescriptorTwoPaneAppletModule,
  type MountedThreePaneApplet,
  type MountedSinglePaneApplet,
  type MountedTwoPaneApplet,
  type SinglePaneAppletModule,
  type TwoPaneAppletModule,
  type WebExtensionHost,
} from './web';

export type {
  LoginEndpointDescriptor,
  RememberedWebIdLogin,
  StorageBinding,
  StorageSelectionState,
  WebIdAuthState,
  WebIdLoginActions,
  WebIdLoginRouteDescriptor,
  WebIdLoginTransaction,
} from '@undefineds.co/solid-sdk';

export * from './react/layout-context';
export * from './react/app-layout';
export * from './react/workspace-layout';
export * from './react/solid-auth-boundary';

export interface UseAppletOptions {
  enabled?: boolean;
}

export function useApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
  options?: UseAppletOptions,
): MountedTwoPaneApplet<TController> | null;

export function useApplet<TController, Database = unknown>(
  applet:
    | SinglePaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
  options?: UseAppletOptions,
): MountedSinglePaneApplet<TController> | null;

export function useApplet<TController, Database = unknown>(
  applet: DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
  options?: UseAppletOptions,
): MountedThreePaneApplet<TController> | null;

export function useApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | SinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
  options?: UseAppletOptions,
): MountedTwoPaneApplet<TController> | MountedSinglePaneApplet<TController> | MountedThreePaneApplet<TController> | null;

export function useApplet<TController, Database = unknown>(
  applet:
    | TwoPaneAppletModule<TController, Database>
    | SinglePaneAppletModule<TController, Database>
    | DescriptorTwoPaneAppletModule<TController, Database>
    | DescriptorSinglePaneAppletModule<TController, Database>
    | DescriptorThreePaneAppletModule<TController, Database>,
  host: WebExtensionHost<Database>,
  options: UseAppletOptions = {},
): MountedTwoPaneApplet<TController> | MountedSinglePaneApplet<TController> | MountedThreePaneApplet<TController> | null {
  const enabled = options.enabled ?? true;
  const mounted = useMemo(
    () => enabled
      ? mountApplet(applet, host)
      : null,
    [applet, enabled, host],
  );

  useEffect(() => {
    if (!mounted) {
      return undefined;
    }

    return applet.activate?.(mounted.controller, host);
  }, [applet, host, mounted]);

  return mounted;
}
