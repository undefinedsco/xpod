import { createAiConnectionsExtension, type AiConnectionsController } from '@undefineds.co/ai-connections';
import {
  mountApplet,
  type AppletModule,
  type MountedTwoPaneApplet,
  type WebExtensionHost,
} from '@undefineds.co/extension-sdk/web';
import { useMemo } from 'react';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { createServiceAccessGatewayFetch, createXpodAiClientConfigurationBridge } from '../api/ai-connections';
import { createServiceAccessPermissionCapability } from '../api/service-access-acp';
import type { XpodSolidRuntimeValue } from '../solid/XpodSolidRuntime';

const aiConnectionExtension = createAiConnectionsExtension();
const aiConnectionAppletId = aiConnectionExtension.manifest.contributes.applets[0]?.appId;
const discoveredAiConnectionsApplet = (aiConnectionAppletId
  ? aiConnectionExtension.applets[aiConnectionAppletId]
  : undefined) as AppletModule<SolidDatabase> | undefined;

if (!discoveredAiConnectionsApplet) {
  throw new Error('AI Connection extension did not contribute an applet');
}

const aiConnectionApplet = discoveredAiConnectionsApplet;

export function createXpodAiConnectionsHost(runtime: XpodSolidRuntimeValue): WebExtensionHost<SolidDatabase> {
  const pod = runtime.currentPod
    ? { status: 'ready' as const, current: runtime.currentPod }
    : runtime.state.status === 'authenticated'
      ? { status: 'opening' as const }
      : runtime.state.status === 'error'
        ? { status: 'error' as const, error: runtime.state.error }
        : { status: 'unavailable' as const };

  return {
    solid: {
      session: {
        getSnapshot: runtime.session.getSnapshot,
        subscribe: runtime.session.subscribe,
        fetch: runtime.currentPod
          ? createServiceAccessGatewayFetch({
            podUrl: runtime.currentPod.podUrl,
            authenticatedFetch: runtime.fetch,
          })
          : runtime.fetch,
      },
      pod,
      permissions: createServiceAccessPermissionCapability({
        authenticatedFetch: runtime.fetch,
        ownerWebId: runtime.webId,
      }),
      requireLogin: async () => runtime.login(window.location.origin),
    },
    navigation: {
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    capabilities: {
      aiClientConfiguration: runtime.currentPod &&
        runtime.aiClientConfiguration?.available === true &&
        runtime.aiClientConfiguration.authority === 'local-filesystem'
        ? createXpodAiClientConfigurationBridge({
          podUrl: runtime.currentPod.podUrl,
          authenticatedFetch: runtime.fetch,
        })
        : unsupportedAiClientConfiguration,
    },
  };
}

const unsupportedAiClientConfiguration = {
  inspect: async () => ({
    status: 'unavailable' as const,
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  }),
  plan: async () => {
    throw new Error('Host does not support local client configuration. Use the manual setup instructions for your client.');
  },
  apply: async () => {
    throw new Error('Host does not support local client configuration. Use the manual setup instructions for your client.');
  },
  verify: async () => ({
    status: 'unavailable' as const,
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  }),
  restore: async () => ({
    status: 'unavailable' as const,
    message: 'Host does not support local client configuration. Use the manual setup instructions for your client.',
  }),
};

export function useMountedAiConnectionsApplet(runtime: XpodSolidRuntimeValue): MountedTwoPaneApplet<AiConnectionsController> {
  const host = useMemo(() => createXpodAiConnectionsHost(runtime), [runtime]);
  return useMemo(() => {
    const mounted = mountApplet(aiConnectionApplet, host);
    if (mounted.layout !== 'two-pane') {
      throw new Error('AI Connection applet must use a two-pane layout');
    }
    return mounted as MountedTwoPaneApplet<AiConnectionsController>;
  }, [host]);
}
